"use client";

import { useEffect, useRef, useState } from "react";
import {
  AGENT_CTL_MAX_PENDING_PTY_BYTES,
  type AgentCtlOperation,
  AgentCtlRequestTracker,
  type AgentCtlTrackedResult,
  AgentGenerationInputQueue,
  decodeAgentCtlChunk,
  makeAgentCtlRequest,
  newAgentCtlRequestId,
  OrderedAsyncQueue,
  parseAgentCtlText,
  slicePtyChunkAfterAnchor,
} from "@/lib/agent-ctl";
import {
  agentRtcTuple,
  buildAgentWsUrl,
  type DisplayControlState,
  parseInbound,
  rtcBindingFrameMatches,
  SPAWN_WS_SUBPROTOCOL,
} from "@/lib/ws";

/**
 * Lifecycle hook for the per-agent browser WS.
 *
 * Manages connect, reconnect (linear backoff up to 10s), and surface state
 * via callbacks.  The caller is responsible for actually wiring `onData` to
 * the xterm.js instance (we keep this hook framework-agnostic so it could
 * also maintain local replay state).
 */
export interface UseAgentSocketOptions {
  agentId: string;
  enabled?: boolean;
  initialSize?: { cols: number; rows: number } | null;
  /** dcOffsetAfter is the cumulative DataChannel byte count including this
   *  chunk; every terminal byte arrives over the DataChannel. */
  onData: (bytes: Uint8Array, dcOffsetAfter?: number) => void;
  onHistory?: (bytes: Uint8Array, dcOffset?: number | null) => void;
  onDisplayControl?: (state: DisplayControlState) => void;
  onExit?: (exitCode: number | null, signal: string | null) => void;
  onStatus?: (status: string) => void;
  /** dcOffset is the daemon-side DataChannel byte count at capture time for
   *  the CURRENT rtc session, or null when the snapshot has no usable anchor
   *  (stale session). */
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
  agentId: string | null;
  agentGeneration: number;
  rtcGeneration: number;
  pc: RTCPeerConnection | null;
  ptyDc: RTCDataChannel | null;
  ctlDc: RTCDataChannel | null;
  sessionId: string | null;
  ptyOpen: boolean;
  ctlOpen: boolean;
  bindingNonce: string | null;
  bindingGeneration: number | null;
  open: boolean;
  /** Cumulative PTY bytes received over this session's DataChannel. */
  bytesReceived: number;
};

const RTC_CONNECT_TIMEOUT_MS = 10_000;
const RTC_DISCONNECTED_GRACE_MS = 5_000;
// Retry failed WebRTC attempts with backoff; there is no content fallback.
const RTC_RETRY_BASE_DELAY_MS = 5_000;
const RTC_RETRY_MAX_DELAY_MS = 60_000;
// Keystrokes typed before the DataChannel opens are held briefly and flushed
// on open. Cap the buffer so a dead channel cannot grow it without bound.
const MAX_PENDING_INPUT_BYTES = 64 * 1024;

function newRtcSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

type FillRandomBytes = (bytes: Uint8Array) => void;

/** Generate an authority-binding identity, or fail closed without a CSPRNG. */
export function newRtcBindingNonce(fillRandomBytes?: FillRandomBytes | null): string | null {
  const fill =
    fillRandomBytes === undefined
      ? typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
        ? (bytes: Uint8Array) => {
            crypto.getRandomValues(bytes);
          }
        : null
      : fillRandomBytes;
  if (!fill) return null;
  const bytes = new Uint8Array(16);
  try {
    fill(bytes);
  } catch {
    return null;
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
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
  // True after the one supported signaling protocol is negotiated.
  const [v2, setV2] = useState(false);
  // True while the spawn.pty DataChannel is open — on v2 this IS the live
  // terminal path, so callers surface it as connection state.
  const [dcOpen, setDcOpen] = useState(false);
  const [connInfo, setConnInfo] = useState<ConnInfo>(EMPTY_CONN_INFO);
  const wsRef = useRef<WebSocket | null>(null);
  const activeAgentIdRef = useRef<string | null>(null);
  const agentGenerationRef = useRef(0);
  const rtcGenerationRef = useRef(0);
  const pendingInputRef = useRef(new AgentGenerationInputQueue(MAX_PENDING_INPUT_BYTES));
  const rtcRef = useRef<RtcState>({
    agentId: null,
    agentGeneration: 0,
    rtcGeneration: 0,
    pc: null,
    ptyDc: null,
    ctlDc: null,
    sessionId: null,
    ptyOpen: false,
    ctlOpen: false,
    bindingNonce: null,
    bindingGeneration: null,
    open: false,
    bytesReceived: 0,
  });
  const sendControlRef = useRef<
    (operation: AgentCtlOperation, parameters?: Record<string, unknown>) => boolean
  >(() => false);
  const pendingRemoteRtcCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const initialSizeRef = useRef(initialSize);
  const handlersRef = useRef({
    agentId,
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
    agentId,
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
    const agentGeneration = agentGenerationRef.current + 1;
    agentGenerationRef.current = agentGeneration;
    pendingInputRef.current.clear();
    sendControlRef.current = () => false;
    activeAgentIdRef.current = enabled && agentId ? agentId : null;
    setV2(false);
    setDcOpen(false);
    if (!enabled || !agentId) return;
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcStartInFlight = false;
    let rtcConnectTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcDisconnectedTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcRetryAttempts = 0;
    let lastRtcIceServers: RTCIceServer[] | null = null;

    const isCurrentAgentGeneration = () => agentGenerationRef.current === agentGeneration;
    const isActiveAgentGeneration = () => !cancelled && isCurrentAgentGeneration();
    const currentHandlers = () =>
      isActiveAgentGeneration() && handlersRef.current.agentId === agentId
        ? handlersRef.current
        : null;

    const sendJsonOverWs = (msg: unknown) => {
      if (!isCurrentAgentGeneration()) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    };
    const boundAgentRtcTuple = agentRtcTuple(agentId);

    const clearRtcConnectTimer = () => {
      if (rtcConnectTimer) clearTimeout(rtcConnectTimer);
      rtcConnectTimer = null;
    };

    const clearRtcDisconnectedTimer = () => {
      if (rtcDisconnectedTimer) clearTimeout(rtcDisconnectedTimer);
      rtcDisconnectedTimer = null;
    };

    const cleanupRtc = (signal = true, retry = false, expectedRtcGeneration?: number) => {
      const rtc = rtcRef.current;
      if (
        rtc.agentId !== agentId ||
        rtc.agentGeneration !== agentGeneration ||
        (expectedRtcGeneration !== undefined && rtc.rtcGeneration !== expectedRtcGeneration)
      ) {
        return;
      }
      const sessionId = rtc.sessionId;
      const bindingNonce = rtc.bindingNonce;
      clearRtcConnectTimer();
      clearRtcDisconnectedTimer();
      if (signal && sessionId && bindingNonce) {
        sendJsonOverWs({
          type: "rtc.close",
          session_id: sessionId,
          binding_nonce: bindingNonce,
          ...boundAgentRtcTuple,
        });
      }
      rtcRef.current = {
        agentId: null,
        agentGeneration: 0,
        rtcGeneration: 0,
        pc: null,
        ptyDc: null,
        ctlDc: null,
        sessionId: null,
        ptyOpen: false,
        ctlOpen: false,
        bindingNonce: null,
        bindingGeneration: null,
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
      if (isCurrentAgentGeneration()) setDcOpen(false);
      if (retry) scheduleRtcRetry();
    };

    // Retry transient WebRTC failures without opening a content fallback.
    const scheduleRtcRetry = () => {
      if (!isActiveAgentGeneration() || rtcRetryTimer || !lastRtcIceServers) return;
      const delay = Math.min(
        RTC_RETRY_MAX_DELAY_MS,
        RTC_RETRY_BASE_DELAY_MS * 2 ** rtcRetryAttempts,
      );
      rtcRetryAttempts += 1;
      rtcRetryTimer = setTimeout(() => {
        rtcRetryTimer = null;
        if (!isActiveAgentGeneration() || rtcRef.current.pc) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        if (lastRtcIceServers) void startRtc(lastRtcIceServers);
      }, delay);
    };

    const startRtc = async (iceServers: RTCIceServer[]) => {
      if (!isActiveAgentGeneration() || rtcStartInFlight || rtcRef.current.pc) return;
      if (typeof RTCPeerConnection === "undefined") return;
      rtcStartInFlight = true;
      const rtcGeneration = rtcGenerationRef.current + 1;
      rtcGenerationRef.current = rtcGeneration;
      const sessionId = newRtcSessionId();
      const bindingNonce = newRtcBindingNonce();
      if (!bindingNonce) {
        rtcStartInFlight = false;
        lastRtcIceServers = null;
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.close(1002, "Secure RTC binding identity is unavailable");
        }
        return;
      }
      // Debug/acceptance hook: force TURN-relay-only ICE to prove sessions
      // survive networks where no direct path exists (docs/TRUST.md Phase 1).
      const forceRelay =
        typeof window !== "undefined" &&
        (window as { __spawnRtcForceRelay?: boolean }).__spawnRtcForceRelay === true;
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: forceRelay ? "relay" : "all",
      });
      const ptyDc = pc.createDataChannel("spawn.pty", { ordered: true });
      const ctlDc = pc.createDataChannel("spawn.ctl", { ordered: true });
      const pendingLocalCandidates: RTCIceCandidateInit[] = [];
      const pendingControlTexts: string[] = [];
      const requests = new AgentCtlRequestTracker();
      const pendingBootstrapPty: Array<{ bytes: Uint8Array; offsetAfter: number }> = [];
      const pendingSnapshots: Array<{
        bytes: Uint8Array;
        plain: boolean;
        ptyOffset: number;
      }> = [];
      let pendingBootstrapPtyBytes = 0;
      let bootstrapDone = false;
      let bootstrapPtyAnchor: number | null = null;
      let initialHistoryRequestId: string | null = null;
      let offerSent = false;
      const isCurrentRtcGeneration = () => {
        const current = rtcRef.current;
        return (
          isActiveAgentGeneration() &&
          current.agentId === agentId &&
          current.agentGeneration === agentGeneration &&
          current.rtcGeneration === rtcGeneration &&
          current.sessionId === sessionId
        );
      };
      ptyDc.binaryType = "arraybuffer";
      ctlDc.binaryType = "arraybuffer";
      rtcRef.current = {
        agentId,
        agentGeneration,
        rtcGeneration,
        pc,
        ptyDc,
        ctlDc,
        sessionId,
        ptyOpen: false,
        ctlOpen: false,
        bindingNonce,
        bindingGeneration: null,
        open: false,
        bytesReceived: 0,
      };

      const flushPendingInput = () => {
        const queued = pendingInputRef.current.drain(agentGeneration);
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
          !isCurrentRtcGeneration() ||
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
        if (isCurrentAgentGeneration()) setDcOpen(true);
        flushPendingInput();
      };

      const deliverAnchoredPtyChunk = (bytes: Uint8Array, offsetAfter: number) => {
        if (!isCurrentRtcGeneration()) return;
        const sliced = slicePtyChunkAfterAnchor(bytes, offsetAfter, bootstrapPtyAnchor);
        bootstrapPtyAnchor = sliced.anchor;
        const handlers = currentHandlers();
        if (sliced.bytes && handlers) handlers.onData(sliced.bytes, offsetAfter);
      };

      const flushPendingSnapshots = () => {
        if (!isCurrentRtcGeneration()) return;
        const received = rtcRef.current.bytesReceived;
        while (pendingSnapshots.length > 0 && pendingSnapshots[0].ptyOffset <= received) {
          const snapshot = pendingSnapshots.shift();
          if (!snapshot) break;
          currentHandlers()?.onSnapshot?.(snapshot.bytes, snapshot.plain, snapshot.ptyOffset);
        }
      };

      const finishBootstrap = (bytes: Uint8Array, ptyOffset: number | null | undefined) => {
        if (bootstrapDone || !isCurrentRtcGeneration()) return;
        const anchor = typeof ptyOffset === "number" && ptyOffset >= 0 ? ptyOffset : 0;
        const handlers = currentHandlers();
        if (!handlers) return;
        if (handlers.onHistory) handlers.onHistory(bytes, ptyOffset);
        else handlers.onData(bytes);
        bootstrapPtyAnchor = anchor;
        for (const chunk of pendingBootstrapPty.splice(0)) {
          deliverAnchoredPtyChunk(chunk.bytes, chunk.offsetAfter);
        }
        pendingBootstrapPtyBytes = 0;
        bootstrapDone = true;
        flushPendingSnapshots();
        markReady();
      };

      const acceptTrackedResult = (result: AgentCtlTrackedResult | null) => {
        if (!result || !isCurrentRtcGeneration()) return;
        const requestId = result.response.request_id;
        if (result.kind === "response") {
          if (!result.response.ok && requestId === initialHistoryRequestId) {
            finishBootstrap(new Uint8Array(), 0);
          }
          return;
        }
        if (requestId === initialHistoryRequestId || result.response.operation === "history") {
          finishBootstrap(result.bytes, result.response.pty_offset);
        } else if (result.response.operation === "snapshot") {
          const ptyOffset =
            typeof result.response.pty_offset === "number" ? result.response.pty_offset : null;
          if (ptyOffset !== null && ptyOffset > rtcRef.current.bytesReceived) {
            if (pendingSnapshots.length < 8) {
              pendingSnapshots.push({
                bytes: result.bytes,
                plain: Boolean(result.response.plain),
                ptyOffset,
              });
            }
          } else {
            currentHandlers()?.onSnapshot?.(
              result.bytes,
              Boolean(result.response.plain),
              ptyOffset,
            );
          }
        }
      };

      const sendControl = (
        operation: AgentCtlOperation,
        parameters: Record<string, unknown> = {},
      ): boolean => {
        if (!ctlDc || !isCurrentRtcGeneration()) return false;
        const requestId = newAgentCtlRequestId();
        const text = makeAgentCtlRequest(requestId, operation, parameters);
        if (!text) return false;
        if (ctlDc.readyState !== "open" && pendingControlTexts.length >= 128) return false;
        if (!requests.register(requestId, operation)) return false;
        try {
          if (ctlDc.readyState === "open") {
            ctlDc.send(text);
          } else {
            pendingControlTexts.push(text);
          }
        } catch {
          requests.cancel(requestId);
          return false;
        }
        return true;
      };
      sendControlRef.current = sendControl;
      rtcConnectTimer = setTimeout(() => {
        if (isCurrentRtcGeneration() && !rtcRef.current.open) {
          cleanupRtc(true, true, rtcGeneration);
        }
      }, RTC_CONNECT_TIMEOUT_MS);

      const sendRtcCandidate = (candidate: RTCIceCandidateInit) =>
        sendJsonOverWs({
          type: "rtc.candidate",
          session_id: sessionId,
          binding_nonce: bindingNonce,
          ...boundAgentRtcTuple,
          candidate,
        });

      pc.onicecandidate = (event) => {
        if (!event.candidate || !isCurrentRtcGeneration()) return;
        const candidate = event.candidate.toJSON();
        if (offerSent) sendRtcCandidate(candidate);
        else pendingLocalCandidates.push(candidate);
      };
      pc.onconnectionstatechange = () => {
        if (!isCurrentRtcGeneration()) return;
        if (pc.connectionState === "connected") {
          clearRtcDisconnectedTimer();
          return;
        }
        if (pc.connectionState === "disconnected") {
          if (!rtcDisconnectedTimer) {
            rtcDisconnectedTimer = setTimeout(() => {
              if (rtcRef.current.sessionId === sessionId && pc.connectionState === "disconnected") {
                cleanupRtc(true, true, rtcGeneration);
              }
            }, RTC_DISCONNECTED_GRACE_MS);
          }
          return;
        }
        if (["failed", "closed"].includes(pc.connectionState)) {
          cleanupRtc(pc.connectionState !== "closed", true, rtcGeneration);
        }
      };

      ptyDc.onopen = () => {
        const current = rtcRef.current;
        if (!isCurrentRtcGeneration()) return;
        rtcRef.current = { ...current, ptyOpen: true };
        markReady();
      };
      ptyDc.onclose = () => {
        if (!isCurrentRtcGeneration()) return;
        cleanupRtc(true, true, rtcGeneration);
      };
      ptyDc.onerror = () => cleanupRtc(true, true, rtcGeneration);
      const deliverPtyChunk = (bytes: Uint8Array) => {
        const current = rtcRef.current;
        if (!isCurrentRtcGeneration()) return;
        current.bytesReceived += bytes.byteLength;
        if (!bootstrapDone) {
          if (pendingBootstrapPtyBytes + bytes.byteLength > AGENT_CTL_MAX_PENDING_PTY_BYTES) {
            cleanupRtc(true, true, rtcGeneration);
            return;
          }
          pendingBootstrapPty.push({ bytes, offsetAfter: current.bytesReceived });
          pendingBootstrapPtyBytes += bytes.byteLength;
          return;
        }
        deliverAnchoredPtyChunk(bytes, current.bytesReceived);
        flushPendingSnapshots();
      };
      const ptyMessages = new OrderedAsyncQueue();
      ptyDc.onmessage = (event) => {
        if (!isCurrentRtcGeneration()) return;
        const data = event.data;
        if (!(data instanceof ArrayBuffer) && !(data instanceof Blob)) return;
        void ptyMessages.enqueue(
          async () => new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data),
          (bytes) => {
            if (isCurrentRtcGeneration()) deliverPtyChunk(bytes);
          },
        );
      };

      if (ctlDc) {
        ctlDc.onopen = () => {
          if (!isCurrentRtcGeneration()) return;
          const current = rtcRef.current;
          rtcRef.current = { ...current, ctlOpen: true };
          initialHistoryRequestId = newAgentCtlRequestId();
          const size = initialSizeRef.current;
          const historyText = makeAgentCtlRequest(initialHistoryRequestId, "history", {
            lines: 400,
            plain: false,
            ...(size ? { cols: size.cols, rows: size.rows } : {}),
          });
          if (!historyText || !requests.register(initialHistoryRequestId, "history")) {
            finishBootstrap(new Uint8Array(), 0);
          } else {
            try {
              ctlDc.send(historyText);
            } catch {
              requests.cancel(initialHistoryRequestId);
              cleanupRtc(true, true, rtcGeneration);
              return;
            }
          }
          try {
            for (const text of pendingControlTexts.splice(0)) ctlDc.send(text);
          } catch {
            cleanupRtc(true, true, rtcGeneration);
            return;
          }
          markReady();
        };
        ctlDc.onclose = () => {
          if (!isCurrentRtcGeneration()) return;
          cleanupRtc(true, true, rtcGeneration);
        };
        ctlDc.onerror = () => cleanupRtc(true, true, rtcGeneration);
        const deliverControlBinary = (bytes: Uint8Array) => {
          if (!isCurrentRtcGeneration()) return;
          const chunk = decodeAgentCtlChunk(bytes);
          if (!chunk) return;
          acceptTrackedResult(requests.acceptChunk(chunk));
        };
        const controlMessages = new OrderedAsyncQueue();
        ctlDc.onmessage = (event) => {
          if (!isCurrentRtcGeneration()) return;
          const data = event.data;
          if (
            typeof data !== "string" &&
            !(data instanceof ArrayBuffer) &&
            !(data instanceof Blob)
          ) {
            return;
          }
          void controlMessages.enqueue(
            async () =>
              data instanceof Blob
                ? new Uint8Array(await data.arrayBuffer())
                : data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : data,
            (decoded) => {
              if (!isCurrentRtcGeneration()) return;
              if (typeof decoded !== "string") {
                deliverControlBinary(decoded);
                return;
              }
              const message = parseAgentCtlText(decoded);
              if (!message) return;
              if (message.kind === "event") {
                currentHandlers()?.onDisplayControl?.({
                  owner: message.owner,
                  cols: message.cols,
                  rows: message.rows,
                  viewers: message.viewers,
                });
                return;
              }
              acceptTrackedResult(requests.acceptResponse(message));
            },
          );
        };
      }

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!isCurrentRtcGeneration()) return;
        if (
          !sendJsonOverWs({
            type: "rtc.offer",
            session_id: sessionId,
            binding_nonce: bindingNonce,
            ...boundAgentRtcTuple,
            sdp: offer.sdp,
          })
        ) {
          cleanupRtc(false, false, rtcGeneration);
          return;
        }
        offerSent = true;
        for (const candidate of pendingLocalCandidates.splice(0)) sendRtcCandidate(candidate);
      } catch {
        cleanupRtc(true, false, rtcGeneration);
      } finally {
        if (isCurrentRtcGeneration()) rtcStartInFlight = false;
      }
    };

    const connect = () => {
      if (!isActiveAgentGeneration()) return;
      setState("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(buildAgentWsUrl(agentId), SPAWN_WS_SUBPROTOCOL);
      } catch {
        setState("error");
        scheduleReconnect();
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      const isCurrentWs = () => isActiveAgentGeneration() && wsRef.current === ws;

      ws.onopen = () => {
        if (!isCurrentWs()) return;
        attempt = 0;
        if (ws.protocol !== SPAWN_WS_SUBPROTOCOL) {
          ws.close(1002, "Required terminal signaling protocol was not selected");
          return;
        }
        setV2(true);
        setState("open");
      };
      ws.onmessage = (ev) => {
        if (!isCurrentWs()) return;
        const h = currentHandlers();
        if (!h) return;
        if (typeof ev.data === "string") {
          const msg = parseInbound(ev.data);
          if (!msg) return;
          if (msg.type === "agent.exit") {
            h.onExit?.(msg.exit_code, msg.signal);
          } else if (msg.type === "agent.status") {
            h.onStatus?.(msg.status);
          } else if (msg.type === "upload.saved") {
            h.onUploadSaved?.(msg.path, msg.client_id);
          } else if (msg.type === "upload.error") {
            h.onUploadError?.(msg.message);
          } else if (msg.type === "rtc.config") {
            if (msg.enabled) {
              if (msg.binding_nonce_required !== true) {
                ws.close(1002, "RTC binding identity negotiation is required");
                return;
              }
              lastRtcIceServers = msg.ice_servers ?? [];
              rtcRetryAttempts = 0;
              void startRtc(lastRtcIceServers);
            } else {
              lastRtcIceServers = null;
            }
          } else if (msg.type === "rtc.answer") {
            const current = rtcRef.current;
            const bindingRequired = true;
            if (
              current.sessionId &&
              current.bindingNonce &&
              (!bindingRequired || current.bindingGeneration !== null) &&
              current.pc &&
              rtcBindingFrameMatches(
                {
                  sessionId: current.sessionId,
                  bindingNonce: current.bindingNonce,
                  bindingGeneration: current.bindingGeneration,
                  agentId,
                },
                msg,
              )
            ) {
              const pc = current.pc;
              const acceptedBinding = {
                sessionId: current.sessionId,
                bindingNonce: current.bindingNonce,
                bindingGeneration: current.bindingGeneration,
              };
              const acceptedRtcGeneration = current.rtcGeneration;
              void pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).then(() => {
                const latest = rtcRef.current;
                if (
                  !isCurrentWs() ||
                  latest.pc !== pc ||
                  latest.agentId !== agentId ||
                  latest.agentGeneration !== agentGeneration ||
                  latest.rtcGeneration !== acceptedRtcGeneration ||
                  latest.sessionId !== acceptedBinding.sessionId ||
                  latest.bindingNonce !== acceptedBinding.bindingNonce ||
                  latest.bindingGeneration !== acceptedBinding.bindingGeneration
                )
                  return;
                const pending = pendingRemoteRtcCandidatesRef.current.splice(0);
                for (const candidate of pending) {
                  void pc.addIceCandidate(candidate).catch(() => {});
                }
              });
            }
          } else if (msg.type === "rtc.candidate") {
            const current = rtcRef.current;
            const bindingRequired = true;
            if (
              current.sessionId &&
              current.bindingNonce &&
              (!bindingRequired || current.bindingGeneration !== null) &&
              current.pc &&
              rtcBindingFrameMatches(
                {
                  sessionId: current.sessionId,
                  bindingNonce: current.bindingNonce,
                  bindingGeneration: current.bindingGeneration,
                  agentId,
                },
                msg,
              )
            ) {
              if (current.pc.remoteDescription) {
                void current.pc.addIceCandidate(msg.candidate).catch(() => {});
              } else {
                pendingRemoteRtcCandidatesRef.current.push(msg.candidate);
              }
            }
          } else if (msg.type === "rtc.status") {
            const current = rtcRef.current;
            if (
              msg.status === "negotiating" &&
              current.sessionId === msg.session_id &&
              current.bindingNonce === msg.binding_nonce &&
              current.bindingGeneration === null &&
              typeof msg.binding_generation === "number" &&
              Number.isSafeInteger(msg.binding_generation) &&
              msg.binding_generation > 0 &&
              msg.agent_id === agentId &&
              msg.scope_type === "agent" &&
              msg.scope_id === agentId &&
              msg.protocol === "spawn.pty" &&
              msg.protocol_version === 2
            ) {
              rtcRef.current = {
                ...current,
                bindingGeneration: msg.binding_generation,
              };
              return;
            }
            const exactPrebindFailure =
              current.bindingGeneration === null &&
              current.sessionId === msg.session_id &&
              current.bindingNonce === msg.binding_nonce &&
              msg.binding_generation === undefined;
            const exactBoundStatus =
              current.sessionId !== null &&
              current.bindingNonce !== null &&
              rtcBindingFrameMatches(
                {
                  sessionId: current.sessionId,
                  bindingNonce: current.bindingNonce,
                  bindingGeneration: current.bindingGeneration,
                  agentId,
                },
                msg,
              );
            if (
              msg.session_id &&
              (exactPrebindFailure || exactBoundStatus) &&
              ["failed", "disabled", "unavailable", "collision"].includes(msg.status)
            ) {
              cleanupRtc(false, msg.status !== "disabled");
            }
          }
        } else {
          ws.close(1002, "Binary content is forbidden on the signaling socket");
        }
      };
      ws.onerror = () => {
        if (!isCurrentWs()) return;
        setState("error");
      };
      ws.onclose = () => {
        if (!isCurrentAgentGeneration() || wsRef.current !== ws) return;
        cleanupRtc(false);
        wsRef.current = null;
        setState("closed");
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (!isActiveAgentGeneration()) return;
      attempt += 1;
      const delay = Math.min(10_000, 500 * attempt);
      reconnectTimer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rtcRetryTimer) clearTimeout(rtcRetryTimer);
      if (isCurrentAgentGeneration() && wsRef.current) {
        const ws = wsRef.current;
        try {
          cleanupRtc(true);
          wsRef.current = null;
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          ws.close(1000, "unmount");
        } catch {
          // ignore
        }
      }
      pendingInputRef.current.clear();
      if (isCurrentAgentGeneration()) activeAgentIdRef.current = null;
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
      const observed = rtcRef.current;
      const pc = observed.pc;
      if (!pc) return;
      let stats: RTCStatsReport;
      try {
        stats = await pc.getStats();
      } catch {
        return;
      }
      if (
        rtcRef.current.pc !== pc ||
        rtcRef.current.agentId !== observed.agentId ||
        rtcRef.current.agentGeneration !== observed.agentGeneration ||
        rtcRef.current.rtcGeneration !== observed.rtcGeneration
      ) {
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
    if (activeAgentIdRef.current !== agentId) return false;
    const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const rtc = rtcRef.current;
    if (rtc.open && rtc.ptyDc?.readyState === "open") {
      rtc.ptyDc.send(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
      return true;
    }
    return pendingInputRef.current.enqueue(agentGenerationRef.current, buf);
  };

  const sendJson = (msg: unknown) => {
    if (activeAgentIdRef.current !== agentId) return false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (typeof msg === "object" && msg !== null) {
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
