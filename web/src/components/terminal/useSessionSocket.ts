"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonChannel } from "@/lib/daemon-channel";
import type { DaemonConnection } from "@/lib/daemon-connection";
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
import type { SignedRtcRefusalReason } from "@/lib/signed-rtc-trust";
import type { DisplayControlState } from "@/lib/ws";

/**
 * Attach one terminal view to the app-owned daemon connection.
 *
 * Manages channel attachment, bounded retry, replay, and surface state
 * via callbacks.  The caller is responsible for actually wiring `onData` to
 * the xterm.js instance (we keep this hook framework-agnostic so it could
 * also maintain local replay state).
 */
export interface UseSessionSocketOptions {
  connection?: DaemonConnection | null;
  sessionId: string;
  sessionStatus?: { status: string; exit_code: number | null } | null;
  enabled?: boolean;
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
  ptyDc: DaemonChannel | null;
  ctlDc: DaemonChannel | null;
  rtcSessionId: string | null;
  ptyOpen: boolean;
  ctlOpen: boolean;
  open: boolean;
  /** Cumulative PTY bytes received over this session's DataChannel. */
  bytesReceived: number;
};

const RTC_CONNECT_TIMEOUT_MS = 10_000;
// Covers a full connect plus one retry cycle before an early upload gives up.
const UPLOAD_READY_WAIT_MS = 20_000;
// Only healthy-channel backpressure can queue input; disconnect and control
// loss discard it. Leave headroom beneath the bounded channel proxy.
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const MAX_PENDING_INPUT_AGE_MS = 30_000;

function newRtcSessionId(): string {
  return crypto.randomUUID();
}

export function useSessionSocket({
  connection = null,
  sessionId,
  sessionStatus = null,
  enabled = true,
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
  const displayOwnerRef = useRef(false);
  const [queuedInputCount, setQueuedInputCount] = useState(0);
  // Non-null when the last attempt was refused because the host identity could
  // not be verified against a local pin. A refusal is terminal (no auto-retry).
  const [signedRtcRefusal, setSignedRtcRefusal] = useState<SignedRtcRefusalReason | null>(null);
  // How the current connection's signaling was authenticated: "verified"
  // (signed, host pin matched), "first_contact" (signed TOFU on the claimed
  // key), or "raw" (unsigned legacy path). Null until a decision is made.
  const [signalingTrust, setSignalingTrust] = useState<SignalingTrustLevel | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const rtcGenerationRef = useRef(0);
  const pendingInputRef = useRef(new SessionGenerationInputQueue(MAX_PENDING_INPUT_BYTES));
  const pendingInputExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rtcRef = useRef<RtcState>({
    sessionId: null,
    sessionGeneration: 0,
    rtcGeneration: 0,
    ptyDc: null,
    ctlDc: null,
    rtcSessionId: null,
    ptyOpen: false,
    ctlOpen: false,
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

  const viewId = useRef(newRtcSessionId());
  const lastExit = useRef<string | null>(null);
  useEffect(() => {
    const status = sessionStatus?.status;
    if (!status) return;
    handlersRef.current.onStatus?.(status);
    if (status === "exited" || status === "killed") {
      if (lastExit.current !== sessionId) {
        lastExit.current = sessionId;
        handlersRef.current.onExit?.(sessionStatus?.exit_code ?? null, null);
      }
    } else {
      lastExit.current = null;
    }
  }, [sessionId, sessionStatus?.status, sessionStatus?.exit_code]);
  useEffect(() => {
    const sessionGeneration = ++sessionGenerationRef.current;
    activeSessionIdRef.current = enabled && connection ? sessionId : null;
    pendingInputRef.current.clear();
    displayOwnerRef.current = false;
    setQueuedInputCount(0);
    setV3(Boolean(connection));
    setDcOpen(false);
    if (!enabled || !sessionId || !connection) {
      setState("idle");
      return;
    }
    let cancelled = false;
    let rtcRetryAttempts = 0;
    let rtcRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let rtcConnectTimer: ReturnType<typeof setTimeout> | null = null;
    const isCurrentSessionGeneration = () => sessionGenerationRef.current === sessionGeneration;
    const isActiveSessionGeneration = () => !cancelled && isCurrentSessionGeneration();
    const currentHandlers = () =>
      isActiveSessionGeneration() && handlersRef.current.sessionId === sessionId
        ? handlersRef.current
        : null;
    const clearRtcConnectTimer = () => {
      if (rtcConnectTimer) clearTimeout(rtcConnectTimer);
      rtcConnectTimer = null;
    };

    const cleanupRtc = (_signal = true, retry = false, expectedRtcGeneration?: number) => {
      const rtc = rtcRef.current;
      if (
        rtc.sessionGeneration !== sessionGeneration ||
        (expectedRtcGeneration !== undefined && rtc.rtcGeneration !== expectedRtcGeneration)
      )
        return;
      clearRtcConnectTimer();
      rtcRef.current = {
        sessionId: null,
        sessionGeneration: 0,
        rtcGeneration: 0,
        ptyDc: null,
        ctlDc: null,
        rtcSessionId: null,
        ptyOpen: false,
        ctlOpen: false,
        open: false,
        bytesReceived: 0,
      };
      rtc.ptyDc?.close();
      rtc.ctlDc?.close();
      sendControlRef.current = () => false;
      sendPtyInputRef.current = () => false;
      displayOwnerRef.current = false;
      uploadRef.current = async () => {
        throw new Error("Direct session upload channel is not ready.");
      };
      settleUploadReadiness(false);
      cancelUploadsRef.current(new Error("Direct session upload channel closed."));
      cancelUploadsRef.current = () => {};
      pendingInputRef.current.clear();
      updateQueuedInputState();
      if (isCurrentSessionGeneration()) setDcOpen(false);
      if (retry) scheduleRtcRetry();
    };
    const scheduleRtcRetry = () => {
      if (
        !isActiveSessionGeneration() ||
        rtcRetryTimer ||
        connection.getSnapshot().state !== "ready"
      )
        return;
      const delay = Math.min(10_000, 500 * 2 ** rtcRetryAttempts++);
      setState("connecting");
      rtcRetryTimer = setTimeout(() => {
        rtcRetryTimer = null;
        startRtc();
      }, delay);
    };
    const startRtc = () => {
      if (
        !isActiveSessionGeneration() ||
        rtcRef.current.ptyDc ||
        connection.getSnapshot().state !== "ready"
      )
        return;
      const rtcGeneration = ++rtcGenerationRef.current;
      const rtcSessionId = newRtcSessionId();
      const suffix = `${sessionId}/${viewId.current}/${rtcSessionId}`;
      let ptyDc: DaemonChannel;
      let ctlDc: DaemonChannel;
      try {
        ptyDc = connection.createChannel(`spawn.pty/${suffix}`);
        try {
          ctlDc = connection.createChannel(`spawn.ctl/${suffix}`);
        } catch (error) {
          ptyDc.close();
          throw error;
        }
      } catch {
        scheduleRtcRetry();
        return;
      }
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
        ptyDc,
        ctlDc,
        rtcSessionId,
        ptyOpen: false,
        ctlOpen: false,
        open: false,
        bytesReceived: 0,
      };

      const sendPtyChunks = (bytes: Uint8Array): number => {
        return writeSessionPtyInput(ptyDc, bytes);
      };

      const flushPendingInput = () => {
        if (
          !isCurrentRtcGeneration() ||
          ptyDc.readyState !== "open" ||
          !displayOwnerRef.current ||
          connection.getSnapshot().state !== "ready"
        )
          return;
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
        ptyDc.bufferedAmountLowThreshold = 64 * 1024;
        updateQueuedInputState();
        if (pendingInputRef.current.count(sessionGeneration) > 0) armPendingInputExpiry();
      };

      sendPtyInputRef.current = (bytes) => {
        if (
          !isCurrentRtcGeneration() ||
          !displayOwnerRef.current ||
          connection.getSnapshot().state !== "ready"
        )
          return false;
        const alreadyQueued = pendingInputRef.current.count(sessionGeneration) > 0;
        const sent = alreadyQueued ? 0 : sendPtyChunks(bytes);
        const accepted =
          sent === bytes.byteLength ||
          pendingInputRef.current.enqueue(sessionGeneration, bytes.subarray(sent));
        updateQueuedInputState();
        if (pendingInputRef.current.count(sessionGeneration) > 0) {
          armPendingInputExpiry();
          if (ptyDc.bufferedAmount <= 128 * 1024) {
            setTimeout(flushPendingInput, 0);
          }
        }
        return accepted;
      };
      ptyDc.bufferedAmountLowThreshold = 64 * 1024;
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
        if (isCurrentSessionGeneration()) {
          setDcOpen(true);
          setState("open");
        }
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
          else if (result.operation === "snapshot") {
            currentHandlers()?.onSnapshotError?.(`rejected: ${result.reason}`);
          }
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
        if (!ctlDc || !isCurrentRtcGeneration() || connection.getSnapshot().state !== "ready")
          return false;
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
        void ptyMessages
          .enqueue(
            async () => new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data),
            (bytes) => {
              if (isCurrentRtcGeneration()) deliverPtyChunk(bytes);
            },
            data instanceof Blob ? data.size : data.byteLength,
          )
          .catch(() => {
            if (isCurrentRtcGeneration()) cleanupRtc(true, true, rtcGeneration);
          });
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
          void controlMessages
            .enqueue(
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
                  displayOwnerRef.current = message.owner;
                  if (!message.owner) {
                    pendingInputRef.current.clear();
                    updateQueuedInputState();
                  }
                  currentHandlers()?.onDisplayControl?.({
                    owner: message.owner,
                    sameDevice: message.same_device === true,
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
              typeof data === "string"
                ? new TextEncoder().encode(data).byteLength
                : data instanceof Blob
                  ? data.size
                  : data.byteLength,
            )
            .catch(() => {
              if (isCurrentRtcGeneration()) cleanupRtc(true, true, rtcGeneration);
            });
        };
      }

      rtcConnectTimer = setTimeout(() => {
        if (isCurrentRtcGeneration() && !rtcRef.current.open) cleanupRtc(true, true, rtcGeneration);
      }, RTC_CONNECT_TIMEOUT_MS);
    };
    const sync = () => {
      if (!isActiveSessionGeneration()) return;
      const snapshot = connection.getSnapshot();
      setSignedRtcRefusal(snapshot.refusal);
      setSignalingTrust(snapshot.trust);
      setConnInfo(snapshot.info ?? EMPTY_CONN_INFO);
      if (snapshot.state !== "ready") {
        pendingInputRef.current.clear();
        updateQueuedInputState();
        setDcOpen(false);
        setState(snapshot.state === "open" ? "connecting" : snapshot.state);
        return;
      }
      if (rtcRef.current.open) {
        setDcOpen(true);
        setState("open");
      } else {
        setState("connecting");
        startRtc();
      }
    };
    const unsubscribe = connection.subscribe(sync);
    sync();
    return () => {
      cancelled = true;
      unsubscribe();
      if (rtcRetryTimer) clearTimeout(rtcRetryTimer);
      clearRtcConnectTimer();
      cleanupRtc(false);
      if (pendingInputExpiryTimerRef.current) clearTimeout(pendingInputExpiryTimerRef.current);
      pendingInputExpiryTimerRef.current = null;
      if (isCurrentSessionGeneration()) activeSessionIdRef.current = null;
    };
  }, [
    sessionId,
    enabled,
    connection,
    settleUploadReadiness,
    updateQueuedInputState,
    armPendingInputExpiry,
  ]);

  const sendBinary = useCallback(
    (bytes: Uint8Array | string) => {
      if (activeSessionIdRef.current !== sessionId) return false;
      const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
      const rtc = rtcRef.current;
      if (
        connection?.getSnapshot().state === "ready" &&
        rtc.open &&
        rtc.ptyDc?.readyState === "open"
      ) {
        return sendPtyInputRef.current(buf);
      }
      return false;
    },
    [connection, sessionId],
  );

  const sendJson = useCallback(
    (msg: unknown) => {
      if (activeSessionIdRef.current !== sessionId) return false;
      if (typeof msg === "object" && msg !== null) {
        const payload = msg as Record<string, unknown>;
        const type = payload.type;
        const operation =
          type === "take_control" || type === "focus_view"
            ? type
            : type === "resize" || type === "scroll" || type === "redraw" || type === "snapshot"
              ? type
              : null;
        if (operation) {
          const { type: _type, rtc_session_id: _rtcSessionId, ...parameters } = payload;
          return sendControlRef.current(operation, parameters);
        }
      }
      return false;
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
