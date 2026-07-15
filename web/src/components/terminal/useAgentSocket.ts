"use client";

import { useEffect, useRef, useState } from "react";
import {
  AGENT_CTL_MAX_PENDING_PTY_BYTES,
  AGENT_CTL_MAX_REPLAY_BYTES,
  AGENT_CTL_MAX_REPLAY_CHUNKS,
  type AgentCtlOperation,
  type AgentCtlResponse,
  combineAgentCtlChunks,
  decodeAgentCtlChunk,
  makeAgentCtlRequest,
  parseAgentCtlText,
  slicePtyChunkAfterAnchor,
} from "@/lib/agent-ctl";
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

/** How the live terminal bytes are travelling right now. */
export interface ConnInfo {
  /** ICE path classification of the selected candidate pair. */
  kind: "direct" | "stun" | "relay" | null;
  rttMs: number | null;
  protocol: string | null;
}

const EMPTY_CONN_INFO: ConnInfo = { kind: null, rttMs: null, protocol: null };

type RtcState = {
  pc: RTCPeerConnection | null;
  ptyDc: RTCDataChannel | null;
  ctlDc: RTCDataChannel | null;
  sessionId: string | null;
  ptyOpen: boolean;
  ctlOpen: boolean;
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
  const [connInfo, setConnInfo] = useState<ConnInfo>(EMPTY_CONN_INFO);
  const wsRef = useRef<WebSocket | null>(null);
  const wsV2Ref = useRef(false);
  const pendingInputRef = useRef<Uint8Array[]>([]);
  const pendingInputBytesRef = useRef(0);
  const rtcRef = useRef<RtcState>({
    pc: null,
    ptyDc: null,
    ctlDc: null,
    sessionId: null,
    ptyOpen: false,
    ctlOpen: false,
    open: false,
    bytesReceived: 0,
  });
  const sendControlRef = useRef<
    (operation: AgentCtlOperation, parameters?: Record<string, unknown>) => boolean
  >(() => false);
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
      rtcRef.current = {
        pc: null,
        ptyDc: null,
        ctlDc: null,
        sessionId: null,
        ptyOpen: false,
        ctlOpen: false,
        open: false,
        bytesReceived: 0,
      };
      try {
        rtc.ptyDc?.close();
        rtc.ctlDc?.close();
      } catch {
        // ignore
      }
      try {
        rtc.pc?.close();
      } catch {
        // ignore
      }
      sendControlRef.current = () => false;
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
      const forceRelay =
        typeof window !== "undefined" &&
        (window as { __spawnRtcForceRelay?: boolean }).__spawnRtcForceRelay === true;
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: forceRelay ? "relay" : "all",
      });
      const ptyDc = pc.createDataChannel("spawn.pty", { ordered: true });
      const useControlChannel = wsV2Ref.current;
      const ctlDc = useControlChannel ? pc.createDataChannel("spawn.ctl", { ordered: true }) : null;
      const pendingLocalCandidates: RTCIceCandidateInit[] = [];
      const pendingControlTexts: string[] = [];
      const replayResponses = new Map<
        string,
        { metadata: AgentCtlResponse; chunks: Map<number, Uint8Array>; sawLast: boolean }
      >();
      const pendingBootstrapPty: Array<{ bytes: Uint8Array; offsetAfter: number }> = [];
      const pendingSnapshots: Array<{
        bytes: Uint8Array;
        plain: boolean;
        ptyOffset: number;
      }> = [];
      let pendingBootstrapPtyBytes = 0;
      let bootstrapDone = !useControlChannel;
      let bootstrapPtyAnchor: number | null = null;
      let initialHistoryRequestId: string | null = null;
      let offerSent = false;
      ptyDc.binaryType = "arraybuffer";
      if (ctlDc) ctlDc.binaryType = "arraybuffer";
      rtcRef.current = {
        pc,
        ptyDc,
        ctlDc,
        sessionId,
        ptyOpen: false,
        ctlOpen: !useControlChannel,
        open: false,
        bytesReceived: 0,
      };

      const flushPendingInput = () => {
        const queued = pendingInputRef.current.splice(0);
        pendingInputBytesRef.current = 0;
        for (const chunk of queued) {
          try {
            ptyDc.send(
              chunk.buffer.slice(
                chunk.byteOffset,
                chunk.byteOffset + chunk.byteLength,
              ) as ArrayBuffer,
            );
          } catch {
            break;
          }
        }
      };

      const markReady = () => {
        const current = rtcRef.current;
        if (
          current.sessionId !== sessionId ||
          current.open ||
          !current.ptyOpen ||
          !current.ctlOpen ||
          !bootstrapDone
        ) {
          return;
        }
        rtcRef.current = { ...current, open: true };
        clearRtcConnectTimer();
        rtcRetryAttempts = 0;
        lastRtcDataAt = Date.now();
        setDcOpen(true);
        flushPendingInput();
      };

      const deliverAnchoredPtyChunk = (bytes: Uint8Array, offsetAfter: number) => {
        const sliced = slicePtyChunkAfterAnchor(bytes, offsetAfter, bootstrapPtyAnchor);
        bootstrapPtyAnchor = sliced.anchor;
        if (sliced.bytes) handlersRef.current.onData(sliced.bytes, offsetAfter);
      };

      const flushPendingSnapshots = () => {
        const received = rtcRef.current.bytesReceived;
        while (pendingSnapshots.length > 0 && pendingSnapshots[0].ptyOffset <= received) {
          const snapshot = pendingSnapshots.shift();
          if (!snapshot) break;
          handlersRef.current.onSnapshot?.(snapshot.bytes, snapshot.plain, snapshot.ptyOffset);
        }
      };

      const finishBootstrap = (bytes: Uint8Array, ptyOffset: number | null | undefined) => {
        if (bootstrapDone || rtcRef.current.sessionId !== sessionId) return;
        const anchor = typeof ptyOffset === "number" && ptyOffset >= 0 ? ptyOffset : 0;
        if (handlersRef.current.onHistory) handlersRef.current.onHistory(bytes);
        else handlersRef.current.onData(bytes);
        bootstrapPtyAnchor = anchor;
        for (const chunk of pendingBootstrapPty.splice(0)) {
          deliverAnchoredPtyChunk(chunk.bytes, chunk.offsetAfter);
        }
        pendingBootstrapPtyBytes = 0;
        bootstrapDone = true;
        flushPendingSnapshots();
        markReady();
      };

      const maybeFinishReplay = (requestId: string) => {
        const response = replayResponses.get(requestId);
        if (!response) return;
        const expectedChunks = response.metadata.chunks ?? -1;
        const expectedBytes = response.metadata.total_bytes ?? -1;
        if (response.chunks.size !== expectedChunks) return;
        if (expectedChunks > 0 && !response.sawLast) return;
        const bytes = combineAgentCtlChunks(response.chunks, expectedChunks, expectedBytes);
        replayResponses.delete(requestId);
        if (!bytes) {
          if (requestId === initialHistoryRequestId) finishBootstrap(new Uint8Array(), 0);
          return;
        }
        if (requestId === initialHistoryRequestId || response.metadata.operation === "history") {
          finishBootstrap(bytes, response.metadata.pty_offset);
        } else if (response.metadata.operation === "snapshot") {
          const ptyOffset =
            typeof response.metadata.pty_offset === "number" ? response.metadata.pty_offset : null;
          if (ptyOffset !== null && ptyOffset > rtcRef.current.bytesReceived) {
            if (pendingSnapshots.length < 8) {
              pendingSnapshots.push({
                bytes,
                plain: Boolean(response.metadata.plain),
                ptyOffset,
              });
            }
          } else {
            handlersRef.current.onSnapshot?.(bytes, Boolean(response.metadata.plain), ptyOffset);
          }
        }
      };

      const sendControl = (
        operation: AgentCtlOperation,
        parameters: Record<string, unknown> = {},
      ): boolean => {
        if (!ctlDc) return false;
        const requestId = newRtcSessionId();
        const text = makeAgentCtlRequest(requestId, operation, parameters);
        if (!text) return false;
        if (ctlDc.readyState === "open") {
          ctlDc.send(text);
        } else {
          if (pendingControlTexts.length >= 128) return false;
          pendingControlTexts.push(text);
        }
        return true;
      };
      sendControlRef.current = useControlChannel ? sendControl : () => false;

      rtcConnectTimer = setTimeout(() => {
        if (rtcRef.current.sessionId === sessionId && !rtcRef.current.open) {
          cleanupRtc(true, true);
        }
      }, RTC_CONNECT_TIMEOUT_MS);

      const sendRtcCandidate = (candidate: RTCIceCandidateInit) =>
        sendJsonOverWs({ type: "rtc.candidate", session_id: sessionId, candidate });

      pc.onicecandidate = (event) => {
        if (!event.candidate || cancelled) return;
        const candidate = event.candidate.toJSON();
        if (offerSent) sendRtcCandidate(candidate);
        else pendingLocalCandidates.push(candidate);
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

      ptyDc.onopen = () => {
        const current = rtcRef.current;
        if (current.sessionId !== sessionId) return;
        rtcRef.current = { ...current, ptyOpen: true };
        markReady();
      };
      ptyDc.onclose = () => {
        const current = rtcRef.current;
        if (current.sessionId !== sessionId) return;
        cleanupRtc(true, true);
      };
      ptyDc.onerror = () => cleanupRtc(true, true);
      const deliverPtyChunk = (bytes: Uint8Array) => {
        const current = rtcRef.current;
        if (current.sessionId !== sessionId) return;
        current.bytesReceived += bytes.byteLength;
        if (!bootstrapDone) {
          if (pendingBootstrapPtyBytes + bytes.byteLength > AGENT_CTL_MAX_PENDING_PTY_BYTES) {
            cleanupRtc(true, true);
            return;
          }
          pendingBootstrapPty.push({ bytes, offsetAfter: current.bytesReceived });
          pendingBootstrapPtyBytes += bytes.byteLength;
          return;
        }
        deliverAnchoredPtyChunk(bytes, current.bytesReceived);
        flushPendingSnapshots();
      };
      ptyDc.onmessage = (event) => {
        lastRtcDataAt = Date.now();
        clearRelayFallback();
        if (event.data instanceof ArrayBuffer) {
          deliverPtyChunk(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buffer) => {
            if (!cancelled) deliverPtyChunk(new Uint8Array(buffer));
          });
        }
      };

      if (ctlDc) {
        ctlDc.onopen = () => {
          const current = rtcRef.current;
          if (current.sessionId !== sessionId) return;
          rtcRef.current = { ...current, ctlOpen: true };
          initialHistoryRequestId = newRtcSessionId();
          const size = initialSizeRef.current;
          const historyText = makeAgentCtlRequest(initialHistoryRequestId, "history", {
            lines: 400,
            plain: false,
            ...(size ? { cols: size.cols, rows: size.rows } : {}),
          });
          if (!historyText) {
            finishBootstrap(new Uint8Array(), 0);
          } else {
            ctlDc.send(historyText);
          }
          for (const text of pendingControlTexts.splice(0)) ctlDc.send(text);
          markReady();
        };
        ctlDc.onclose = () => {
          const current = rtcRef.current;
          if (current.sessionId !== sessionId) return;
          cleanupRtc(true, true);
        };
        ctlDc.onerror = () => cleanupRtc(true, true);
        const deliverControlBinary = (bytes: Uint8Array) => {
          const chunk = decodeAgentCtlChunk(bytes);
          if (!chunk) return;
          const response = replayResponses.get(chunk.requestId);
          if (!response || response.chunks.has(chunk.sequence)) return;
          response.chunks.set(chunk.sequence, chunk.payload);
          if (chunk.last) response.sawLast = true;
          maybeFinishReplay(chunk.requestId);
        };
        ctlDc.onmessage = (event) => {
          if (typeof event.data === "string") {
            const message = parseAgentCtlText(event.data);
            if (!message) return;
            if (message.kind === "event") {
              handlersRef.current.onDisplayControl?.({
                owner: message.owner,
                cols: message.cols,
                rows: message.rows,
                viewers: message.viewers,
              });
              return;
            }
            if (!message.ok) {
              if (message.request_id === initialHistoryRequestId) {
                finishBootstrap(new Uint8Array(), 0);
              }
              return;
            }
            if (
              message.request_id &&
              (message.operation === "history" || message.operation === "snapshot") &&
              typeof message.total_bytes === "number" &&
              message.total_bytes >= 0 &&
              message.total_bytes <= AGENT_CTL_MAX_REPLAY_BYTES &&
              typeof message.chunks === "number" &&
              Number.isInteger(message.chunks) &&
              message.chunks >= 0 &&
              message.chunks <= AGENT_CTL_MAX_REPLAY_CHUNKS
            ) {
              replayResponses.set(message.request_id, {
                metadata: message,
                chunks: new Map(),
                sawLast: message.chunks === 0,
              });
              maybeFinishReplay(message.request_id);
            }
            return;
          }
          if (event.data instanceof ArrayBuffer) {
            deliverControlBinary(new Uint8Array(event.data));
          } else if (event.data instanceof Blob) {
            void event.data.arrayBuffer().then((buffer) => {
              if (!cancelled) deliverControlBinary(new Uint8Array(buffer));
            });
          }
        };
      }

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (cancelled || rtcRef.current.sessionId !== sessionId) return;
        if (!sendJsonOverWs({ type: "rtc.offer", session_id: sessionId, sdp: offer.sdp })) {
          cleanupRtc(false);
          return;
        }
        offerSent = true;
        for (const candidate of pendingLocalCandidates.splice(0)) sendRtcCandidate(candidate);
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
        const forceV1 =
          typeof window !== "undefined" &&
          (window as { __spawnForceWsV1?: boolean }).__spawnForceWsV1 === true;
        // Geometry is protected viewport content. Only an explicitly forced
        // legacy-v1 test/client sends it in the server-visible URL.
        ws = new WebSocket(
          buildAgentWsUrl(agentId, forceV1 ? initialSizeRef.current : null),
          spawnWsSubprotocols(),
        );
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
            if (wsV2Ref.current) return;
            const bytes = base64ToBytes(msg.bytes_b64);
            if (h.onHistory) h.onHistory(bytes);
            else h.onData(bytes);
          } else if (msg.type === "display.control") {
            if (wsV2Ref.current) return;
            h.onDisplayControl?.({
              owner: msg.owner,
              cols: msg.cols,
              rows: msg.rows,
              viewers: msg.viewers,
            });
          } else if (msg.type === "snapshot") {
            if (wsV2Ref.current) return;
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

  // Poll WebRTC stats while the channel is up: the selected candidate pair
  // tells us whether bytes flow direct, via STUN-discovered addresses, or
  // through the TURN relay — plus the live round-trip time.
  useEffect(() => {
    if (!dcOpen) {
      setConnInfo(EMPTY_CONN_INFO);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const pc = rtcRef.current.pc;
      if (!pc) return;
      let stats: RTCStatsReport;
      try {
        stats = await pc.getStats();
      } catch {
        return;
      }
      interface PairStats {
        id: string;
        type: string;
        localCandidateId?: string;
        remoteCandidateId?: string;
        currentRoundTripTime?: number;
        state?: string;
        nominated?: boolean;
        selectedCandidatePairId?: string;
      }
      const reports: PairStats[] = [];
      stats.forEach((report) => {
        reports.push(report as unknown as PairStats);
      });
      const selectedPairId = reports.find(
        (r) => r.type === "transport" && r.selectedCandidatePairId,
      )?.selectedCandidatePairId;
      const pair = reports.find(
        (r) =>
          r.type === "candidate-pair" &&
          (selectedPairId ? r.id === selectedPairId : r.state === "succeeded" && r.nominated),
      );
      if (!pair || cancelled) return;
      const local = (pair.localCandidateId ? stats.get(pair.localCandidateId) : null) as {
        candidateType?: string;
        protocol?: string;
      } | null;
      const remote = (pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null) as {
        candidateType?: string;
      } | null;
      const types = [local?.candidateType, remote?.candidateType];
      const kind = types.includes("relay")
        ? "relay"
        : types.includes("srflx") || types.includes("prflx")
          ? "stun"
          : "direct";
      setConnInfo({
        kind,
        rttMs:
          typeof pair.currentRoundTripTime === "number"
            ? Math.max(1, Math.round(pair.currentRoundTripTime * 1000))
            : null,
        protocol: local?.protocol ?? null,
      });
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [dcOpen]);

  const sendBinary = (bytes: Uint8Array | string) => {
    const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const rtc = rtcRef.current;
    if (rtc.open && rtc.ptyDc?.readyState === "open") {
      rtc.ptyDc.send(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
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
    if (wsV2Ref.current && typeof msg === "object" && msg !== null) {
      const payload = msg as Record<string, unknown>;
      const type = payload.type;
      const operation =
        type === "take_control"
          ? "take_control"
          : type === "resize" || type === "scroll" || type === "redraw" || type === "snapshot"
            ? type
            : null;
      if (operation) {
        const { type: _type, rtc_session_id: _rtcSessionId, ...parameters } = payload;
        return sendControlRef.current(operation, parameters);
      }
    }
    ws.send(JSON.stringify(msg));
    return true;
  };

  return { state, v2, dcOpen, connInfo, sendBinary, sendJson };
}
