"use client";

import { useEffect, useRef, useState } from "react";
import {
  base64ToBytes,
  buildAgentWsUrl,
  type DisplayControlState,
  parseInbound,
  spawnWsSubprotocols,
} from "@/lib/ws";

/**
 * Lifecycle hook for the per-agent browser WS.
 *
 * Manages connect, reconnect (linear backoff up to 10s), and surface state
 * via callbacks.  The caller is responsible for actually wiring `onData` to
 * the xterm.js instance (we keep this hook framework-agnostic so it could
 * also feed a transcript view).
 */
export interface UseAgentSocketOptions {
  agentId: string;
  enabled?: boolean;
  initialSize?: { cols: number; rows: number } | null;
  /** dcOffsetAfter is the cumulative DataChannel byte count including this
   *  chunk; undefined for bytes that arrived over the WS relay. */
  onData: (bytes: Uint8Array, dcOffsetAfter?: number) => void;
  onHistory?: (bytes: Uint8Array) => void;
  onDisplayControl?: (state: DisplayControlState) => void;
  onExit?: (exitCode: number | null, signal: string | null) => void;
  onStatus?: (status: string) => void;
  /** dcOffset is the daemon-side DataChannel byte count at capture time for
   *  the CURRENT rtc session, or null when the snapshot has no usable anchor
   *  (relay mode, stale session). */
  onSnapshot?: (bytes: Uint8Array, plain: boolean, dcOffset?: number | null) => void;
  onUploadSaved?: (path: string, clientId?: string) => void;
  onUploadError?: (message: string) => void;
}

export type SocketState = "idle" | "connecting" | "open" | "closed" | "error";

type RtcState = {
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  sessionId: string | null;
  open: boolean;
  /** Cumulative PTY bytes received over this session's DataChannel. */
  bytesReceived: number;
};

const RTC_CONNECT_TIMEOUT_MS = 10_000;
const RTC_DISCONNECTED_GRACE_MS = 5_000;
const RTC_RELAY_DUPLICATE_WINDOW_MS = 2_000;
const RTC_RELAY_FALLBACK_DELAY_MS = 750;
// A failed WebRTC attempt used to strand the session on the relay path until
// the next WS reconnect; retry with backoff instead.
const RTC_RETRY_BASE_DELAY_MS = 5_000;
const RTC_RETRY_MAX_DELAY_MS = 60_000;
// On spawn.v2 there is no relay to fall back to; keystrokes typed before the
// DataChannel opens are held briefly and flushed on open. Cap the buffer so a
// dead channel can't grow it without bound.
const MAX_PENDING_INPUT_BYTES = 64 * 1024;

function newRtcSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

export function useAgentSocket({
  agentId,
  enabled = true,
  initialSize = null,
  onData,
  onHistory,
  onDisplayControl,
  onExit,
  onStatus,
  onSnapshot,
  onUploadSaved,
  onUploadError,
}: UseAgentSocketOptions) {
  const [state, setState] = useState<SocketState>("idle");
  // True when the negotiated subprotocol is spawn.v2 (DataChannel-only PTY).
  const [v2, setV2] = useState(false);
  // True while the spawn.pty DataChannel is open — on v2 this IS the live
  // terminal path, so callers surface it as connection state.
  const [dcOpen, setDcOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const wsV2Ref = useRef(false);
  const pendingInputRef = useRef<Uint8Array[]>([]);
  const pendingInputBytesRef = useRef(0);
  const rtcRef = useRef<RtcState>({
    pc: null,
    dc: null,
    sessionId: null,
    open: false,
    bytesReceived: 0,
  });
  const pendingRemoteRtcCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const initialSizeRef = useRef(initialSize);
  const handlersRef = useRef({
    onData,
    onHistory,
    onDisplayControl,
    onExit,
    onStatus,
    onSnapshot,
    onUploadSaved,
    onUploadError,
  });
  initialSizeRef.current = initialSize;
  handlersRef.current = {
    onData,
    onHistory,
    onDisplayControl,
    onExit,
    onStatus,
    onSnapshot,
    onUploadSaved,
    onUploadError,
  };

  useEffect(() => {
    if (!enabled || !agentId) return;
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcStartInFlight = false;
    let rtcConnectTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcDisconnectedTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcRelayFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcRetryAttempts = 0;
    let lastRtcIceServers: RTCIceServer[] | null = null;
    let lastRtcDataAt = 0;
    const pendingRelayChunks: Uint8Array[] = [];

    const sendJsonOverWs = (msg: unknown) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    };

    const clearRtcConnectTimer = () => {
      if (rtcConnectTimer) clearTimeout(rtcConnectTimer);
      rtcConnectTimer = null;
    };

    const clearRtcDisconnectedTimer = () => {
      if (rtcDisconnectedTimer) clearTimeout(rtcDisconnectedTimer);
      rtcDisconnectedTimer = null;
    };

    const clearRelayFallback = () => {
      if (rtcRelayFallbackTimer) clearTimeout(rtcRelayFallbackTimer);
      rtcRelayFallbackTimer = null;
      pendingRelayChunks.splice(0);
    };

    const cleanupRtc = (signal = true, retry = false) => {
      const rtc = rtcRef.current;
      const sessionId = rtc.sessionId;
      clearRtcConnectTimer();
      clearRtcDisconnectedTimer();
      clearRelayFallback();
      if (signal && sessionId) {
        sendJsonOverWs({ type: "rtc.close", session_id: sessionId });
      }
      try {
        rtc.dc?.close();
      } catch {
        // ignore
      }
      try {
        rtc.pc?.close();
      } catch {
        // ignore
      }
      rtcRef.current = { pc: null, dc: null, sessionId: null, open: false, bytesReceived: 0 };
      pendingRemoteRtcCandidatesRef.current = [];
      rtcStartInFlight = false;
      lastRtcDataAt = 0;
      setDcOpen(false);
      if (retry) scheduleRtcRetry();
    };

    // A transient WebRTC failure (network switch, slow ICE) must not strand
    // the session on the relay path until the next WS reconnect.
    const scheduleRtcRetry = () => {
      if (cancelled || rtcRetryTimer || !lastRtcIceServers) return;
      const delay = Math.min(
        RTC_RETRY_MAX_DELAY_MS,
        RTC_RETRY_BASE_DELAY_MS * 2 ** rtcRetryAttempts,
      );
      rtcRetryAttempts += 1;
      rtcRetryTimer = setTimeout(() => {
        rtcRetryTimer = null;
        if (cancelled || rtcRef.current.pc) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        if (lastRtcIceServers) void startRtc(lastRtcIceServers);
      }, delay);
    };

    const scheduleRelayFallback = (bytes: Uint8Array) => {
      pendingRelayChunks.push(bytes);
      if (rtcRelayFallbackTimer) return;
      rtcRelayFallbackTimer = setTimeout(() => {
        rtcRelayFallbackTimer = null;
        const chunks = pendingRelayChunks.splice(0);
        cleanupRtc(true, true);
        for (const chunk of chunks) {
          handlersRef.current.onData(chunk);
        }
      }, RTC_RELAY_FALLBACK_DELAY_MS);
    };

    const startRtc = async (iceServers: RTCIceServer[]) => {
      if (cancelled || rtcStartInFlight || rtcRef.current.pc) return;
      if (typeof RTCPeerConnection === "undefined") return;
      rtcStartInFlight = true;
      const sessionId = newRtcSessionId();
      // Debug/acceptance hook: force TURN-relay-only ICE to prove sessions
      // survive networks where no direct path exists (docs/TRUST.md Phase 1).
      const forceRelay =
        typeof window !== "undefined" &&
        (window as { __spawnRtcForceRelay?: boolean }).__spawnRtcForceRelay === true;
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: forceRelay ? "relay" : "all",
      });
      const dc = pc.createDataChannel("spawn.pty", { ordered: true });
      const pendingLocalCandidates: RTCIceCandidateInit[] = [];
      let offerSent = false;
      dc.binaryType = "arraybuffer";
      rtcRef.current = { pc, dc, sessionId, open: false, bytesReceived: 0 };
      rtcConnectTimer = setTimeout(() => {
        if (rtcRef.current.sessionId === sessionId && !rtcRef.current.open) {
          cleanupRtc(true, true);
        }
      }, RTC_CONNECT_TIMEOUT_MS);

      const sendRtcCandidate = (candidate: RTCIceCandidateInit) =>
        sendJsonOverWs({
          type: "rtc.candidate",
          session_id: sessionId,
          candidate,
        });

      pc.onicecandidate = (event) => {
        if (!event.candidate || cancelled) return;
        const candidate = event.candidate.toJSON();
        if (offerSent) {
          sendRtcCandidate(candidate);
        } else {
          pendingLocalCandidates.push(candidate);
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          clearRtcDisconnectedTimer();
          return;
        }
        if (pc.connectionState === "disconnected") {
          if (!rtcDisconnectedTimer) {
            rtcDisconnectedTimer = setTimeout(() => {
              if (rtcRef.current.sessionId === sessionId && pc.connectionState === "disconnected") {
                cleanupRtc(true, true);
              }
            }, RTC_DISCONNECTED_GRACE_MS);
          }
          return;
        }
        if (["failed", "closed"].includes(pc.connectionState)) {
          cleanupRtc(pc.connectionState !== "closed", rtcRef.current.sessionId === sessionId);
        }
      };
      dc.onopen = () => {
        const current = rtcRef.current;
        if (current.sessionId === sessionId) {
          rtcRef.current = { ...current, open: true };
          clearRtcConnectTimer();
          rtcRetryAttempts = 0;
          // The daemon starts mirroring PTY bytes onto this channel from its
          // side of the open handshake; treat relay copies that race the
          // first DataChannel byte as duplicates from the start.
          lastRtcDataAt = Date.now();
          setDcOpen(true);
          // Flush keystrokes typed before the channel came up (v2 has no
          // relay to carry them). Order is preserved: this runs before any
          // subsequent sendBinary can see the channel as open.
          const queued = pendingInputRef.current.splice(0);
          pendingInputBytesRef.current = 0;
          for (const chunk of queued) {
            try {
              dc.send(
                chunk.buffer.slice(
                  chunk.byteOffset,
                  chunk.byteOffset + chunk.byteLength,
                ) as ArrayBuffer,
              );
            } catch {
              break;
            }
          }
        }
      };
      dc.onclose = () => {
        const current = rtcRef.current;
        if (current.sessionId === sessionId) {
          rtcRef.current = { ...current, open: false };
          setDcOpen(false);
        }
      };
      dc.onerror = () => {
        cleanupRtc(true, true);
      };
      const deliverDcChunk = (bytes: Uint8Array) => {
        const h = handlersRef.current;
        const current = rtcRef.current;
        if (current.sessionId === sessionId) {
          current.bytesReceived += bytes.length;
          h.onData(bytes, current.bytesReceived);
        } else {
          h.onData(bytes);
        }
      };
      dc.onmessage = (event) => {
        lastRtcDataAt = Date.now();
        clearRelayFallback();
        if (event.data instanceof ArrayBuffer) {
          deliverDcChunk(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buf) => {
            if (!cancelled) deliverDcChunk(new Uint8Array(buf));
          });
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (cancelled || rtcRef.current.sessionId !== sessionId) return;
        if (!sendJsonOverWs({ type: "rtc.offer", session_id: sessionId, sdp: offer.sdp })) {
          cleanupRtc(false);
          return;
        }
        offerSent = true;
        for (const candidate of pendingLocalCandidates.splice(0)) {
          sendRtcCandidate(candidate);
        }
      } catch {
        cleanupRtc();
      } finally {
        rtcStartInFlight = false;
      }
    };

    const connect = () => {
      if (cancelled) return;
      setState("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(buildAgentWsUrl(agentId, initialSizeRef.current), spawnWsSubprotocols());
      } catch {
        setState("error");
        scheduleReconnect();
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        // The selected subprotocol decides the data plane: v2 servers never
        // relay PTY bytes, so the DataChannel is the only live path.
        wsV2Ref.current = ws.protocol === "spawn.v2";
        setV2(wsV2Ref.current);
        setState("open");
      };
      ws.onmessage = (ev) => {
        const h = handlersRef.current;
        if (typeof ev.data === "string") {
          const msg = parseInbound(ev.data);
          if (!msg) return;
          if (msg.type === "history") {
            const bytes = base64ToBytes(msg.bytes_b64);
            if (h.onHistory) h.onHistory(bytes);
            else h.onData(bytes);
          } else if (msg.type === "display.control") {
            h.onDisplayControl?.({
              owner: msg.owner,
              cols: msg.cols,
              rows: msg.rows,
              viewers: msg.viewers,
            });
          } else if (msg.type === "snapshot") {
            const current = rtcRef.current;
            const dcOffset =
              current.open &&
              current.sessionId &&
              msg.rtc_session_id === current.sessionId &&
              typeof msg.dc_offset === "number"
                ? msg.dc_offset
                : null;
            h.onSnapshot?.(base64ToBytes(msg.bytes_b64), Boolean(msg.plain), dcOffset);
          } else if (msg.type === "agent.exit") {
            h.onExit?.(msg.exit_code, msg.signal);
          } else if (msg.type === "agent.status") {
            h.onStatus?.(msg.status);
          } else if (msg.type === "upload.saved") {
            h.onUploadSaved?.(msg.path, msg.client_id);
          } else if (msg.type === "upload.error") {
            h.onUploadError?.(msg.message);
          } else if (msg.type === "rtc.config") {
            if (msg.enabled) {
              lastRtcIceServers = msg.ice_servers ?? [];
              rtcRetryAttempts = 0;
              void startRtc(lastRtcIceServers);
            } else {
              lastRtcIceServers = null;
            }
          } else if (msg.type === "rtc.answer") {
            const current = rtcRef.current;
            if (current.sessionId === msg.session_id && current.pc) {
              void current.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).then(() => {
                const pending = pendingRemoteRtcCandidatesRef.current.splice(0);
                for (const candidate of pending) {
                  void current.pc?.addIceCandidate(candidate).catch(() => {});
                }
              });
            }
          } else if (msg.type === "rtc.candidate") {
            const current = rtcRef.current;
            if (current.sessionId === msg.session_id && current.pc) {
              if (current.pc.remoteDescription) {
                void current.pc.addIceCandidate(msg.candidate).catch(() => {});
              } else {
                pendingRemoteRtcCandidatesRef.current.push(msg.candidate);
              }
            }
          } else if (msg.type === "rtc.status") {
            if (
              msg.session_id &&
              rtcRef.current.sessionId === msg.session_id &&
              ["failed", "disabled", "unavailable"].includes(msg.status)
            ) {
              cleanupRtc(false, msg.status !== "disabled");
            }
          }
        } else if (ev.data instanceof ArrayBuffer) {
          // v2 servers never send binary; drop anything that shows up rather
          // than double-rendering against the DataChannel stream.
          if (wsV2Ref.current) return;
          if (!rtcRef.current.open) {
            h.onData(new Uint8Array(ev.data));
          } else if (Date.now() - lastRtcDataAt > RTC_RELAY_DUPLICATE_WINDOW_MS) {
            scheduleRelayFallback(new Uint8Array(ev.data));
          }
        }
      };
      ws.onerror = () => {
        setState("error");
      };
      ws.onclose = () => {
        cleanupRtc(false);
        wsRef.current = null;
        setState("closed");
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      attempt += 1;
      const delay = Math.min(10_000, 500 * attempt);
      reconnectTimer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rtcRetryTimer) clearTimeout(rtcRetryTimer);
      if (wsRef.current) {
        try {
          cleanupRtc(true);
          wsRef.current.close(1000, "unmount");
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
    };
  }, [agentId, enabled]);

  const sendBinary = (bytes: Uint8Array | string) => {
    const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const rtc = rtcRef.current;
    if (rtc.open && rtc.dc?.readyState === "open") {
      rtc.dc.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      return true;
    }
    if (wsV2Ref.current) {
      // No relay on v2: hold input until the DataChannel (re)opens.
      if (pendingInputBytesRef.current + buf.byteLength > MAX_PENDING_INPUT_BYTES) return false;
      pendingInputRef.current.push(buf.slice());
      pendingInputBytesRef.current += buf.byteLength;
      return true;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    // Convert to a fresh ArrayBuffer to satisfy strict BufferSource typing.
    ws.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    return true;
  };

  const sendJson = (msg: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    // Stamp snapshot requests with the live RTC session so the daemon can
    // return the DataChannel stream offset at capture time.
    const rtc = rtcRef.current;
    const payload =
      typeof msg === "object" &&
      msg !== null &&
      (msg as { type?: string }).type === "snapshot" &&
      rtc.open &&
      rtc.sessionId
        ? { ...(msg as Record<string, unknown>), rtc_session_id: rtc.sessionId }
        : msg;
    ws.send(JSON.stringify(payload));
    return true;
  };

  return { state, v2, dcOpen, sendBinary, sendJson };
}
