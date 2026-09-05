"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  getBrowserHostPinRevision,
  subscribeToBrowserHostPinChanges,
} from "@/lib/browser-host-pins";
import type { CarriedEndorsement } from "@/lib/hostControl";
import {
  DirectSessionUploadError,
  decodeSessionCtlChunk,
  encodeSessionCtlUploadChunk,
  makeSessionCtlRequest,
  makeSessionCtlUploadCancel,
  makeSessionCtlUploadStart,
  newSessionCtlRequestId,
  OrderedAsyncQueue,
  parseSessionCtlText,
  parseSessionCtlUploadResponse,
  SESSION_CTL_MAX_PENDING_PTY_BYTES,
  SESSION_CTL_UPLOAD_BUFFER_HIGH_WATER,
  SESSION_CTL_UPLOAD_BUFFER_LOW_WATER,
  SESSION_CTL_UPLOAD_CHUNK_BYTES,
  SESSION_PTY_INPUT_BUFFER_HIGH_WATER,
  SESSION_PTY_INPUT_BUFFER_LOW_WATER,
  type SessionCtlOperation,
  SessionCtlRequestTracker,
  type SessionCtlResponse,
  type SessionCtlTrackedResult,
  type SessionCtlUploadResult,
  type SessionCtlUploadStart,
  SessionGenerationInputQueue,
  sha256Blob,
  slicePtyChunkAfterAnchor,
  writeSessionPtyInput,
} from "@/lib/session-ctl";
import { SignedRtcLiveSession } from "@/lib/signed-rtc-live";
import type { SignedRtcRefusalReason, SignedRtcTrustDecision } from "@/lib/signed-rtc-trust";
import {
  backoffDelay,
  buildSessionWsUrl,
  type DisplayControlState,
  iceServersNeedRefresh,
  notifySocketUnauthorized,
  parseInbound,
  RTC_LATCH_TIMEOUT_MS,
  rtcBindingFrameMatches,
  SIGNAL_SILENCE_SUSPECT_MS,
  SPAWN_WS_SUBPROTOCOL,
  sanitizeIceServers,
  sessionRtcTuple,
  socketCloseAction,
  watchSuspendResume,
} from "@/lib/ws";

/**
 * Lifecycle hook for the per-session browser WS.
 *
 * Manages connect, reconnect (linear backoff up to 10s), and surface state
 * via callbacks.  The caller is responsible for actually wiring `onData` to
 * the xterm.js instance (we keep this hook framework-agnostic so it could
 * also maintain local replay state).
 */
export interface UseSessionSocketOptions {
  sessionId: string;
  enabled?: boolean;
  /** Foreground panes collect transport stats; parked warm panes keep the
   * connection but stay computationally quiet. */
  active?: boolean;
  /** Resolve, once per RTC generation, whether this host requires signed
   * signaling, may use raw (unpinned TOFU first-contact), or must be refused.
   * Absence keeps every generation unsigned. */
  resolveSignedRtcTrust?: () => Promise<SignedRtcTrustDecision>;
  /** Account endorsement edges to carry on the offer so a daemon that does not
   * directly pin this browser can admit it via a chain to an anchor (§3). */
  loadCarriedEndorsements?: () => Promise<CarriedEndorsement[]>;
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
}

export interface DirectSessionUploadOptions {
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
  /** Bytes handed to the channel so far, out of the upload's total. Fires
   *  once per chunk (plus once at 0 when the endpoint is ready), so a caller
   *  can drive a progress indicator. */
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}

export type SocketState =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error"
  | "unauthorized"
  | "disabled";

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
  sessionId: string | null;
  sessionGeneration: number;
  rtcGeneration: number;
  pc: RTCPeerConnection | null;
  ptyDc: RTCDataChannel | null;
  ctlDc: RTCDataChannel | null;
  rtcSessionId: string | null;
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
const RTC_ICE_RESTART_TIMEOUT_MS = 10_000;
const RTC_CONFIG_REFRESH_TIMEOUT_MS = 2_000;
const RTC_RESUME_TIMEOUT_MS = 3_000;
const SIGNAL_WATCHDOG_MS = 80_000;
// Retry failed WebRTC attempts with backoff; there is no content fallback.
const RTC_RETRY_BASE_DELAY_MS = 5_000;
const RTC_RETRY_MAX_DELAY_MS = 60_000;
// Keystrokes typed before the DataChannel opens are held briefly and flushed
// on open. Cap the buffer so a dead channel cannot grow it without bound.
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const MAX_PENDING_INPUT_AGE_MS = 30_000;

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

export function useSessionSocket({
  sessionId,
  enabled = true,
  active = true,
  resolveSignedRtcTrust,
  loadCarriedEndorsements,
  initialSize = null,
  onData,
  onHistory,
  onDisplayControl,
  onExit,
  onStatus,
  onSnapshot,
  onSnapshotError,
}: UseSessionSocketOptions) {
  const [state, setState] = useState<SocketState>("idle");
  // True after the one supported signaling protocol is negotiated.
  const [v3, setV3] = useState(false);
  // True after both DataChannels are open, the daemon has acknowledged their
  // shared readiness gate, and the initial replay has completed.
  const [dcOpen, setDcOpen] = useState(false);
  const [connInfo, setConnInfo] = useState<ConnInfo>(EMPTY_CONN_INFO);
  const [queuedInputCount, setQueuedInputCount] = useState(0);
  // Non-null when the last attempt was refused because the host identity could
  // not be verified against a local pin. A refusal is terminal (no auto-retry).
  const [signedRtcRefusal, setSignedRtcRefusal] = useState<SignedRtcRefusalReason | null>(null);
  // How the current connection's signaling was authenticated: "verified"
  // (signed, host pin matched), "first_contact" (signed TOFU on the claimed
  // key), or "raw" (unsigned legacy path). Null until a decision is made.
  const [signalingTrust, setSignalingTrust] = useState<SignalingTrustLevel | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const rtcGenerationRef = useRef(0);
  const pendingInputRef = useRef(new SessionGenerationInputQueue(MAX_PENDING_INPUT_BYTES));
  const pendingInputExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rtcRef = useRef<RtcState>({
    sessionId: null,
    sessionGeneration: 0,
    rtcGeneration: 0,
    pc: null,
    ptyDc: null,
    ctlDc: null,
    rtcSessionId: null,
    ptyOpen: false,
    ctlOpen: false,
    bindingNonce: null,
    bindingGeneration: null,
    open: false,
    bytesReceived: 0,
  });
  const sendControlRef = useRef<
    (operation: SessionCtlOperation, parameters?: Record<string, unknown>) => boolean
  >(() => false);
  const sendPtyInputRef = useRef<(bytes: Uint8Array) => boolean>(() => false);
  const uploadRef = useRef<
    (blob: Blob, options: DirectSessionUploadOptions) => Promise<SessionCtlUploadResult>
  >(async () => {
    throw new Error("Direct session upload channel is not ready.");
  });
  const cancelUploadsRef = useRef<(reason: Error) => void>(() => {});
  // Upload readiness latch. An upload requested before the ctl channel has
  // delivered its ready capability waits here instead of failing outright:
  // the window between the terminal becoming visible and readiness is real
  // (account/host identity and trust resolution precede the socket), and a
  // transient RTC teardown may still be followed by a retry that restores
  // readiness. Waiters are therefore never rejected by lifecycle churn — only
  // the caller's own abort signal or the bounded wait ends one early; a
  // staleness re-check after the wait rejects callers whose session moved on.
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
  // A trust refusal stops reconnecting on purpose — retrying against an
  // unverifiable host would be the wrong kind of persistence. But the copy on
  // screen tells the reader that re-possessing the host brings the pane back,
  // and with the warm terminal pool keeping panes mounted across navigation,
  // nothing here ever noticed that they had. Local trust changes now move a
  // revision, and this connect effect lists it as a dependency: approving a
  // pin tears the effect down and runs it again with a fresh
  // `reconnectStopped`, so the pane reconnects instead of waiting for a
  // full page reload.
  const hostPinRevision = useSyncExternalStore(
    subscribeToBrowserHostPinChanges,
    getBrowserHostPinRevision,
    () => 0,
  );
  const loadCarriedEndorsementsRef = useRef(loadCarriedEndorsements);
  loadCarriedEndorsementsRef.current = loadCarriedEndorsements;
  const initialSizeRef = useRef(initialSize);
  const handlersRef = useRef({
    sessionId,
    onData,
    onHistory,
    onDisplayControl,
    onExit,
    onStatus,
    onSnapshot,
    onSnapshotError,
  });
  initialSizeRef.current = initialSize;
  handlersRef.current = {
    sessionId,
    onData,
    onHistory,
    onDisplayControl,
    onExit,
    onStatus,
    onSnapshot,
    onSnapshotError,
  };

  const updateQueuedInputState = useCallback(() => {
    const generation = sessionGenerationRef.current;
    pendingInputRef.current.prune(generation, MAX_PENDING_INPUT_AGE_MS);
    setQueuedInputCount(pendingInputRef.current.count(generation));
  }, []);

  const armPendingInputExpiry = useCallback(() => {
    if (pendingInputExpiryTimerRef.current) clearTimeout(pendingInputExpiryTimerRef.current);
    const schedule = () => {
      const generation = sessionGenerationRef.current;
      const oldest = pendingInputRef.current.oldestEnqueuedAt(generation);
      if (oldest === null) {
        pendingInputExpiryTimerRef.current = null;
        return;
      }
      pendingInputExpiryTimerRef.current = setTimeout(
        () => {
          pendingInputRef.current.prune(generation, MAX_PENDING_INPUT_AGE_MS);
          setQueuedInputCount(pendingInputRef.current.count(generation));
          schedule();
        },
        Math.max(1, oldest + MAX_PENDING_INPUT_AGE_MS - Date.now()),
      );
    };
    schedule();
  }, []);

  // `hostPinRevision` is a re-run trigger, not a value this effect reads: local
  // trust changed, so the connection has to be decided again — including the
  // refusal that set `reconnectStopped` and would otherwise never be revisited.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run trigger, not a read
  useEffect(() => {
    const sessionGeneration = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = sessionGeneration;
    pendingInputRef.current.clear();
    if (pendingInputExpiryTimerRef.current) clearTimeout(pendingInputExpiryTimerRef.current);
    pendingInputExpiryTimerRef.current = null;
    setQueuedInputCount(0);
    sendControlRef.current = () => false;
    sendPtyInputRef.current = () => false;
    uploadRef.current = async () => {
      throw new Error("Direct session upload channel is not ready.");
    };
    settleUploadReadiness(false);
    cancelUploadsRef.current(new Error("Session upload generation changed."));
    cancelUploadsRef.current = () => {};
    activeSessionIdRef.current = enabled && sessionId ? sessionId : null;
    setV3(false);
    setDcOpen(false);
    setSignalingTrust(null);
    if (!enabled || !sessionId) return;
    let cancelled = false;
    let reconnectStopped = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let signalWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcStartInFlight = false;
    let rtcStartLatchedAt = 0;
    let rtcConnectTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcDisconnectedTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcIceRestartTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcResumeTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcConfigRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcConfigRefreshResolve: (() => void) | null = null;
    let iceRestartInFlight = false;
    let iceRestartLatchedAt = 0;
    let resumeInFlight = false;
    /** When the server was last heard on the current socket, whatever kind of
     * frame it was. A socket claiming OPEN with nothing heard for longer than
     * `SIGNAL_SILENCE_SUSPECT_MS` is a corpse a sleep left behind. */
    let lastSignalFrameAt = 0;
    let rtcRetryAttempts = 0;
    let lastRtcIceServers: RTCIceServer[] | null = null;
    /** The deployment's answer to "is there a direct path?", from `rtc.config`. */
    let lastRtcTransportPolicy: RTCIceTransportPolicy = "all";
    let signedRtcSession: SignedRtcLiveSession | null = null;
    let signedRtcRequired = false;
    let signedRtcDecisionForBinding: SignedRtcTrustDecision | null = null;
    let prefetchedTrustDecision: Promise<SignedRtcTrustDecision> | null = null;
    let blockCurrentLocalCandidates: (() => void) | null = null;
    let releaseCurrentLocalCandidates: (() => void) | null = null;

    const isCurrentSessionGeneration = () => sessionGenerationRef.current === sessionGeneration;
    const isActiveSessionGeneration = () => !cancelled && isCurrentSessionGeneration();
    const currentHandlers = () =>
      isActiveSessionGeneration() && handlersRef.current.sessionId === sessionId
        ? handlersRef.current
        : null;

    const resolveTrustDecision = async (): Promise<SignedRtcTrustDecision> => {
      const resolveTrust = resolveSignedRtcTrustRef.current;
      if (!resolveTrust) return { mode: "unpinned" };
      try {
        return await resolveTrust();
      } catch {
        return { mode: "refuse", reason: "pin_storage_error" };
      }
    };
    const prefetchTrustDecision = () => {
      if (resolveSignedRtcTrustRef.current) {
        prefetchedTrustDecision ??= resolveTrustDecision();
      }
    };

    const sendJsonOverWs = (msg: unknown) => {
      if (!isCurrentSessionGeneration()) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    };
    const boundSessionRtcTuple = sessionRtcTuple(sessionId);

    const clearRtcConnectTimer = () => {
      if (rtcConnectTimer) clearTimeout(rtcConnectTimer);
      rtcConnectTimer = null;
    };

    const clearRtcDisconnectedTimer = () => {
      if (rtcDisconnectedTimer) clearTimeout(rtcDisconnectedTimer);
      rtcDisconnectedTimer = null;
    };

    const clearRtcIceRestartTimer = () => {
      if (rtcIceRestartTimer) clearTimeout(rtcIceRestartTimer);
      rtcIceRestartTimer = null;
      iceRestartInFlight = false;
    };

    const clearRtcResumeTimer = () => {
      if (rtcResumeTimer) clearTimeout(rtcResumeTimer);
      rtcResumeTimer = null;
      resumeInFlight = false;
    };

    const finishRtcConfigRefresh = () => {
      if (rtcConfigRefreshTimer) clearTimeout(rtcConfigRefreshTimer);
      rtcConfigRefreshTimer = null;
      const resolve = rtcConfigRefreshResolve;
      rtcConfigRefreshResolve = null;
      resolve?.();
    };

    const cleanupRtc = (signal = true, retry = false, expectedRtcGeneration?: number) => {
      const rtc = rtcRef.current;
      if (
        rtc.sessionId !== sessionId ||
        rtc.sessionGeneration !== sessionGeneration ||
        (expectedRtcGeneration !== undefined && rtc.rtcGeneration !== expectedRtcGeneration)
      ) {
        return;
      }
      const rtcSessionId = rtc.rtcSessionId;
      const bindingNonce = rtc.bindingNonce;
      clearRtcConnectTimer();
      clearRtcDisconnectedTimer();
      clearRtcIceRestartTimer();
      clearRtcResumeTimer();
      if (signal && rtcSessionId && bindingNonce) {
        sendJsonOverWs({
          type: "rtc.close",
          session_id: rtcSessionId,
          binding_nonce: bindingNonce,
          ...boundSessionRtcTuple,
        });
      }
      rtcRef.current = {
        sessionId: null,
        sessionGeneration: 0,
        rtcGeneration: 0,
        pc: null,
        ptyDc: null,
        ctlDc: null,
        rtcSessionId: null,
        ptyOpen: false,
        ctlOpen: false,
        bindingNonce: null,
        bindingGeneration: null,
        open: false,
        bytesReceived: 0,
      };
      signedRtcSession?.abort();
      signedRtcSession = null;
      signedRtcRequired = false;
      signedRtcDecisionForBinding = null;
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
      sendPtyInputRef.current = () => false;
      uploadRef.current = async () => {
        throw new Error("Direct session upload channel is not ready.");
      };
      settleUploadReadiness(false);
      cancelUploadsRef.current(new Error("Direct session upload channel closed."));
      cancelUploadsRef.current = () => {};
      pendingRemoteRtcCandidatesRef.current = [];
      blockCurrentLocalCandidates = null;
      releaseCurrentLocalCandidates = null;
      rtcStartInFlight = false;
      if (isCurrentSessionGeneration()) setDcOpen(false);
      if (retry) scheduleRtcRetry();
    };

    // Retry transient WebRTC failures without opening a content fallback.
    const scheduleRtcRetry = () => {
      if (!isActiveSessionGeneration() || rtcRetryTimer || !lastRtcIceServers) return;
      const delay = Math.min(
        RTC_RETRY_MAX_DELAY_MS,
        RTC_RETRY_BASE_DELAY_MS * 2 ** rtcRetryAttempts,
      );
      rtcRetryAttempts += 1;
      rtcRetryTimer = setTimeout(() => {
        rtcRetryTimer = null;
        if (!isActiveSessionGeneration() || rtcRef.current.pc) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        if (lastRtcIceServers) void startRtcWithLatest();
      }, delay);
    };

    const startRtc = async (iceServers: RTCIceServer[]) => {
      if (!isActiveSessionGeneration()) return;
      if (rtcStartInFlight) {
        // Held past its deadline, the latch marks an attempt frozen mid-await
        // (a trust read or createOffer that a suspend left never settling),
        // not one still working — and honouring it would turn every retry
        // entry into a no-op forever. Tear the husk down and start over.
        if (Date.now() - rtcStartLatchedAt < RTC_LATCH_TIMEOUT_MS) return;
        cleanupRtc(false);
      }
      if (rtcRef.current.pc) return;
      if (typeof RTCPeerConnection === "undefined") return;
      rtcStartInFlight = true;
      rtcStartLatchedAt = Date.now();
      const rtcGeneration = rtcGenerationRef.current + 1;
      rtcGenerationRef.current = rtcGeneration;
      const rtcSessionId = newRtcSessionId();
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
      // A relay-only deployment says the same thing for real, in `rtc.config`.
      const forceRelay =
        typeof window !== "undefined" &&
        (window as { __spawnRtcForceRelay?: boolean }).__spawnRtcForceRelay === true;
      let pc: RTCPeerConnection;
      let ptyDc: RTCDataChannel;
      let ctlDc: RTCDataChannel;
      try {
        pc = new RTCPeerConnection({
          iceServers: sanitizeIceServers(iceServers),
          iceTransportPolicy: forceRelay ? "relay" : lastRtcTransportPolicy,
          iceCandidatePoolSize: 1,
        });
        // Omitting both partial-reliability fields is intentional: both session
        // channels are fully reliable as well as ordered, and the daemon rejects
        // unordered, lifetime-limited, or retransmit-limited peers.
        const reliableOrderedChannel: RTCDataChannelInit = { ordered: true };
        ptyDc = pc.createDataChannel("spawn.pty", reliableOrderedChannel);
        ctlDc = pc.createDataChannel("spawn.ctl", reliableOrderedChannel);
      } catch {
        rtcStartInFlight = false;
        scheduleRtcRetry();
        return;
      }
      const pendingLocalCandidates: RTCIceCandidateInit[] = [];
      const pendingControlTexts: string[] = [];
      const requests = new SessionCtlRequestTracker();
      type UploadMessage = NonNullable<ReturnType<typeof parseSessionCtlUploadResponse>>;
      type PendingUpload = {
        expected: SessionCtlUploadStart;
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
      let uploadSessionGeneration: number | null = null;
      let bootstrapPtyAnchor: number | null = null;
      let bootstrapRequestedOffset: number | null = null;
      let initialHistoryRequestId: string | null = null;
      let offerSent = false;
      const isCurrentRtcGeneration = () => {
        const current = rtcRef.current;
        return (
          isActiveSessionGeneration() &&
          current.sessionId === sessionId &&
          current.sessionGeneration === sessionGeneration &&
          current.rtcGeneration === rtcGeneration &&
          current.rtcSessionId === rtcSessionId
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
        response: Parameters<typeof parseSessionCtlUploadResponse>[0],
      ) => {
        const requestId = response.request_id;
        if (typeof requestId !== "string") return false;
        const pending = pendingUploads.get(requestId);
        if (!pending) return false;
        const message = parseSessionCtlUploadResponse(response, pending.expected);
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
        if (ctlDc.bufferedAmount <= SESSION_CTL_UPLOAD_BUFFER_HIGH_WATER) return;
        ctlDc.bufferedAmountLowThreshold = SESSION_CTL_UPLOAD_BUFFER_LOW_WATER;
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
        options: DirectSessionUploadOptions,
      ): Promise<SessionCtlUploadResult> => {
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
            return new Error("Direct session upload channel closed.");
          }
          return null;
        };
        const assertUploadContext = (signal?: AbortSignal) => {
          const error = uploadContextError(signal);
          if (error) throw error;
        };
        assertUploadContext(options.signal);
        if (!uploadCapability || uploadSessionGeneration === null) {
          throw new Error("Direct session upload channel is not ready.");
        }
        const sha256 = await sha256Blob(blob, () => assertUploadContext(options.signal));
        assertUploadContext(options.signal);
        if (!sha256) throw new Error("Could not securely hash the upload.");
        const uploadId = options.uploadId ?? newSessionCtlRequestId();
        const expected: SessionCtlUploadStart = {
          capability: uploadCapability,
          sessionGeneration: uploadSessionGeneration,
          uploadId,
          name: options.name,
          mimeType: options.mimeType,
          destination: options.destination ?? "attachments",
          totalBytes: blob.size,
          chunks: Math.ceil(blob.size / SESSION_CTL_UPLOAD_CHUNK_BYTES),
          sha256,
        };
        const startText = makeSessionCtlUploadStart(expected);
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
          const text = makeSessionCtlUploadCancel(
            newSessionCtlRequestId(),
            uploadId,
            expected.capability,
            expected.sessionGeneration,
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
          if (error instanceof DirectSessionUploadError && error.code === "outcome_unknown") {
            return error;
          }
          const detail = error instanceof Error ? error.message : "upload acknowledgement was lost";
          return new DirectSessionUploadError(
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
              throw new DirectSessionUploadError(message.code, message.message);
            }
            break;
          }
          if (!message || message.kind !== "ready") {
            throw new Error("Direct session upload did not start after bounded retries.");
          }
          // A resumed upload starts part-way in; report that floor before the
          // first chunk so progress never jumps backwards.
          options.onProgress?.(
            Math.min(blob.size, message.nextSequence * SESSION_CTL_UPLOAD_CHUNK_BYTES),
            blob.size,
          );
          for (let sequence = message.nextSequence; sequence < expected.chunks; sequence += 1) {
            assertUploadContext(uploadSignal);
            await waitForUploadBackpressure(uploadSignal).catch((error) => {
              throw finalDispatched ? unknownAfterFinal(error) : error;
            });
            assertUploadContext(uploadSignal);
            const start = sequence * SESSION_CTL_UPLOAD_CHUNK_BYTES;
            const end = Math.min(start + SESSION_CTL_UPLOAD_CHUNK_BYTES, blob.size);
            const chunkBuffer = await blob.slice(start, end).arrayBuffer();
            const payload = new Uint8Array(chunkBuffer);
            let frame: ReturnType<typeof encodeSessionCtlUploadChunk>;
            try {
              assertUploadContext(uploadSignal);
              frame = encodeSessionCtlUploadChunk(
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
            options.onProgress?.(end, blob.size);
          }
          try {
            message = await waitUploadMessage(uploadId, 30_000, uploadSignal, invalidUploadReason);
            assertUploadContext(uploadSignal);
          } catch (error) {
            throw finalDispatched ? unknownAfterFinal(error) : error;
          }
          if (message.kind === "complete") return message.result;
          if (message.kind === "error") {
            throw new DirectSessionUploadError(message.code, message.message);
          }
          throw finalDispatched
            ? unknownAfterFinal(new Error("Endpoint returned an invalid final upload response."))
            : new Error("Endpoint returned an invalid upload response.");
        } catch (error) {
          sendCancel();
          throw finalDispatched && !(error instanceof DirectSessionUploadError)
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
        sessionId,
        sessionGeneration,
        rtcGeneration,
        pc,
        ptyDc,
        ctlDc,
        rtcSessionId,
        ptyOpen: false,
        ctlOpen: false,
        bindingNonce,
        bindingGeneration: null,
        open: false,
        bytesReceived: 0,
      };

      const sendPtyChunks = (bytes: Uint8Array): number => {
        return writeSessionPtyInput(ptyDc, bytes);
      };

      const flushPendingInput = () => {
        if (!isCurrentRtcGeneration() || ptyDc.readyState !== "open") return;
        const queued = pendingInputRef.current.take(sessionGeneration, MAX_PENDING_INPUT_AGE_MS);
        for (let index = 0; index < queued.length; index += 1) {
          const entry = queued[index];
          const sent = sendPtyChunks(entry.bytes);
          if (sent < entry.bytes.byteLength) {
            pendingInputRef.current.enqueue(
              sessionGeneration,
              entry.bytes.subarray(sent),
              entry.enqueuedAt,
            );
            for (const remaining of queued.slice(index + 1)) {
              pendingInputRef.current.enqueue(
                sessionGeneration,
                remaining.bytes,
                remaining.enqueuedAt,
              );
            }
            break;
          }
        }
        ptyDc.bufferedAmountLowThreshold = SESSION_PTY_INPUT_BUFFER_LOW_WATER;
        updateQueuedInputState();
        if (pendingInputRef.current.count(sessionGeneration) > 0) armPendingInputExpiry();
      };

      sendPtyInputRef.current = (bytes) => {
        if (!isCurrentRtcGeneration()) return false;
        const alreadyQueued = pendingInputRef.current.count(sessionGeneration) > 0;
        const sent = alreadyQueued ? 0 : sendPtyChunks(bytes);
        const accepted =
          sent === bytes.byteLength ||
          pendingInputRef.current.enqueue(sessionGeneration, bytes.subarray(sent));
        updateQueuedInputState();
        if (pendingInputRef.current.count(sessionGeneration) > 0) {
          armPendingInputExpiry();
          if (ptyDc.bufferedAmount <= SESSION_PTY_INPUT_BUFFER_HIGH_WATER) {
            setTimeout(flushPendingInput, 0);
          }
        }
        return accepted;
      };
      ptyDc.bufferedAmountLowThreshold = SESSION_PTY_INPUT_BUFFER_LOW_WATER;
      ptyDc.onbufferedamountlow = flushPendingInput;

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
        if (isCurrentSessionGeneration()) setDcOpen(true);
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
        response: SessionCtlResponse,
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

      const acceptTrackedResult = (result: SessionCtlTrackedResult | null) => {
        if (!result || !isCurrentRtcGeneration()) return;
        if (result.kind === "rejected") {
          // A reply this client will not assemble is a wire disagreement, not
          // silence: say so, and never leave the pane waiting on it. The
          // connect-time history falls back to an empty seed so the terminal
          // still opens; the live stream fills it from here.
          console.warn(`SPAWN D: spawn.ctl ${result.operation} reply rejected: ${result.reason}`);
          if (result.requestId === initialHistoryRequestId) finishBootstrap(new Uint8Array(), 0);
          return;
        }
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
        if (requestId === initialHistoryRequestId) {
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
        initialHistoryRequestId = newSessionCtlRequestId();
        const size = initialSizeRef.current;
        const historyText = makeSessionCtlRequest(initialHistoryRequestId, "history", {
          lines: 400,
          plain: false,
          ...(bootstrapRequestedOffset !== null ? { offset: bootstrapRequestedOffset } : {}),
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

      const recoverFromPtyGap = (offset: number) => {
        if (!isCurrentRtcGeneration()) return;
        pendingBootstrapPty.splice(0);
        pendingBootstrapPtyBytes = 0;
        pendingSnapshots.splice(0);
        requests.clear();
        bootstrapDone = false;
        bootstrapStarted = false;
        bootstrapPtyAnchor = offset;
        bootstrapRequestedOffset = offset;
        initialHistoryRequestId = null;
        const current = rtcRef.current;
        rtcRef.current = { ...current, open: false, bytesReceived: offset };
        settleUploadReadiness(false);
        if (isCurrentSessionGeneration()) setDcOpen(false);
        startBootstrap();
      };

      const sendControl = (
        operation: SessionCtlOperation,
        parameters: Record<string, unknown> = {},
      ): boolean => {
        if (!ctlDc || !isCurrentRtcGeneration()) return false;
        const requestId = newSessionCtlRequestId();
        const text = makeSessionCtlRequest(requestId, operation, parameters);
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

      const sendRtcCandidate = (candidate: RTCIceCandidateInit) =>
        sendJsonOverWs({
          type: "rtc.candidate",
          session_id: rtcSessionId,
          binding_nonce: bindingNonce,
          ...(rtcRef.current.bindingGeneration !== null
            ? { binding_generation: rtcRef.current.bindingGeneration }
            : {}),
          ...boundSessionRtcTuple,
          candidate,
        });
      blockCurrentLocalCandidates = () => {
        offerSent = false;
      };
      releaseCurrentLocalCandidates = () => {
        offerSent = true;
        for (const candidate of pendingLocalCandidates.splice(0)) sendRtcCandidate(candidate);
      };

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
          clearRtcIceRestartTimer();
          return;
        }
        if (pc.connectionState === "disconnected") {
          if (!rtcDisconnectedTimer) {
            rtcDisconnectedTimer = setTimeout(() => {
              if (
                rtcRef.current.rtcSessionId === rtcSessionId &&
                pc.connectionState === "disconnected"
              ) {
                void restartIce("disconnected");
              }
            }, RTC_DISCONNECTED_GRACE_MS);
          }
          return;
        }
        if (pc.connectionState === "failed") void restartIce("failed");
        else if (pc.connectionState === "closed") cleanupRtc(false, true, rtcGeneration);
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
          if (pendingBootstrapPtyBytes + bytes.byteLength > SESSION_CTL_MAX_PENDING_PTY_BYTES) {
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
          const chunk = decodeSessionCtlChunk(bytes);
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
              const message = parseSessionCtlText(decoded);
              if (!message) return;
              if (message.kind === "event") {
                if (message.event === "ready") {
                  uploadCapability = message.upload_capability;
                  uploadSessionGeneration = message.agent_generation;
                  serverReady = true;
                  startBootstrap();
                  return;
                }
                if (message.event === "history_delta" || message.event === "history_wipe") {
                  // Committed-line deltas reach this client but nothing
                  // consumes them: history lives in the live terminal's own
                  // buffer, fed by the byte stream itself. Swallow the events
                  // so they cannot fall through to the display-control
                  // parser. Teaching the daemon not to stream them at all is
                  // a follow-up (bandwidth, not correctness).
                  return;
                }
                if (message.event === "history_gap") {
                  recoverFromPtyGap(rtcRef.current.bytesReceived);
                  return;
                }
                if (message.event === "pty_gap") {
                  recoverFromPtyGap(message.offset);
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
        // The trust read began beside the WebSocket handshake. Consume that
        // work here so IndexedDB latency is not serialized behind rtc.config.
        let signedRtcDecision: SignedRtcTrustDecision = { mode: "unpinned" };
        if (resolveSignedRtcTrustRef.current) {
          const decisionPromise = prefetchedTrustDecision ?? resolveTrustDecision();
          prefetchedTrustDecision = null;
          signedRtcDecision = await decisionPromise;
          if (!isCurrentRtcGeneration()) return;
        }
        if (signedRtcDecision.mode === "refuse") {
          // The host identity could not be verified against a local pin. Refuse
          // outright: never fall back to a raw, unauthenticated path, and do not
          // auto-retry until the local trust state changes.
          setSignedRtcRefusal(signedRtcDecision.reason);
          setState("error");
          reconnectStopped = true;
          lastRtcIceServers = null;
          cleanupRtc(true, false, rtcGeneration);
          return;
        }
        setSignedRtcRefusal(null);
        signedRtcRequired = signedRtcDecision.mode === "signed";
        signedRtcDecisionForBinding = signedRtcDecision;
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
                  scopeType: "session",
                  scopeId: sessionId,
                  protocol: "spawn.pty",
                  protocolVersion: 2,
                },
                rtcSessionId,
                signedRtcDecision.capability,
              )
            : null;
        const carrier = nextSignedRtcSession
          ? await nextSignedRtcSession.createOffer(offer.sdp ?? "")
          : { sdp: offer.sdp };
        if (!isCurrentRtcGeneration()) return;
        // A device the host does not directly pin carries its account endorsement
        // edges so the daemon can admit it via a chain to an anchor (§3).
        // Best-effort: on failure the offer still goes and a directly-pinned
        // device is admitted exactly as before.
        let carried: CarriedEndorsement[] = [];
        const loadCarried = loadCarriedEndorsementsRef.current;
        if (nextSignedRtcSession && loadCarried) {
          try {
            carried = await loadCarried();
          } catch {
            carried = [];
          }
          if (!isCurrentRtcGeneration()) return;
        }
        signedRtcSession = nextSignedRtcSession;
        const offerFrame: Record<string, unknown> = {
          type: "rtc.offer",
          session_id: rtcSessionId,
          binding_nonce: bindingNonce,
          ...boundSessionRtcTuple,
          ...carrier,
        };
        if (carried.length > 0) offerFrame.carried_endorsements = carried;
        if (!sendJsonOverWs(offerFrame)) {
          cleanupRtc(false, false, rtcGeneration);
          return;
        }
        releaseCurrentLocalCandidates?.();
        rtcConnectTimer = setTimeout(() => {
          if (isCurrentRtcGeneration() && !rtcRef.current.open) {
            cleanupRtc(true, true, rtcGeneration);
          }
        }, RTC_CONNECT_TIMEOUT_MS);
      } catch {
        cleanupRtc(true, false, rtcGeneration);
      } finally {
        if (isCurrentRtcGeneration()) rtcStartInFlight = false;
      }
    };

    const refreshRtcConfigIfStale = async () => {
      if (!lastRtcIceServers || !iceServersNeedRefresh(lastRtcIceServers)) return;
      if (rtcConfigRefreshResolve) {
        await new Promise<void>((resolve) => {
          const previous = rtcConfigRefreshResolve;
          rtcConfigRefreshResolve = () => {
            previous?.();
            resolve();
          };
        });
        return;
      }
      if (!sendJsonOverWs({ type: "rtc.config.request" })) return;
      await new Promise<void>((resolve) => {
        rtcConfigRefreshResolve = resolve;
        rtcConfigRefreshTimer = setTimeout(finishRtcConfigRefresh, RTC_CONFIG_REFRESH_TIMEOUT_MS);
      });
    };

    const startRtcWithLatest = async () => {
      await refreshRtcConfigIfStale();
      if (!isActiveSessionGeneration() || rtcRef.current.pc || !lastRtcIceServers) return;
      await startRtc(lastRtcIceServers);
    };

    const fallBackToFreshRtc = (expectedRtcGeneration: number) => {
      if (rtcRef.current.rtcGeneration !== expectedRtcGeneration) return;
      cleanupRtc(true, false, expectedRtcGeneration);
      prefetchTrustDecision();
      void startRtcWithLatest();
    };

    const restartIce = async (_reason: "disconnected" | "failed" | "wake") => {
      const current = rtcRef.current;
      if (iceRestartInFlight && Date.now() - iceRestartLatchedAt < RTC_LATCH_TIMEOUT_MS) return;
      if (!current.pc || !current.rtcSessionId) return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      if (!current.bindingNonce || current.bindingGeneration === null) {
        fallBackToFreshRtc(current.rtcGeneration);
        return;
      }
      const pc = current.pc;
      const expectedRtcGeneration = current.rtcGeneration;
      iceRestartInFlight = true;
      iceRestartLatchedAt = Date.now();
      await refreshRtcConfigIfStale();
      if (
        !isActiveSessionGeneration() ||
        rtcRef.current.pc !== pc ||
        rtcRef.current.rtcGeneration !== expectedRtcGeneration ||
        !lastRtcIceServers
      ) {
        clearRtcIceRestartTimer();
        return;
      }
      try {
        pc.setConfiguration({
          iceServers: lastRtcIceServers,
          iceTransportPolicy: lastRtcTransportPolicy,
        });
        pendingRemoteRtcCandidatesRef.current = [];
        blockCurrentLocalCandidates?.();
        pc.restartIce();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        if (rtcRef.current.pc !== pc || rtcRef.current.rtcGeneration !== expectedRtcGeneration) {
          clearRtcIceRestartTimer();
          return;
        }
        let carrier: { signed_envelope: string } | { sdp: string | undefined };
        if (signedRtcDecisionForBinding?.mode === "signed") {
          const nextSignedSession = new SignedRtcLiveSession(
            {
              scopeType: "session",
              scopeId: sessionId,
              protocol: "spawn.pty",
              protocolVersion: 2,
            },
            current.rtcSessionId,
            signedRtcDecisionForBinding.capability,
          );
          carrier = await nextSignedSession.createOffer(offer.sdp ?? "");
          signedRtcSession?.abort();
          signedRtcSession = nextSignedSession;
        } else {
          carrier = { sdp: offer.sdp };
        }
        const sent = sendJsonOverWs({
          type: "rtc.offer",
          session_id: current.rtcSessionId,
          binding_nonce: current.bindingNonce,
          binding_generation: current.bindingGeneration,
          ice_restart: true,
          ...boundSessionRtcTuple,
          ...carrier,
        });
        if (!sent) throw new Error("signalling socket is unavailable");
        releaseCurrentLocalCandidates?.();
        rtcIceRestartTimer = setTimeout(
          () => fallBackToFreshRtc(expectedRtcGeneration),
          RTC_ICE_RESTART_TIMEOUT_MS,
        );
      } catch {
        clearRtcIceRestartTimer();
        fallBackToFreshRtc(expectedRtcGeneration);
      }
    };

    const healthyRtc = () => {
      const current = rtcRef.current;
      return (
        current.pc?.connectionState === "connected" &&
        current.ptyDc?.readyState === "open" &&
        current.ctlDc?.readyState === "open"
      );
    };

    const fallBackFromResume = () => {
      const expectedRtcGeneration = rtcRef.current.rtcGeneration;
      clearRtcResumeTimer();
      cleanupRtc(false, false, expectedRtcGeneration);
      prefetchTrustDecision();
      void startRtcWithLatest();
    };

    const resumeHealthyRtc = () => {
      const current = rtcRef.current;
      if (!healthyRtc()) return false;
      if (!current.rtcSessionId || !current.bindingNonce || current.bindingGeneration === null) {
        fallBackFromResume();
        return false;
      }
      if (resumeInFlight) return true;
      resumeInFlight = sendJsonOverWs({
        type: "rtc.resume",
        session_id: current.rtcSessionId,
        binding_nonce: current.bindingNonce,
        binding_generation: current.bindingGeneration,
        ...boundSessionRtcTuple,
      });
      if (!resumeInFlight) return false;
      rtcResumeTimer = setTimeout(fallBackFromResume, RTC_RESUME_TIMEOUT_MS);
      return true;
    };

    const connect = () => {
      if (!isActiveSessionGeneration() || reconnectStopped) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      prefetchTrustDecision();
      let shouldResumeHealthyRtc = healthyRtc();
      setState("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(buildSessionWsUrl(sessionId), SPAWN_WS_SUBPROTOCOL);
      } catch {
        setState("error");
        scheduleReconnect();
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      const isCurrentWs = () => isActiveSessionGeneration() && wsRef.current === ws;
      let pingSeen = false;
      const armSignalWatchdog = () => {
        if (!pingSeen || !isCurrentWs()) return;
        if (signalWatchdogTimer) clearTimeout(signalWatchdogTimer);
        signalWatchdogTimer = setTimeout(() => {
          if (isCurrentWs()) ws.close(4008, "keepalive timeout");
        }, SIGNAL_WATCHDOG_MS);
      };

      ws.onopen = () => {
        if (!isCurrentWs()) return;
        lastSignalFrameAt = Date.now();
        if (ws.protocol !== SPAWN_WS_SUBPROTOCOL) {
          ws.close(1002, "Required terminal signaling protocol was not selected");
          return;
        }
        setV3(true);
        setState("open");
      };
      ws.onmessage = (ev) => {
        if (!isCurrentWs()) return;
        lastSignalFrameAt = Date.now();
        const h = currentHandlers();
        if (!h) return;
        if (typeof ev.data === "string") {
          const msg = parseInbound(ev.data);
          if (!msg) {
            if (signedRtcSession) cleanupRtc(true, true, rtcRef.current.rtcGeneration);
            return;
          }
          attempt = 0;
          if (pingSeen) armSignalWatchdog();
          if (msg.type === "ping") {
            pingSeen = true;
            armSignalWatchdog();
            if (Number.isFinite(msg.ts)) sendJsonOverWs({ type: "pong", ts: msg.ts });
          } else if (msg.type === "error") {
            if (resumeInFlight) fallBackFromResume();
          } else if (msg.type === "session.exit") {
            h.onExit?.(msg.exit_code, msg.signal);
          } else if (msg.type === "session.status") {
            h.onStatus?.(msg.status);
            if (msg.status === "running") {
              rtcRetryAttempts = 0;
              if (rtcRetryTimer) clearTimeout(rtcRetryTimer);
              rtcRetryTimer = null;
              if (!rtcRef.current.pc) void startRtcWithLatest();
            }
          } else if (msg.type === "rtc.config") {
            finishRtcConfigRefresh();
            if (msg.enabled) {
              setState("open");
              if (msg.binding_nonce_required !== true) {
                ws.close(1002, "RTC binding identity negotiation is required");
                return;
              }
              lastRtcIceServers = sanitizeIceServers(msg.ice_servers ?? []);
              lastRtcTransportPolicy = msg.ice_transport_policy === "relay" ? "relay" : "all";
              rtcRetryAttempts = 0;
              if (shouldResumeHealthyRtc && healthyRtc()) {
                shouldResumeHealthyRtc = false;
                resumeHealthyRtc();
              } else if (!rtcRef.current.pc) {
                void startRtcWithLatest();
              } else if (rtcRef.current.pc.connectionState !== "connected") {
                void restartIce("wake");
              }
            } else {
              lastRtcIceServers = null;
              cleanupRtc(true, false);
              setState("disabled");
            }
          } else if (msg.type === "rtc.answer") {
            const current = rtcRef.current;
            const bindingRequired = true;
            if (current.pc && signedRtcSession) {
              const pc = current.pc;
              const acceptedBinding = {
                rtcSessionId: current.rtcSessionId,
                bindingNonce: current.bindingNonce,
                bindingGeneration: current.bindingGeneration,
              };
              const acceptedRtcGeneration = current.rtcGeneration;
              if (
                !current.rtcSessionId ||
                !current.bindingNonce ||
                current.bindingGeneration === null ||
                !rtcBindingFrameMatches(
                  {
                    rtcSessionId: current.rtcSessionId,
                    bindingNonce: current.bindingNonce,
                    bindingGeneration: current.bindingGeneration,
                    sessionId,
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
                    latest.sessionId !== sessionId ||
                    latest.sessionGeneration !== sessionGeneration ||
                    latest.rtcGeneration !== acceptedRtcGeneration ||
                    latest.rtcSessionId !== acceptedBinding.rtcSessionId ||
                    latest.bindingNonce !== acceptedBinding.bindingNonce ||
                    latest.bindingGeneration !== acceptedBinding.bindingGeneration
                  )
                    return;
                  if (pc.connectionState === "connected") clearRtcIceRestartTimer();
                  const pending = pendingRemoteRtcCandidatesRef.current.splice(0);
                  for (const candidate of pending) {
                    void pc.addIceCandidate(candidate).catch(() => {});
                  }
                })
                .catch(() => cleanupRtc(true, true, acceptedRtcGeneration));
            } else if (
              current.rtcSessionId &&
              current.bindingNonce &&
              !signedRtcRequired &&
              (!bindingRequired || current.bindingGeneration !== null) &&
              current.pc &&
              rtcBindingFrameMatches(
                {
                  rtcSessionId: current.rtcSessionId,
                  bindingNonce: current.bindingNonce,
                  bindingGeneration: current.bindingGeneration,
                  sessionId,
                },
                msg,
              )
            ) {
              const pc = current.pc;
              const acceptedBinding = {
                rtcSessionId: current.rtcSessionId,
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
                    latest.sessionId !== sessionId ||
                    latest.sessionGeneration !== sessionGeneration ||
                    latest.rtcGeneration !== acceptedRtcGeneration ||
                    latest.rtcSessionId !== acceptedBinding.rtcSessionId ||
                    latest.bindingNonce !== acceptedBinding.bindingNonce ||
                    latest.bindingGeneration !== acceptedBinding.bindingGeneration
                  )
                    return;
                  if (pc.connectionState === "connected") clearRtcIceRestartTimer();
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
              current.rtcSessionId &&
              current.bindingNonce &&
              (!bindingRequired || current.bindingGeneration !== null) &&
              current.pc &&
              rtcBindingFrameMatches(
                {
                  rtcSessionId: current.rtcSessionId,
                  bindingNonce: current.bindingNonce,
                  bindingGeneration: current.bindingGeneration,
                  sessionId,
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
            const exactBoundStatus =
              current.rtcSessionId !== null &&
              current.bindingNonce !== null &&
              rtcBindingFrameMatches(
                {
                  rtcSessionId: current.rtcSessionId,
                  bindingNonce: current.bindingNonce,
                  bindingGeneration: current.bindingGeneration,
                  sessionId,
                },
                msg,
              );
            if (
              exactBoundStatus &&
              ["resumed", "rebound", "signalling_lost", "connected"].includes(msg.status)
            ) {
              rtcRetryAttempts = 0;
              if (msg.status === "resumed") clearRtcResumeTimer();
              return;
            }
            if (
              resumeInFlight &&
              msg.status === "unavailable" &&
              msg.session_id === current.rtcSessionId &&
              (msg.binding_nonce === undefined || msg.binding_nonce === current.bindingNonce)
            ) {
              fallBackFromResume();
              return;
            }
            if (
              msg.status === "negotiating" &&
              current.rtcSessionId === msg.session_id &&
              current.bindingNonce === msg.binding_nonce &&
              current.bindingGeneration === null &&
              typeof msg.binding_generation === "number" &&
              Number.isSafeInteger(msg.binding_generation) &&
              msg.binding_generation > 0 &&
              msg.scope_type === "session" &&
              msg.scope_id === sessionId &&
              msg.protocol === "spawn.pty" &&
              msg.protocol_version === 2
            ) {
              rtcRef.current = {
                ...current,
                bindingGeneration: msg.binding_generation,
              };
              rtcRetryAttempts = 0;
              return;
            }
            const exactPrebindFailure =
              current.bindingGeneration === null &&
              current.rtcSessionId === msg.session_id &&
              current.bindingNonce === msg.binding_nonce &&
              msg.binding_generation === undefined;
            if (
              msg.session_id &&
              (exactPrebindFailure || exactBoundStatus) &&
              ["failed", "disabled", "unavailable", "collision"].includes(msg.status)
            ) {
              if (iceRestartInFlight && msg.status === "unavailable") {
                fallBackToFreshRtc(current.rtcGeneration);
              } else if (msg.status === "disabled") {
                cleanupRtc(false, false);
                setState("disabled");
              } else {
                cleanupRtc(false, true);
              }
            } else if (!["failed", "disabled", "unavailable", "collision"].includes(msg.status)) {
              rtcRetryAttempts = 0;
              if (!current.pc) void startRtcWithLatest();
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
      ws.onclose = (event) => {
        if (!isCurrentSessionGeneration() || wsRef.current !== ws) return;
        if (signalWatchdogTimer) clearTimeout(signalWatchdogTimer);
        signalWatchdogTimer = null;
        finishRtcConfigRefresh();
        clearRtcResumeTimer();
        const action = socketCloseAction(event.code);
        if (
          !healthyRtc() ||
          action === "unauthorized" ||
          action === "client_bug" ||
          action === "client_stale"
        ) {
          cleanupRtc(false);
        }
        wsRef.current = null;
        if (action === "unauthorized") {
          reconnectStopped = true;
          setState("unauthorized");
          notifySocketUnauthorized();
          return;
        }
        if (action === "client_stale") {
          reconnectStopped = true;
          setState("error");
          window.dispatchEvent(new CustomEvent("spawn:client-stale", { detail: { hard: true } }));
          return;
        }
        if (action === "client_bug") {
          reconnectStopped = true;
          setState("error");
          console.error("SPAWN D terminal signalling stopped after a client protocol error.");
          return;
        }
        setState("closed");
        if (action === "reconnect_immediately") {
          reconnectTimer = setTimeout(connect, 0);
          return;
        }
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (!isActiveSessionGeneration() || reconnectStopped || reconnectTimer) return;
      const delay = backoffDelay(attempt, { base: 500, cap: 30_000 });
      attempt = Math.min(attempt + 1, 30);
      reconnectTimer = setTimeout(connect, delay);
    };

    const redialNow = () => {
      const ws = wsRef.current;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      attempt = 0;
      if (ws) {
        wsRef.current = null;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // A replacement socket is opened below either way.
        }
      }
      connect();
    };

    const wake = () => {
      if (!isActiveSessionGeneration() || reconnectStopped) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        redialNow();
        return;
      }
      const pc = rtcRef.current.pc;
      if (pc?.connectionState === "connected") return;
      if (Date.now() - lastSignalFrameAt > SIGNAL_SILENCE_SUSPECT_MS) {
        // OPEN is the socket's claim, not the network's: after a sleep the
        // TCP side is routinely gone with no onclose ever fired, and every
        // frame signalled into it "succeeds" into nothing. The server pings
        // every 25 s, so a live socket is never this quiet — redial, which
        // also carries fresh TURN credentials in on the new rtc.config.
        redialNow();
        return;
      }
      if (pc) void restartIce("wake");
      else void startRtcWithLatest();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    // The desktop shell's webview sleeps and wakes with the machine without
    // firing any of the three events above; the clock jump is the one signal
    // that always arrives.
    const stopSuspendWatch = watchSuspendResume(wake);

    connect();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      stopSuspendWatch();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (signalWatchdogTimer) clearTimeout(signalWatchdogTimer);
      if (rtcRetryTimer) clearTimeout(rtcRetryTimer);
      clearRtcIceRestartTimer();
      clearRtcResumeTimer();
      finishRtcConfigRefresh();
      if (isCurrentSessionGeneration() && wsRef.current) {
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
      if (pendingInputExpiryTimerRef.current) clearTimeout(pendingInputExpiryTimerRef.current);
      pendingInputExpiryTimerRef.current = null;
      if (isCurrentSessionGeneration()) activeSessionIdRef.current = null;
    };
  }, [
    sessionId,
    enabled,
    hostPinRevision,
    settleUploadReadiness,
    armPendingInputExpiry,
    updateQueuedInputState,
  ]);

  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Poll WebRTC stats while the channel is up: the selected candidate pair
  // tells us whether bytes flow direct, via STUN-discovered addresses, or
  // through the TURN relay — plus the live round-trip time.
  useEffect(() => {
    if (!dcOpen) {
      setConnInfo(EMPTY_CONN_INFO);
      return;
    }
    if (!active || !pageVisible) return;
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
        rtcRef.current.sessionId !== observed.sessionId ||
        rtcRef.current.sessionGeneration !== observed.sessionGeneration ||
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
  }, [dcOpen, active, pageVisible]);

  const sendBinary = useCallback(
    (bytes: Uint8Array | string) => {
      if (activeSessionIdRef.current !== sessionId) return false;
      const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
      const rtc = rtcRef.current;
      if (rtc.open && rtc.ptyDc?.readyState === "open") {
        return sendPtyInputRef.current(buf);
      }
      const accepted = pendingInputRef.current.enqueue(sessionGenerationRef.current, buf);
      updateQueuedInputState();
      if (accepted) armPendingInputExpiry();
      return accepted;
    },
    [armPendingInputExpiry, sessionId, updateQueuedInputState],
  );

  const sendJson = useCallback(
    (msg: unknown) => {
      if (activeSessionIdRef.current !== sessionId) return false;
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
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    [sessionId],
  );

  const waitForUploadReadiness = useCallback(
    (signal?: AbortSignal) =>
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
          reject(new Error("Direct session upload channel is not ready."));
        }, UPLOAD_READY_WAIT_MS);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        uploadReadyWaitersRef.current.add(waiter);
      }),
    [],
  );

  const uploadFile = useCallback(
    async (blob: Blob, options: DirectSessionUploadOptions) => {
      if (!uploadReadyRef.current) await waitForUploadReadiness(options.signal);
      // A caller holding this hook's return from an earlier session must not
      // dispatch into the current session's channel — re-checked after the wait
      // because readiness may have been restored by a successor generation.
      if (activeSessionIdRef.current !== sessionId) {
        throw new Error("Session upload generation changed.");
      }
      return uploadRef.current(blob, options);
    },
    [sessionId, waitForUploadReadiness],
  );

  return useMemo(
    () => ({
      state,
      v3,
      dcOpen,
      queuedInputCount,
      connInfo,
      signedRtcRefusal,
      signalingTrust,
      sendBinary,
      sendJson,
      uploadFile,
    }),
    [
      state,
      v3,
      dcOpen,
      queuedInputCount,
      connInfo,
      signedRtcRefusal,
      signalingTrust,
      sendBinary,
      sendJson,
      uploadFile,
    ],
  );
}
