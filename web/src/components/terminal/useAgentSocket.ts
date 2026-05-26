"use client";

import { useEffect, useRef, useState } from "react";
import {
  base64ToBytes,
  buildAgentWsUrl,
  type DisplayControlState,
  parseInbound,
  SPAWN_WS_SUBPROTOCOL,
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
  onData: (bytes: Uint8Array) => void;
  onHistory?: (bytes: Uint8Array) => void;
  onDisplayControl?: (state: DisplayControlState) => void;
  onExit?: (exitCode: number | null, signal: string | null) => void;
  onStatus?: (status: string) => void;
  onSnapshot?: (bytes: Uint8Array, plain: boolean) => void;
  onUploadSaved?: (path: string, clientId?: string) => void;
  onUploadError?: (message: string) => void;
}

export type SocketState = "idle" | "connecting" | "open" | "closed" | "error";

type RtcState = {
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  sessionId: string | null;
  open: boolean;
};

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
  const wsRef = useRef<WebSocket | null>(null);
  const rtcRef = useRef<RtcState>({ pc: null, dc: null, sessionId: null, open: false });
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

    const sendJsonOverWs = (msg: unknown) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    };

    const cleanupRtc = (signal = true) => {
      const rtc = rtcRef.current;
      const sessionId = rtc.sessionId;
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
      rtcRef.current = { pc: null, dc: null, sessionId: null, open: false };
      pendingRemoteRtcCandidatesRef.current = [];
      rtcStartInFlight = false;
    };

    const startRtc = async (iceServers: RTCIceServer[]) => {
      if (cancelled || rtcStartInFlight || rtcRef.current.pc) return;
      if (typeof RTCPeerConnection === "undefined") return;
      rtcStartInFlight = true;
      const sessionId = newRtcSessionId();
      const pc = new RTCPeerConnection({ iceServers });
      const dc = pc.createDataChannel("spawn.pty", { ordered: true });
      const pendingLocalCandidates: RTCIceCandidateInit[] = [];
      let offerSent = false;
      dc.binaryType = "arraybuffer";
      rtcRef.current = { pc, dc, sessionId, open: false };

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
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          cleanupRtc(pc.connectionState !== "closed");
        }
      };
      dc.onopen = () => {
        const current = rtcRef.current;
        if (current.sessionId === sessionId) {
          rtcRef.current = { ...current, open: true };
        }
      };
      dc.onclose = () => {
        const current = rtcRef.current;
        if (current.sessionId === sessionId) {
          rtcRef.current = { ...current, open: false };
        }
      };
      dc.onerror = () => {
        cleanupRtc();
      };
      dc.onmessage = (event) => {
        const h = handlersRef.current;
        if (event.data instanceof ArrayBuffer) {
          h.onData(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buf) => {
            if (!cancelled) h.onData(new Uint8Array(buf));
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
        ws = new WebSocket(buildAgentWsUrl(agentId, initialSizeRef.current), [
          SPAWN_WS_SUBPROTOCOL,
        ]);
      } catch {
        setState("error");
        scheduleReconnect();
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
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
            h.onSnapshot?.(base64ToBytes(msg.bytes_b64), Boolean(msg.plain));
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
              void startRtc(msg.ice_servers ?? []);
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
              cleanupRtc(false);
            }
          }
        } else if (ev.data instanceof ArrayBuffer) {
          if (!rtcRef.current.open) {
            h.onData(new Uint8Array(ev.data));
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
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    // Convert to a fresh ArrayBuffer to satisfy strict BufferSource typing.
    ws.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    return true;
  };

  const sendJson = (msg: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  return { state, sendBinary, sendJson };
}
