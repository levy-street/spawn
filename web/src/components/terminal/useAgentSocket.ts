"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeHistoryDelta } from "@/components/terminal/committed-history";
import {
  AGENT_CTL_MAX_PENDING_PTY_BYTES,
  AGENT_CTL_UPLOAD_BUFFER_HIGH_WATER,
  AGENT_CTL_UPLOAD_BUFFER_LOW_WATER,
  AGENT_CTL_UPLOAD_CHUNK_BYTES,
  type AgentCtlOperation,
  AgentCtlRequestTracker,
  type AgentCtlResponse,
  type AgentCtlTrackedResult,
  type AgentCtlUploadResult,
  type AgentCtlUploadStart,
  AgentGenerationInputQueue,
  DirectAgentUploadError,
  decodeAgentCtlChunk,
  encodeAgentCtlUploadChunk,
  makeAgentCtlRequest,
  makeAgentCtlUploadCancel,
  makeAgentCtlUploadStart,
  newAgentCtlRequestId,
  OrderedAsyncQueue,
  parseAgentCtlText,
  parseAgentCtlUploadResponse,
  sha256Blob,
  slicePtyChunkAfterAnchor,
} from "@/lib/agent-ctl";
import { SignedRtcLiveSession } from "@/lib/signed-rtc-live";
import type { SignedRtcRefusalReason, SignedRtcTrustDecision } from "@/lib/signed-rtc-trust";
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
  /** Resolve, once per RTC generation, whether this host requires signed
   * signaling, may use raw (unpinned TOFU first-contact), or must be refused.
   * Absence keeps every generation unsigned. */
  resolveSignedRtcTrust?: () => Promise<SignedRtcTrustDecision>;
  initialSize?: { cols: number; rows: number } | null;
  /** dcOffsetAfter is the cumulative DataChannel byte count including this
   *  chunk; every terminal byte arrives over the DataChannel. */
  onData: (bytes: Uint8Array, dcOffsetAfter?: number) => void;
  onHistory?: (
    bytes: Uint8Array,
    dcOffset?: number | null,
    historyAnchor?: { epoch: string; offset: number } | null,
  ) => void;
  onDisplayControl?: (state: DisplayControlState) => void;
  onExit?: (exitCode: number | null, signal: string | null) => void;
  onStatus?: (status: string) => void;
  /** dcOffset is the daemon-side DataChannel byte count at capture time for
   *  the CURRENT rtc session, or null when the snapshot has no usable anchor
   *  (stale session). historyAnchor is the committed-history stream position
   *  at capture, present only for delta-streaming workers. */
  onSnapshot?: (
    bytes: Uint8Array,
    plain: boolean,
    dcOffset?: number | null,
    historyAnchor?: { epoch: string; offset: number } | null,
  ) => void;
  /** The daemon refused or failed a snapshot request; there will be no
   *  payload. Without this the requester only learns via its own timeout. */
  onSnapshotError?: (message: string) => void;
  /** Committed-history delta stream (present after `history_subscribe` is
   *  acknowledged by a delta-capable daemon+worker pair). */
  onHistoryDelta?: (epoch: string, offset: number, bytes: Uint8Array) => void;
  onHistoryWipe?: (epoch: string) => void;
  onHistoryGap?: () => void;
}

export interface DirectAgentUploadOptions {
  name: string;
  mimeType: string;
  destination?: "attachments" | "cwd";
  signal?: AbortSignal;
  uploadId?: string;
  /** Re-check the caller's durable reservation before each upload_start
   *  attempt. Throwing prevents the endpoint request. */
  beforeUploadStart?: () => void;
  /** Called synchronously before the final frame is sent. Throwing prevents
   *  that frame from reaching the endpoint. */
  beforeFinalDispatch?: () => void;
  /** Called synchronously after the final frame is accepted by the channel.
   *  The caller must persist ambiguity before this component can unmount. */
  onFinalDispatched?: () => void;
}

export type SocketState = "idle" | "connecting" | "open" | "closed" | "error";

/** How the live connection's signaling was authenticated. */
export type SignalingTrustLevel = "verified" | "first_contact" | "raw";

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
// Covers a full connect plus one retry cycle before an early upload gives up.
const UPLOAD_READY_WAIT_MS = 20_000;
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
  resolveSignedRtcTrust,
  initialSize = null,
  onData,
  onHistory,
  onDisplayControl,
  onExit,
  onStatus,
  onSnapshot,
  onSnapshotError,
  onHistoryDelta,
  onHistoryWipe,
  onHistoryGap,
}: UseAgentSocketOptions) {
  const [state, setState] = useState<SocketState>("idle");
  // True after the one supported signaling protocol is negotiated.
  const [v2, setV2] = useState(false);
  // True after both DataChannels are open, the daemon has acknowledged their
  // shared readiness gate, and the initial replay has completed.
  const [dcOpen, setDcOpen] = useState(false);
  const [connInfo, setConnInfo] = useState<ConnInfo>(EMPTY_CONN_INFO);
  // Non-null when the last attempt was refused because the host identity could
  // not be verified against a local pin. A refusal is terminal (no auto-retry).
  const [signedRtcRefusal, setSignedRtcRefusal] = useState<SignedRtcRefusalReason | null>(null);
  // How the current connection's signaling was authenticated: "verified"
  // (signed, host pin matched), "first_contact" (signed TOFU on the claimed
  // key), or "raw" (unsigned legacy path). Null until a decision is made.
  const [signalingTrust, setSignalingTrust] = useState<SignalingTrustLevel | null>(null);
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
  const uploadRef = useRef<
    (blob: Blob, options: DirectAgentUploadOptions) => Promise<AgentCtlUploadResult>
  >(async () => {
    throw new Error("Direct agent upload channel is not ready.");
  });
  const cancelUploadsRef = useRef<(reason: Error) => void>(() => {});
  // Upload readiness latch. An upload requested before the ctl channel has
  // delivered its ready capability waits here instead of failing outright:
  // the window between the terminal becoming visible and readiness is real
  // (account/host identity and trust resolution precede the socket), and a
  // transient RTC teardown may still be followed by a retry that restores
  // readiness. Waiters are therefore never rejected by lifecycle churn — only
  // the caller's own abort signal or the bounded wait ends one early; a
  // staleness re-check after the wait rejects callers whose agent moved on.
  const uploadReadyRef = useRef(false);
  const uploadReadyWaitersRef = useRef(new Set<() => void>());
  const settleUploadReadiness = useCallback((ready: boolean) => {
    uploadReadyRef.current = ready;
    if (!ready) return;
    const waiters = [...uploadReadyWaitersRef.current];
    uploadReadyWaitersRef.current.clear();
    for (const waiter of waiters) waiter();
  }, []);
  const pendingRemoteRtcCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  // Per-offer trust resolution reads the latest resolver through this ref: a
  // change of resolver identity (e.g. the server's claimed host key arriving)
  // must inform the NEXT offer, not tear down a live connection.
  const resolveSignedRtcTrustRef = useRef(resolveSignedRtcTrust);
  resolveSignedRtcTrustRef.current = resolveSignedRtcTrust;
  const initialSizeRef = useRef(initialSize);
  const handlersRef = useRef({
    agentId,
    onData,
    onHistory,
    onDisplayControl,
    onExit,
    onStatus,
    onSnapshot,
    onSnapshotError,
    onHistoryDelta,
    onHistoryWipe,
    onHistoryGap,
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
    onSnapshotError,
    onHistoryDelta,
    onHistoryWipe,
    onHistoryGap,
  };

  useEffect(() => {
    const agentGeneration = agentGenerationRef.current + 1;
    agentGenerationRef.current = agentGeneration;
    pendingInputRef.current.clear();
    sendControlRef.current = () => false;
    uploadRef.current = async () => {
      throw new Error("Direct agent upload channel is not ready.");
    };
    settleUploadReadiness(false);
    cancelUploadsRef.current(new Error("Agent upload generation changed."));
    cancelUploadsRef.current = () => {};
    activeAgentIdRef.current = enabled && agentId ? agentId : null;
    setV2(false);
    setDcOpen(false);
    setSignalingTrust(null);
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
    let signedRtcSession: SignedRtcLiveSession | null = null;

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
      signedRtcSession?.abort();
      signedRtcSession = null;
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
      uploadRef.current = async () => {
        throw new Error("Direct agent upload channel is not ready.");
      };
      settleUploadReadiness(false);
      cancelUploadsRef.current(new Error("Direct agent upload channel closed."));
      cancelUploadsRef.current = () => {};
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
      // Omitting both partial-reliability fields is intentional: both agent
      // channels are fully reliable as well as ordered, and the daemon rejects
      // unordered, lifetime-limited, or retransmit-limited peers.
      const reliableOrderedChannel: RTCDataChannelInit = { ordered: true };
      const ptyDc = pc.createDataChannel("spawn.pty", reliableOrderedChannel);
      const ctlDc = pc.createDataChannel("spawn.ctl", reliableOrderedChannel);
      const pendingLocalCandidates: RTCIceCandidateInit[] = [];
      const pendingControlTexts: string[] = [];
      const requests = new AgentCtlRequestTracker();
      type UploadMessage = NonNullable<ReturnType<typeof parseAgentCtlUploadResponse>>;
      type PendingUpload = {
        expected: AgentCtlUploadStart;
        messages: UploadMessage[];
        controller: AbortController;
        cancel?: () => void;
        waiter:
          | {
              resolve: (message: UploadMessage) => void;
              reject: (error: Error) => void;
              timer: ReturnType<typeof setTimeout>;
            }
          | undefined;
      };
      const pendingUploads = new Map<string, PendingUpload>();
      const pendingBootstrapPty: Array<{ bytes: Uint8Array; offsetAfter: number }> = [];
      const pendingSnapshots: Array<{
        bytes: Uint8Array;
        plain: boolean;
        ptyOffset: number;
        historyAnchor: { epoch: string; offset: number } | null;
      }> = [];
      let pendingBootstrapPtyBytes = 0;
      let bootstrapDone = false;
      let bootstrapStarted = false;
      let serverReady = false;
      let uploadCapability: string | null = null;
      let uploadAgentGeneration: number | null = null;
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
      const rejectPendingUploads = (reason: Error) => {
        for (const pending of pendingUploads.values()) {
          pending.cancel?.();
          pending.controller.abort(reason);
          if (pending.waiter) {
            clearTimeout(pending.waiter.timer);
            pending.waiter.reject(reason);
          }
        }
        pendingUploads.clear();
      };
      cancelUploadsRef.current = rejectPendingUploads;

      const deliverUploadMessage = (
        response: Parameters<typeof parseAgentCtlUploadResponse>[0],
      ) => {
        const requestId = response.request_id;
        if (typeof requestId !== "string") return false;
        const pending = pendingUploads.get(requestId);
        if (!pending) return false;
        const message = parseAgentCtlUploadResponse(response, pending.expected);
        if (!message) return true;
        if (pending.controller.signal.aborted || !isCurrentRtcGeneration()) return true;
        if (pending.waiter) {
          const waiter = pending.waiter;
          pending.waiter = undefined;
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else if (pending.messages.length < 4) {
          pending.messages.push(message);
        }
        return true;
      };

      const waitUploadMessage = (
        uploadId: string,
        timeoutMs: number,
        signal: AbortSignal,
        invalidReason: () => Error | null,
      ): Promise<UploadMessage> => {
        const pending = pendingUploads.get(uploadId);
        if (!pending) return Promise.reject(new Error("Upload request is no longer active."));
        const invalid = invalidReason();
        if (invalid) return Promise.reject(invalid);
        const queued = pending.messages.shift();
        if (queued) return Promise.resolve(queued);
        if (pending.waiter) return Promise.reject(new Error("Upload response wait is duplicated."));
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            if (pending.waiter) {
              clearTimeout(pending.waiter.timer);
              pending.waiter = undefined;
            }
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Upload cancelled.", "AbortError"),
            );
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            pending.waiter = undefined;
            reject(invalidReason() ?? new Error("Direct upload response timed out."));
          }, timeoutMs);
          pending.waiter = {
            resolve: (message) => {
              signal.removeEventListener("abort", onAbort);
              const invalid = invalidReason();
              if (invalid) reject(invalid);
              else resolve(message);
            },
            reject: (error) => {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            },
            timer,
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      };

      const waitForUploadBackpressure = async (signal?: AbortSignal) => {
        if (ctlDc.bufferedAmount <= AGENT_CTL_UPLOAD_BUFFER_HIGH_WATER) return;
        ctlDc.bufferedAmountLowThreshold = AGENT_CTL_UPLOAD_BUFFER_LOW_WATER;
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>;
          const onLow = () => finish();
          const onAbort = () =>
            finish(
              signal?.reason instanceof Error
                ? signal.reason
                : new DOMException("Upload cancelled.", "AbortError"),
            );
          const finish = (error?: Error) => {
            clearTimeout(timer);
            ctlDc.removeEventListener("bufferedamountlow", onLow);
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve();
          };
          timer = setTimeout(() => finish(new Error("Direct upload channel stalled.")), 5000);
          ctlDc.addEventListener("bufferedamountlow", onLow, { once: true });
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      };

      const runUpload = async (
        blob: Blob,
        options: DirectAgentUploadOptions,
      ): Promise<AgentCtlUploadResult> => {
        const uploadContextError = (signal?: AbortSignal): Error | null => {
          if (signal?.aborted) {
            return signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Upload cancelled.", "AbortError");
          }
          const current = rtcRef.current;
          if (
            !isCurrentRtcGeneration() ||
            !current.open ||
            current.ctlDc !== ctlDc ||
            ctlDc.readyState !== "open"
          ) {
            return new Error("Direct agent upload channel closed.");
          }
          return null;
        };
        const assertUploadContext = (signal?: AbortSignal) => {
          const error = uploadContextError(signal);
          if (error) throw error;
        };
        assertUploadContext(options.signal);
        if (!uploadCapability || uploadAgentGeneration === null) {
          throw new Error("Direct agent upload channel is not ready.");
        }
        const sha256 = await sha256Blob(blob, () => assertUploadContext(options.signal));
        assertUploadContext(options.signal);
        if (!sha256) throw new Error("Could not securely hash the upload.");
        const uploadId = options.uploadId ?? newAgentCtlRequestId();
        const expected: AgentCtlUploadStart = {
          capability: uploadCapability,
          agentGeneration: uploadAgentGeneration,
          uploadId,
          name: options.name,
          mimeType: options.mimeType,
          destination: options.destination ?? "attachments",
          totalBytes: blob.size,
          chunks: Math.ceil(blob.size / AGENT_CTL_UPLOAD_CHUNK_BYTES),
          sha256,
        };
        const startText = makeAgentCtlUploadStart(expected);
        if (!startText) throw new Error("Upload metadata is outside protocol limits.");
        if (pendingUploads.has(uploadId)) throw new Error("Upload id is already active.");
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(options.signal?.reason);
        if (options.signal?.aborted) abortFromCaller();
        else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
        const uploadSignal = controller.signal;
        const invalidUploadReason = () => uploadContextError(uploadSignal);
        pendingUploads.set(uploadId, { expected, messages: [], controller, waiter: undefined });
        let startDispatched = false;
        let cancelSent = false;
        const sendCancel = () => {
          if (!startDispatched || cancelSent) return;
          cancelSent = true;
          const text = makeAgentCtlUploadCancel(
            newAgentCtlRequestId(),
            uploadId,
            expected.capability,
            expected.agentGeneration,
          );
          if (text && ctlDc.readyState === "open") {
            try {
              ctlDc.send(text);
            } catch {
              // Channel teardown performs the same cancellation at the endpoint.
            }
          }
        };
        const pending = pendingUploads.get(uploadId);
        if (pending) pending.cancel = sendCancel;
        const cancelOnAbort = () => sendCancel();
        uploadSignal.addEventListener("abort", cancelOnAbort, { once: true });
        if (uploadSignal.aborted) cancelOnAbort();
        let finalDispatched = false;
        const unknownAfterFinal = (error: unknown) => {
          if (error instanceof DirectAgentUploadError && error.code === "outcome_unknown") {
            return error;
          }
          const detail = error instanceof Error ? error.message : "upload acknowledgement was lost";
          return new DirectAgentUploadError(
            "outcome_unknown",
            `Upload may have been published; reconcile the destination before retrying. ${detail}`,
          );
        };
        try {
          let message: UploadMessage | null = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            assertUploadContext(uploadSignal);
            options.beforeUploadStart?.();
            assertUploadContext(uploadSignal);
            ctlDc.send(startText);
            startDispatched = true;
            try {
              message = await waitUploadMessage(uploadId, 5000, uploadSignal, invalidUploadReason);
              assertUploadContext(uploadSignal);
            } catch (error) {
              if (attempt < 2 && invalidUploadReason() === null) continue;
              throw error;
            }
            if (message.kind === "complete") return message.result;
            if (message.kind === "error") {
              throw new DirectAgentUploadError(message.code, message.message);
            }
            break;
          }
          if (!message || message.kind !== "ready") {
            throw new Error("Direct agent upload did not start after bounded retries.");
          }
          for (let sequence = message.nextSequence; sequence < expected.chunks; sequence += 1) {
            assertUploadContext(uploadSignal);
            await waitForUploadBackpressure(uploadSignal).catch((error) => {
              throw finalDispatched ? unknownAfterFinal(error) : error;
            });
            assertUploadContext(uploadSignal);
            const start = sequence * AGENT_CTL_UPLOAD_CHUNK_BYTES;
            const end = Math.min(start + AGENT_CTL_UPLOAD_CHUNK_BYTES, blob.size);
            const chunkBuffer = await blob.slice(start, end).arrayBuffer();
            const payload = new Uint8Array(chunkBuffer);
            let frame: ReturnType<typeof encodeAgentCtlUploadChunk>;
            try {
              assertUploadContext(uploadSignal);
              frame = encodeAgentCtlUploadChunk(
                uploadId,
                sequence,
                sequence + 1 === expected.chunks,
                payload,
              );
            } finally {
              payload.fill(0);
            }
            const isFinal = sequence + 1 === expected.chunks;
            if (!frame) throw new Error("Could not frame upload chunk.");
            assertUploadContext(uploadSignal);
            if (isFinal) {
              assertUploadContext(uploadSignal);
              options.beforeFinalDispatch?.();
              assertUploadContext(uploadSignal);
            }
            assertUploadContext(uploadSignal);
            ctlDc.send(frame.buffer as ArrayBuffer);
            if (isFinal) {
              finalDispatched = true;
              options.onFinalDispatched?.();
            }
          }
          try {
            message = await waitUploadMessage(uploadId, 30_000, uploadSignal, invalidUploadReason);
            assertUploadContext(uploadSignal);
          } catch (error) {
            throw finalDispatched ? unknownAfterFinal(error) : error;
          }
          if (message.kind === "complete") return message.result;
          if (message.kind === "error") {
            throw new DirectAgentUploadError(message.code, message.message);
          }
          throw finalDispatched
            ? unknownAfterFinal(new Error("Endpoint returned an invalid final upload response."))
            : new Error("Endpoint returned an invalid upload response.");
        } catch (error) {
          sendCancel();
          throw finalDispatched && !(error instanceof DirectAgentUploadError)
            ? unknownAfterFinal(error)
            : error;
        } finally {
          options.signal?.removeEventListener("abort", abortFromCaller);
          uploadSignal.removeEventListener("abort", cancelOnAbort);
          const pending = pendingUploads.get(uploadId);
          if (pending?.waiter) clearTimeout(pending.waiter.timer);
          pendingUploads.delete(uploadId);
        }
      };
      uploadRef.current = runUpload;
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
          !serverReady ||
          !bootstrapDone
        ) {
          return;
        }
        rtcRef.current = { ...current, open: true };
        clearRtcConnectTimer();
        rtcRetryAttempts = 0;
        // Only now is the upload context fully valid (channels open, server
        // ready, bootstrap done): release uploads that were waiting for it.
        settleUploadReadiness(true);
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

      const responseHistoryAnchor = (
        response: AgentCtlResponse,
      ): { epoch: string; offset: number } | null =>
        typeof response.history_epoch === "string" &&
        Number.isSafeInteger(response.history_offset) &&
        (response.history_offset as number) >= 0
          ? { epoch: response.history_epoch, offset: response.history_offset as number }
          : null;

      const flushPendingSnapshots = () => {
        if (!isCurrentRtcGeneration()) return;
        const received = rtcRef.current.bytesReceived;
        while (pendingSnapshots.length > 0 && pendingSnapshots[0].ptyOffset <= received) {
          const snapshot = pendingSnapshots.shift();
          if (!snapshot) break;
          currentHandlers()?.onSnapshot?.(
            snapshot.bytes,
            snapshot.plain,
            snapshot.ptyOffset,
            snapshot.historyAnchor,
          );
        }
      };

      const finishBootstrap = (
        bytes: Uint8Array,
        ptyOffset: number | null | undefined,
        historyAnchor: { epoch: string; offset: number } | null = null,
      ) => {
        if (bootstrapDone || !isCurrentRtcGeneration()) return;
        const anchor = typeof ptyOffset === "number" && ptyOffset >= 0 ? ptyOffset : 0;
        const handlers = currentHandlers();
        if (!handlers) return;
        if (handlers.onHistory) handlers.onHistory(bytes, ptyOffset, historyAnchor);
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
          } else if (!result.response.ok && result.response.operation === "snapshot") {
            const error = result.response.error;
            currentHandlers()?.onSnapshotError?.(
              `${error?.code ?? "snapshot_failed"}: ${error?.detail ?? "no detail"}`,
            );
          }
          return;
        }
        if (requestId === initialHistoryRequestId || result.response.operation === "history") {
          finishBootstrap(
            result.bytes,
            result.response.pty_offset,
            responseHistoryAnchor(result.response),
          );
        } else if (result.response.operation === "snapshot") {
          const ptyOffset =
            typeof result.response.pty_offset === "number" ? result.response.pty_offset : null;
          if (ptyOffset !== null && ptyOffset > rtcRef.current.bytesReceived) {
            if (pendingSnapshots.length < 8) {
              pendingSnapshots.push({
                bytes: result.bytes,
                plain: Boolean(result.response.plain),
                ptyOffset,
                historyAnchor: responseHistoryAnchor(result.response),
              });
            }
          } else {
            currentHandlers()?.onSnapshot?.(
              result.bytes,
              Boolean(result.response.plain),
              ptyOffset,
              responseHistoryAnchor(result.response),
            );
          }
        }
      };

      const startBootstrap = () => {
        const current = rtcRef.current;
        if (
          bootstrapStarted ||
          !serverReady ||
          !isCurrentRtcGeneration() ||
          !current.ptyOpen ||
          !current.ctlOpen
        ) {
          return;
        }
        bootstrapStarted = true;
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
        // Opt in to committed-history deltas. Old daemons answer with a
        // malformed_request error, which the tracker routes as a failed
        // response we simply ignore — delta mode never engages.
        sendControl("history_subscribe");
        markReady();
      };

      const sendControl = (
        operation: AgentCtlOperation,
        parameters: Record<string, unknown> = {},
      ): boolean => {
        if (!ctlDc || !isCurrentRtcGeneration()) return false;
        const requestId = newAgentCtlRequestId();
        const text = makeAgentCtlRequest(requestId, operation, parameters);
        if (!text) return false;
        const canSend = serverReady && ctlDc.readyState === "open";
        if (!canSend && pendingControlTexts.length >= 128) return false;
        if (!requests.register(requestId, operation)) return false;
        try {
          if (canSend) {
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
        startBootstrap();
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
          startBootstrap();
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
                if (message.event === "ready") {
                  uploadCapability = message.upload_capability;
                  uploadAgentGeneration = message.agent_generation;
                  serverReady = true;
                  startBootstrap();
                  return;
                }
                if (message.event === "history_delta") {
                  const bytes = decodeHistoryDelta(message.data);
                  if (bytes) {
                    currentHandlers()?.onHistoryDelta?.(
                      message.history_epoch,
                      message.history_offset,
                      bytes,
                    );
                  }
                  return;
                }
                if (message.event === "history_wipe") {
                  currentHandlers()?.onHistoryWipe?.(message.history_epoch);
                  return;
                }
                if (message.event === "history_gap") {
                  currentHandlers()?.onHistoryGap?.();
                  return;
                }
                currentHandlers()?.onDisplayControl?.({
                  owner: message.owner,
                  cols: message.cols,
                  rows: message.rows,
                  viewers: message.viewers,
                });
                return;
              }
              if (!deliverUploadMessage(message)) {
                acceptTrackedResult(requests.acceptResponse(message));
              }
            },
          );
        };
      }

      try {
        // Resolve trust BEFORE creating the offer. The decision reads IndexedDB,
        // and doing it after setLocalDescription delays the offer — which delays
        // the daemon's own ICE gathering, so its host/srflx candidates arrive
        // late and ICE can nominate a relay pair first. Deciding first keeps the
        // signalling path latency-free.
        let signedRtcDecision: SignedRtcTrustDecision = { mode: "unpinned" };
        // Read through the ref so every offer resolves with the freshest trust
        // inputs without the resolver's identity churning the connection.
        const resolveTrust = resolveSignedRtcTrustRef.current;
        if (resolveTrust) {
          try {
            signedRtcDecision = await resolveTrust();
          } catch {
            // A resolver failure must fail closed for a possibly-pinned host.
            signedRtcDecision = { mode: "refuse", reason: "pin_storage_error" };
          }
          if (!isCurrentRtcGeneration()) return;
        }
        if (signedRtcDecision.mode === "refuse") {
          // The host identity could not be verified against a local pin. Refuse
          // outright: never fall back to a raw, unauthenticated path, and do not
          // auto-retry until the local trust state changes.
          setSignedRtcRefusal(signedRtcDecision.reason);
          setState("error");
          lastRtcIceServers = null;
          cleanupRtc(true, false, rtcGeneration);
          return;
        }
        setSignedRtcRefusal(null);
        setSignalingTrust(
          signedRtcDecision.mode === "signed"
            ? signedRtcDecision.hostVerified
              ? "verified"
              : "first_contact"
            : "raw",
        );

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!isCurrentRtcGeneration()) return;
        const nextSignedRtcSession =
          signedRtcDecision.mode === "signed"
            ? new SignedRtcLiveSession(
                {
                  scopeType: "agent",
                  scopeId: agentId,
                  protocol: "spawn.pty",
                  protocolVersion: 2,
                },
                sessionId,
                signedRtcDecision.capability,
              )
            : null;
        const carrier = nextSignedRtcSession
          ? await nextSignedRtcSession.createOffer(offer.sdp ?? "")
          : { sdp: offer.sdp };
        if (!isCurrentRtcGeneration()) return;
        signedRtcSession = nextSignedRtcSession;
        if (
          !sendJsonOverWs({
            type: "rtc.offer",
            session_id: sessionId,
            binding_nonce: bindingNonce,
            ...boundAgentRtcTuple,
            ...carrier,
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
          if (!msg) {
            if (signedRtcSession) cleanupRtc(true, true, rtcRef.current.rtcGeneration);
            return;
          }
          if (msg.type === "agent.exit") {
            h.onExit?.(msg.exit_code, msg.signal);
          } else if (msg.type === "agent.status") {
            h.onStatus?.(msg.status);
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
            if (current.pc && signedRtcSession) {
              const pc = current.pc;
              const acceptedBinding = {
                sessionId: current.sessionId,
                bindingNonce: current.bindingNonce,
                bindingGeneration: current.bindingGeneration,
              };
              const acceptedRtcGeneration = current.rtcGeneration;
              if (
                !current.sessionId ||
                !current.bindingNonce ||
                current.bindingGeneration === null ||
                !rtcBindingFrameMatches(
                  {
                    sessionId: current.sessionId,
                    bindingNonce: current.bindingNonce,
                    bindingGeneration: current.bindingGeneration,
                    agentId,
                  },
                  msg,
                )
              ) {
                cleanupRtc(true, true, acceptedRtcGeneration);
                return;
              }
              void signedRtcSession
                .verifyAndApplyAnswer(pc, msg)
                .then(() => {
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
                })
                .catch(() => cleanupRtc(true, true, acceptedRtcGeneration));
            } else if (
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
              if (typeof msg.sdp !== "string") {
                cleanupRtc(true, true, acceptedRtcGeneration);
                return;
              }
              void pc
                .setRemoteDescription({ type: "answer", sdp: msg.sdp })
                .then(() => {
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
                })
                .catch(() => cleanupRtc(true, true, acceptedRtcGeneration));
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
  }, [agentId, enabled, settleUploadReadiness]);

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

  const waitForUploadReadiness = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const abortError = () =>
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Upload cancelled.", "AbortError");
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const waiter = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        uploadReadyWaitersRef.current.delete(waiter);
        cleanup();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        uploadReadyWaitersRef.current.delete(waiter);
        cleanup();
        reject(new Error("Direct agent upload channel is not ready."));
      }, UPLOAD_READY_WAIT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      uploadReadyWaitersRef.current.add(waiter);
    });

  const uploadFile = async (blob: Blob, options: DirectAgentUploadOptions) => {
    if (!uploadReadyRef.current) await waitForUploadReadiness(options.signal);
    // A caller holding this hook's return from an earlier agent must not
    // dispatch into the current agent's channel — re-checked after the wait
    // because readiness may have been restored by a successor generation.
    if (activeAgentIdRef.current !== agentId) {
      throw new Error("Agent upload generation changed.");
    }
    return uploadRef.current(blob, options);
  };

  return {
    state,
    v2,
    dcOpen,
    connInfo,
    signedRtcRefusal,
    signalingTrust,
    sendBinary,
    sendJson,
    uploadFile,
  };
}
