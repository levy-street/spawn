import { parseCapabilities } from "@/lib/preview/capabilities";
import { hashStream, Sha256 } from "@/lib/sha256";
import { SignedRtcLiveSession } from "@/lib/signed-rtc-live";
import type { SignedRtcRefusalReason, SignedRtcTrustDecision } from "@/lib/signed-rtc-trust";
import {
  backoffDelay,
  buildHostWsUrl,
  iceServersNeedRefresh,
  notifySocketUnauthorized,
  RTC_ICE_CANDIDATE_POOL_SIZE,
  SIGNAL_SILENCE_SUSPECT_MS,
  sanitizeIceServers,
  socketCloseAction,
  watchSuspendResume,
} from "@/lib/ws";

export const HOST_CONTROL_PROTOCOL = "spawn.host.ctl";
export const HOST_CONTROL_VERSION = 1;

const HOST_SIGNAL_SUBPROTOCOL = "spawn.host.v1";
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const SIGNAL_WATCHDOG_MS = 80_000;
const RTC_DISCONNECTED_GRACE_MS = 5_000;
const RTC_CONFIG_REFRESH_TIMEOUT_MS = 2_000;
const RTC_RESUME_TIMEOUT_MS = 3_000;
const STREAM_CHUNK_BYTES = 8 * 1024;
const STREAM_WINDOW_CHUNKS = 8;
const STREAM_BUFFERED_HIGH_WATER = 256 * 1024;
const STREAM_TIMEOUT_MS = 60_000;
const FALLBACK_DOWNLOAD_MEMORY_LIMIT = 32 * 1024 * 1024;
const MAX_STREAM_TOMBSTONES = 256;
const STREAM_TOMBSTONE_TTL_MS = 120_000;
// A request whose acknowledgement is lost may or may not have taken effect, so
// it must never be transparently retried. Launching an application is exactly
// that: a lost ack could still have opened a window on someone's desktop.
const INDETERMINATE_REQUEST_OPERATIONS = new Set([
  "fs.mkdir",
  "fs.rename",
  "fs.remove",
  "desktop.reveal",
  "desktop.open",
]);
/**
 * Rendering a preview waits on a third-party QuickLook generator, and the first
 * one of a session also pays for QuickLook's agents starting up. This must stay
 * comfortably above the daemon's own render timeout so the host always gets to
 * answer with a real reason rather than the client giving up first.
 */
const PREVIEW_REQUEST_TIMEOUT_MS = 35_000;
/** Largest slice `fs.read.range` will return in one request. */
export const MAX_RANGE_BYTES = 16 * 1024 * 1024;
export const HOST_DIRECTORY_PAGE_ENTRIES = 96;

export class HostControlError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail || code);
    this.name = "HostControlError";
  }
}

/** One exact capacity reading, only ever carried by `spawn.host.ctl`. */
export interface HostCapacitySample {
  /** Whole-machine CPU use, 0-100, across every logical core. */
  cpu_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  /** 1-minute load average where the platform keeps one. */
  load_one?: number | null;
  uptime_seconds: number;
}

/** What the machine is. Repeated on every sample so one request is enough. */
export interface HostCapacitySpec {
  cpu_cores: number;
  cpu_physical_cores?: number | null;
  cpu_model?: string | null;
  memory_bytes: number;
  gpu?: string | null;
}

export interface HostMetrics {
  sample: HostCapacitySample;
  spec?: HostCapacitySpec | null;
}

export interface HostDirEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  is_dir: boolean;
  size?: number | null;
  modified_at?: number | null;
}

export interface HostDirList {
  path: string;
  home_dir: string;
  parent?: string | null;
  entries: HostDirEntry[];
  next_cursor?: number | null;
  truncated?: boolean;
}

export interface HostFileOp {
  path?: string | null;
}

export interface HostFileStat {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number | null;
  modified_at?: number | null;
  content_type?: string | null;
  open_allowed?: boolean;
}

export interface HostReadStream {
  streamId: string;
  path: string;
  name: string;
  length: number;
  sha256: string;
  stream: ReadableStream<Uint8Array>;
}

/** A bounded slice. `sha256` covers the slice, not the whole file. */
export interface HostRangeStream extends HostReadStream {
  offset: number;
  fileSize: number;
  /** Opaque validator; changes whenever the file does. */
  version: string | null;
  contentType: string | null;
  /** The host's own verdict on whether it would launch this file. */
  openAllowed: boolean;
  /** The slice reached the end of the file. */
  eof: boolean;
}

/** A host-rendered preview image for a format the browser cannot draw. */
export interface HostPreviewStream extends HostReadStream {
  mime: string;
  width: number;
  height: number;
  version: string | null;
}

/** Render sizes the host accepts. An allowlist, never a clamped free integer. */
export const PREVIEW_PIXEL_SIZES = [128, 256, 512, 1024];

/** Drain a stream into one buffer. Only for content already known to be small. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type HostControlState =
  | "idle"
  | "connecting"
  | "open"
  | "ready"
  | "closed"
  | "error"
  | "unauthorized";
export type HostControlTerminalReason = "protocol_required" | "client_bug";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  mutation: boolean;
  dispatched: boolean;
  removeAbort?: () => void;
}

interface IncomingStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  nextSequence: number;
  acknowledged: number;
  received: number;
  expectedLength: number;
  expectedSha256: string;
  hash: Sha256;
  timer?: ReturnType<typeof setTimeout>;
}

interface CancelledIncomingStream {
  nextSequence: number;
  maxSequenceExclusive: number;
  received: number;
  expectedLength: number;
  expectedSha256: string;
  hash: Sha256;
  expiresAt: number;
}

interface OutgoingStream {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
  commitDispatched: boolean;
  cancelSent: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface SignalMetadata {
  scope_type: "host";
  scope_id: string;
  protocol: typeof HOST_CONTROL_PROTOCOL;
  protocol_version: typeof HOST_CONTROL_VERSION;
}

interface HostBindingMetadata {
  binding_nonce?: string;
  binding_generation?: number;
}

type SignalMessage =
  | ({
      type: "rtc.config";
      enabled: boolean;
      ice_servers?: RTCIceServer[];
      ice_transport_policy?: RTCIceTransportPolicy;
    } & SignalMetadata)
  | ({
      type: "rtc.answer";
      session_id: string;
      signed_envelope?: string;
      sdp?: string;
    } & SignalMetadata &
      HostBindingMetadata)
  | ({
      type: "rtc.candidate";
      session_id: string;
      candidate: RTCIceCandidateInit;
    } & SignalMetadata &
      HostBindingMetadata)
  | ({ type: "rtc.status"; session_id?: string; status: string } & SignalMetadata &
      HostBindingMetadata);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HostControlRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One account-scoped endorsement edge carried on an offer (device mesh §3),
 * in the exact wire shape the daemon reconstructs to re-verify. */
export interface CarriedEndorsement {
  account_id: string;
  endorser_public_key: string;
  endorsed_public_key: string;
  endorsed_device_id: string;
  signature: string;
}

export interface HostControlClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
  reconnectBaseDelayMs?: number;
  reconnectRandom?: () => number;
  watchdogMs?: number;
  resumeTimeoutMs?: number;
  /** How long a claimed-OPEN socket may be silent before wake() presumes it a
   * corpse and redials. Deterministic tests shorten it. */
  silenceSuspectMs?: number;
  /** Primarily useful for bounded clients and deterministic timeout tests. */
  streamTimeoutMs?: number;
  /** Resolve, per RTC generation, whether this host requires signed signaling,
   * may use raw (unpinned TOFU first-contact), or must be refused. */
  resolveSignedRtcTrust?: () => Promise<SignedRtcTrustDecision>;
  /** Account endorsement edges to carry on the offer so a daemon that does not
   * directly pin this browser can admit it via a chain to an anchor (§3). */
  loadCarriedEndorsements?: () => Promise<CarriedEndorsement[]>;
}

export class HostControlClient {
  private state: HostControlState = "idle";
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private sessionId: string | null = null;
  private bindingNonce: string | null = null;
  private bindingGeneration: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectionAttempt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private signalWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private rtcDisconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private rtcResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private rtcConfigRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private rtcConfigRefreshResolve: (() => void) | null = null;
  private resumeInFlight = false;
  /** When the server was last heard on the current socket; see wake(). */
  private lastSignalFrameAt = 0;
  private stopSuspendWatch: (() => void) | null = null;
  private latestIceServers: RTCIceServer[] | null = null;
  private latestIceTransportPolicy: RTCIceTransportPolicy = "all";
  private localCandidateGate: { block: () => void; release: () => void } | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private signedRtcSession: SignedRtcLiveSession | null = null;
  // True once the current generation has decided it will negotiate a signed
  // session, set BEFORE ICE gathering/offer so the legacy raw-answer branch is
  // unreachable during the window before signedRtcSession is armed. Reset on
  // every teardown so a fresh generation starts unpinned until it decides.
  private signedRtcRequired = false;
  private prefetchedTrustDecision: Promise<SignedRtcTrustDecision> | null = null;
  // What this generation's daemon said it can do, from its `hello`. Reset on
  // teardown so a reconnect onto a downgraded daemon cannot inherit a stale
  // capability set and keep offering actions that daemon no longer supports.
  private capabilities: ReadonlySet<string> = new Set();
  // Non-null when the last attempt was refused because the host identity could
  // not be verified against a local pin. Terminal: blocks auto-reconnect.
  private signedRtcRefusal: SignedRtcRefusalReason | null = null;
  // A wire-version refusal is terminal too, but it is not a trust refusal and
  // must never be surfaced as one. The release watcher owns its recovery UI.
  private terminalReason: HostControlTerminalReason | null = null;
  private stopped = true;
  private pending = new Map<string, PendingRequest>();
  private incomingStreams = new Map<string, IncomingStream>();
  private cancelledIncomingStreams = new Map<string, CancelledIncomingStream>();
  private outgoingStreams = new Map<string, OutgoingStream>();
  private listeners = new Set<(state: HostControlState) => void>();
  private globalListenersInstalled = false;
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") this.wake();
  };
  private readonly onWake = () => this.wake();

  constructor(
    readonly hostId: string,
    private readonly options: HostControlClientOptions = {},
  ) {}

  getState(): HostControlState {
    return this.state;
  }

  subscribe(listener: (state: HostControlState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.signedRtcRefusal = null;
    this.terminalReason = null;
    this.installGlobalListeners();
    this.prefetchTrustDecision();
    this.openWebSocket();
  }

  /** The reason the last attempt was refused (unverifiable host identity), or
   * null. A refusal is terminal until an explicit reconnect. */
  getSignedRtcRefusal(): SignedRtcRefusalReason | null {
    return this.signedRtcRefusal;
  }

  getTerminalReason(): HostControlTerminalReason | null {
    return this.terminalReason;
  }

  waitUntilReady(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    this.connect();
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      let settled = false;
      const timer = setTimeout(
        () => {
          unsubscribe();
          reject(new HostControlError("connect_timeout", "Host control connection timed out"));
        },
        Math.max(1, timeoutMs),
      );
      unsubscribe = this.subscribe((state) => {
        if (state !== "ready") return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
      if (settled) unsubscribe();
    });
  }

  close(): void {
    this.stopped = true;
    this.uninstallGlobalListeners();
    this.connectionAttempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearConnectDeadline();
    this.clearSignalWatchdog();
    this.clearRtcRecoveryTimers();
    this.finishRtcConfigRefresh();
    this.cleanupRtc(true);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.detachWebSocket(ws);
      ws.close(1000, "host control closed");
    }
    this.rejectPending(new Error("Host control connection closed"));
    this.setState("closed");
  }

  request<T = unknown>(
    operation: string,
    payload?: unknown,
    options: HostControlRequestOptions = {},
  ): Promise<T> {
    const channel = this.channel;
    if (this.state !== "ready" || channel?.readyState !== "open") {
      return Promise.reject(new Error("Host control channel is not ready"));
    }
    if (this.pending.size >= this.maxPendingRequests()) {
      return Promise.reject(new Error("Too many pending host control requests"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new DOMException("Host control request aborted", "AbortError"));
    }
    const requestId = crypto.randomUUID();
    const frame = JSON.stringify({
      version: HOST_CONTROL_VERSION,
      type: "request",
      request_id: requestId,
      operation,
      ...(payload === undefined ? {} : { payload }),
    });
    if (new TextEncoder().encode(frame).byteLength > MAX_CONTROL_FRAME_BYTES) {
      return Promise.reject(new Error("Host control request is too large"));
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = Math.max(
        1,
        options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      const timer = setTimeout(() => {
        const current = this.finishPending(requestId);
        if (!current) return;
        this.sendCancel(requestId);
        current.reject(
          this.requestAcknowledgementLost(current, new Error("Host control request timed out")),
        );
      }, timeoutMs);
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        mutation: INDETERMINATE_REQUEST_OPERATIONS.has(operation),
        dispatched: false,
      };
      if (options.signal) {
        const onAbort = () => {
          const current = this.finishPending(requestId);
          if (!current) return;
          this.sendCancel(requestId);
          current.reject(
            this.requestAcknowledgementLost(
              current,
              new DOMException("Host control request aborted", "AbortError"),
            ),
          );
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.pending.set(requestId, pending);
      try {
        channel.send(frame);
        pending.dispatched = true;
      } catch (error) {
        this.finishPending(requestId);
        reject(error instanceof Error ? error : new Error("Host control send failed"));
      }
    });
  }

  ping(options?: HostControlRequestOptions): Promise<{ pong: true }> {
    return this.request<{ pong: true }>("ping", undefined, options);
  }

  home(options?: HostControlRequestOptions): Promise<{ home_dir: string }> {
    return this.request<{ home_dir: string }>("fs.home", undefined, options);
  }

  async listPage(
    path?: string,
    cursor = 0,
    options?: HostControlRequestOptions,
  ): Promise<HostDirList> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new HostControlError(
        "invalid_request",
        "Directory cursor must be a non-negative integer",
      );
    }
    const page = await this.request<HostDirList>(
      "fs.list",
      { ...(path ? { path } : {}), cursor },
      options,
    );
    const nextCursor = page?.next_cursor;
    if (
      !page ||
      typeof page.path !== "string" ||
      typeof page.home_dir !== "string" ||
      !Array.isArray(page.entries) ||
      page.entries.length > HOST_DIRECTORY_PAGE_ENTRIES ||
      (page.truncated !== undefined && typeof page.truncated !== "boolean") ||
      (nextCursor !== undefined &&
        nextCursor !== null &&
        (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor))
    ) {
      this.failRtc();
      throw new HostControlError("invalid_response", "Host returned an invalid directory page");
    }
    return { ...page, next_cursor: typeof nextCursor === "number" ? nextCursor : null };
  }

  /** Return only the first page. Call listPage with next_cursor to continue. */
  list(path?: string, options?: HostControlRequestOptions): Promise<HostDirList> {
    return this.listPage(path, 0, options);
  }

  mkdir(path: string, options?: HostControlRequestOptions): Promise<HostFileOp> {
    return this.request<HostFileOp>("fs.mkdir", { path }, options);
  }

  rename(
    path: string,
    name: string,
    overwrite = false,
    options?: HostControlRequestOptions,
  ): Promise<HostFileOp> {
    return this.request<HostFileOp>("fs.rename", { path, name, overwrite }, options);
  }

  remove(
    path: string,
    recursive = false,
    options?: HostControlRequestOptions,
  ): Promise<HostFileOp> {
    return this.request<HostFileOp>("fs.remove", { path, recursive }, options);
  }

  /**
   * Issue a stream-producing request and wire up its incoming half.
   *
   * `fs.read`, `fs.read.range` and `fs.preview` all follow the same shape — a
   * declaration carrying `stream_id`/`length`/`sha256`, then chunk frames under
   * an ack window. The window, the running digest, the timeout, the cancel
   * tombstone: all of it is integrity-critical and exists exactly once, here.
   */
  private async beginStream<T extends { stream_id: string; length: number; sha256: string }>(
    operation: string,
    payload: Record<string, unknown>,
    options?: HostControlRequestOptions,
  ): Promise<{ declaration: T; stream: ReadableStream<Uint8Array> }> {
    const declaration = await this.request<T>(operation, payload, options);
    const { stream_id: streamId, length, sha256 } = declaration ?? ({} as T);
    this.pruneIncomingTombstones();
    if (
      typeof streamId !== "string" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      this.incomingStreams.has(streamId) ||
      this.cancelledIncomingStreams.has(streamId)
    ) {
      this.failRtc();
      throw new HostControlError("invalid_response", "Host returned an invalid read stream");
    }
    let state: IncomingStream | undefined;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          state = {
            controller,
            nextSequence: 0,
            acknowledged: 0,
            received: 0,
            expectedLength: length,
            expectedSha256: sha256,
            hash: new Sha256(),
          };
          this.incomingStreams.set(streamId, state);
          this.resetIncomingTimeout(streamId, state);
        },
        pull: () => {
          const current = this.incomingStreams.get(streamId);
          if (!current || current.acknowledged >= current.nextSequence) return;
          current.acknowledged += 1;
          this.sendStreamFrame("stream.ack", streamId, { sequence: current.acknowledged });
        },
        cancel: () => {
          const current = this.incomingStreams.get(streamId);
          if (current) clearTimeout(current.timer);
          if (current && !this.rememberIncomingCancellation(streamId, current)) {
            this.failRtc();
            return;
          }
          this.incomingStreams.delete(streamId);
          this.cancelStream(streamId);
        },
      },
      { highWaterMark: 4 },
    );
    if (!state) throw new HostControlError("stream_failed", "Could not initialize file stream");
    return { declaration, stream };
  }

  async readFile(path: string, options?: HostControlRequestOptions): Promise<HostReadStream> {
    const { declaration, stream } = await this.beginStream<{
      stream_id: string;
      path: string;
      name: string;
      length: number;
      sha256: string;
    }>("fs.read", { path }, options);
    return {
      streamId: declaration.stream_id,
      path: declaration.path,
      name: declaration.name,
      length: declaration.length,
      sha256: declaration.sha256,
      stream,
    };
  }

  /**
   * Read a bounded slice.
   *
   * Distinct from `fs.read` rather than an option on it, deliberately: an older
   * daemon ignores unknown payload keys, so a ranged `fs.read` would silently
   * stream — and whole-file hash — a 512 MiB video when 4 KiB was wanted. A
   * separate operation earns a clean `unsupported_operation` instead.
   *
   * `sha256` here covers the returned slice, not the file, so the digest check
   * that guards `fs.read` guards this identically.
   */
  async readRange(
    path: string,
    offset: number,
    length: number,
    options?: HostControlRequestOptions,
  ): Promise<HostRangeStream> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HostControlError("invalid_request", "Range offset must be a non-negative integer");
    }
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_RANGE_BYTES) {
      throw new HostControlError("invalid_request", "Range length must be between 1 and 16 MiB");
    }
    const { declaration, stream } = await this.beginStream<{
      stream_id: string;
      path: string;
      name: string;
      offset: number;
      length: number;
      file_size: number;
      sha256: string;
      version?: string;
      content_type?: string;
      preview_kind?: string;
      open_allowed?: boolean;
      eof?: boolean;
    }>("fs.read.range", { path, offset, length }, options);
    // The host may return less than asked for (a short tail) but never more:
    // more would mean the digest covers bytes we did not budget for.
    if (declaration.length > length) {
      await stream.cancel("oversized range");
      this.failRtc();
      throw new HostControlError("invalid_response", "Host returned more bytes than requested");
    }
    return {
      streamId: declaration.stream_id,
      path: declaration.path,
      name: declaration.name,
      length: declaration.length,
      sha256: declaration.sha256,
      offset: declaration.offset,
      fileSize: declaration.file_size,
      version: declaration.version ?? null,
      contentType: declaration.content_type ?? null,
      openAllowed: declaration.open_allowed === true,
      eof: declaration.eof === true,
      stream,
    };
  }

  /**
   * Ask the host to render a preview image for a file the browser cannot draw.
   *
   * `maxPixels` is an allowlist rather than a clamp: a free integer lets a
   * caller ask a third-party QuickLook generator for a 16384px render and
   * allocate a gigabyte on someone's laptop.
   */
  async previewImage(
    path: string,
    maxPixels: number,
    options?: HostControlRequestOptions,
  ): Promise<HostPreviewStream> {
    if (!PREVIEW_PIXEL_SIZES.includes(maxPixels)) {
      throw new HostControlError("invalid_request", "Unsupported preview size");
    }
    const { declaration, stream } = await this.beginStream<{
      stream_id: string;
      path: string;
      name: string;
      length: number;
      sha256: string;
      content_type?: string;
      width?: number;
      height?: number;
      version?: string;
    }>(
      "fs.preview",
      { path, max_pixels: maxPixels },
      { timeoutMs: PREVIEW_REQUEST_TIMEOUT_MS, ...options },
    );
    return {
      streamId: declaration.stream_id,
      path: declaration.path,
      name: declaration.name,
      length: declaration.length,
      sha256: declaration.sha256,
      mime: declaration.content_type ?? "image/png",
      width: declaration.width ?? 0,
      height: declaration.height ?? 0,
      version: declaration.version ?? null,
      stream,
    };
  }

  /**
   * The first `limit` bytes of a file.
   *
   * Never cancels a whole-file read to get them. Cancelling leaves a tombstone,
   * and enough live tombstones tear the control channel down — a disconnect is
   * a far worse outcome than a missing preview. So: read it whole when it is
   * already small enough, use a real ranged read when the host offers one, and
   * otherwise decline.
   */
  async readHead(
    path: string,
    limit: number,
    options: HostControlRequestOptions & { size?: number | null } = {},
  ): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
    const { size, ...request } = options;
    if (typeof size === "number" && size <= limit) {
      const read = await this.readFile(path, request);
      const bytes = await collectStream(read.stream);
      return { bytes, total: read.length, truncated: false };
    }
    if (!this.hasCapability("fs.read.range")) {
      throw new HostControlError(
        "range_unsupported",
        "This host cannot read part of a file, and the file is too large to read whole",
      );
    }
    const read = await this.readRange(path, 0, limit, request);
    const bytes = await collectStream(read.stream);
    return { bytes, total: read.fileSize, truncated: !read.eof };
  }

  /** Metadata for one entry, without listing its parent. */
  async stat(path: string, options?: HostControlRequestOptions): Promise<HostFileStat> {
    const result = await this.request<HostFileStat>("fs.stat", { path }, options);
    if (
      !result ||
      typeof result.path !== "string" ||
      typeof result.name !== "string" ||
      typeof result.kind !== "string" ||
      (result.size !== null && result.size !== undefined && !Number.isSafeInteger(result.size))
    ) {
      this.failRtc();
      throw new HostControlError("invalid_response", "Host returned an invalid file stat");
    }
    return result;
  }

  /**
   * Select the file in the host's file manager.
   *
   * Reveal never executes the target, so unlike `openDefault` it is offered for
   * any path the daemon will resolve, directories included.
   */
  reveal(path: string, options?: HostControlRequestOptions): Promise<HostFileOp> {
    return this.request<HostFileOp>("desktop.reveal", { path }, options);
  }

  /**
   * Hand the file to the host's default application for its type.
   *
   * The payload is a path and nothing else — there is no field for an
   * application, arguments or flags, so no caller can steer what gets launched.
   * The daemon still re-checks the file itself on every call; anything this
   * client believes about openability is a hint for the menu, never a grant.
   */
  openDefault(path: string, options?: HostControlRequestOptions): Promise<HostFileOp> {
    return this.request<HostFileOp>("desktop.open", { path }, options);
  }

  /**
   * Exact capacity for this host, straight from its daemon.
   *
   * The whole point of asking here rather than reading the host list: the
   * server is given a five-level bucket every thirty seconds, and these
   * numbers have no server code path at all (see `daemon/src/host_metrics.rs`
   * and docs/TRUST.md). A host with telemetry switched off never advertises
   * `host.metrics`, so callers must gate on `hasCapability` and draw nothing
   * rather than showing an empty gauge.
   */
  async metrics(options?: HostControlRequestOptions): Promise<HostMetrics> {
    const result = await this.request<HostMetrics>("host.metrics", {}, options);
    const sample = result?.sample;
    if (
      !sample ||
      typeof sample.cpu_percent !== "number" ||
      !Number.isFinite(sample.cpu_percent) ||
      !Number.isSafeInteger(sample.memory_total_bytes) ||
      !Number.isSafeInteger(sample.memory_used_bytes)
    ) {
      // Same posture as `stat`: a malformed answer on this channel means the
      // peer is not the daemon this client thinks it is talking to.
      this.failRtc();
      throw new HostControlError("invalid_response", "Host returned an invalid capacity sample");
    }
    return result;
  }

  /** Operations this generation's daemon advertised in its `hello`. */
  getCapabilities(): ReadonlySet<string> {
    return this.capabilities;
  }

  hasCapability(operation: string): boolean {
    return this.capabilities.has(operation);
  }

  async downloadFile(path: string, options?: HostControlRequestOptions): Promise<Blob> {
    const read = await this.readFile(path, options);
    if (read.length > FALLBACK_DOWNLOAD_MEMORY_LIMIT) {
      await read.stream.cancel("native streaming download unavailable");
      throw new HostControlError(
        "streaming_download_required",
        "This browser must provide a streaming file destination for downloads over 32 MiB",
      );
    }
    return new Response(read.stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(read.length),
      },
    }).blob();
  }

  async saveFileToBrowser(path: string, suggestedName: string): Promise<void> {
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
          createWritable: () => Promise<WritableStream<Uint8Array>>;
        }>;
      }
    ).showSaveFilePicker;
    if (picker) {
      // Invoke the picker before any network await so the browser still sees
      // this as part of the user's click gesture.
      const handle = await picker({ suggestedName });
      const read = await this.readFile(path);
      const writable = await handle.createWritable();
      await read.stream.pipeTo(writable);
      return;
    }
    const blob = await this.downloadFile(path);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async uploadFile(
    file: File,
    options: { dir: string; overwrite?: boolean; signal?: AbortSignal },
  ): Promise<HostFileOp> {
    const sha256 = await hashStream(file.stream());
    const path = await this.writeStream(
      file.stream(),
      {
        dir: options.dir,
        name: file.name || "file",
        length: file.size,
        sha256,
        overwrite: options.overwrite,
      },
      options.signal,
    );
    return { path };
  }

  async writeStream(
    stream: ReadableStream<Uint8Array>,
    declaration: {
      dir: string;
      name: string;
      length: number;
      sha256: string;
      overwrite?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const begin = await this.request<{ stream_id: string }>("fs.write.begin", declaration, {
      signal,
      timeoutMs: this.streamTimeoutMs(),
    });
    const streamId = begin.stream_id;
    if (typeof streamId !== "string" || this.outgoingStreams.has(streamId)) {
      throw new HostControlError("invalid_response", "Host returned an invalid write stream");
    }
    let terminalError: Error | null = null;
    let rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<never>((_, reject) => {
      rejectTerminal = reject;
    });
    // The failure promise is deliberately raced with every blocking pump step.
    // Attach a handler immediately in case the peer fails before the first read.
    void terminal.catch(() => {});
    let outgoing!: OutgoingStream;
    const committed = new Promise<string>((resolve, reject) => {
      outgoing = {
        resolve,
        reject: (error: Error) => {
          terminalError ??= error;
          rejectTerminal(error);
          reject(error);
        },
        commitDispatched: false,
        cancelSent: false,
      };
      this.outgoingStreams.set(streamId, outgoing);
      this.resetOutgoingTimeout(streamId, outgoing);
    });
    void committed.catch(() => {});
    const reader = stream.getReader();
    let cleanup: Promise<void> | null = null;
    const stop = (reason: Error): Promise<void> => {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        this.cancelOutgoing(streamId, outgoing);
        const pending = this.outgoingStreams.get(streamId);
        if (pending) {
          clearTimeout(pending.timer);
          this.outgoingStreams.delete(streamId);
          pending.reject(this.writeAcknowledgementLost(pending, reason));
        }
        await reader.cancel(reason).catch(() => {});
      })();
      return cleanup;
    };
    const abort = () => {
      void stop(new DOMException("Host file write aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const raceTerminal = async <T>(operation: Promise<T>): Promise<T> => {
      if (terminalError) throw terminalError;
      return await Promise.race([operation, terminal]);
    };
    let sequence = 0;
    let sent = 0;
    try {
      for (;;) {
        if (signal?.aborted) throw new DOMException("Host file write aborted", "AbortError");
        const { done, value } = await raceTerminal(reader.read());
        if (done) break;
        for (let offset = 0; offset < value.byteLength; offset += STREAM_CHUNK_BYTES) {
          const chunk = value.subarray(offset, offset + STREAM_CHUNK_BYTES);
          sent += chunk.byteLength;
          if (sent > declaration.length) {
            throw new HostControlError("length_mismatch", "Input exceeds declared length");
          }
          await raceTerminal(this.waitForWritable(signal));
          if (terminalError) throw terminalError;
          this.sendStreamFrame("stream.chunk", streamId, {
            sequence,
            bytes_b64: bytesToBase64(chunk),
          });
          const pending = this.outgoingStreams.get(streamId);
          if (pending) this.resetOutgoingTimeout(streamId, pending);
          sequence += 1;
        }
      }
      if (sent !== declaration.length) {
        throw new HostControlError("length_mismatch", "Input does not match declared length");
      }
      if (terminalError) throw terminalError;
      this.sendStreamFrame("stream.end", streamId, {
        length: declaration.length,
        sha256: declaration.sha256,
      });
      const pending = this.outgoingStreams.get(streamId);
      if (pending) pending.commitDispatched = true;
      return await committed;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Host file write failed");
      await stop(failure);
      throw failure;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (cleanup) await cleanup;
      reader.releaseLock();
    }
  }

  async transferFileTo(
    destination: HostControlClient,
    path: string,
    destDir: string,
    overwrite = false,
    signal?: AbortSignal,
  ): Promise<HostFileOp> {
    const source = await this.readFile(path, { signal, timeoutMs: this.streamTimeoutMs() });
    try {
      const destinationPath = await destination.writeStream(
        source.stream,
        {
          dir: destDir,
          name: source.name,
          length: source.length,
          sha256: source.sha256,
          overwrite,
        },
        signal,
      );
      return { path: destinationPath };
    } catch (error) {
      await source.stream.cancel(error).catch(() => {});
      throw error;
    }
  }

  private openWebSocket(): void {
    if (this.stopped) return;
    this.prefetchTrustDecision();
    const attempt = ++this.connectionAttempt;
    const preserveHealthyRtc = this.hasHealthyRtc();
    let resumeNeeded = preserveHealthyRtc;
    const previous = this.ws;
    this.ws = null;
    if (previous) {
      this.detachWebSocket(previous);
      previous.close();
    }
    if (!preserveHealthyRtc) this.setState("connecting");
    this.clearConnectDeadline();
    if (!preserveHealthyRtc) {
      this.connectTimer = setTimeout(
        () => {
          if (attempt !== this.connectionAttempt || this.stopped) return;
          this.connectTimer = null;
          this.failRtc();
        },
        Math.max(1, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS),
      );
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildHostWsUrl(this.hostId), HOST_SIGNAL_SUBPROTOCOL);
    } catch {
      this.setState("error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let pingSeen = false;
    const armWatchdog = () => {
      if (!pingSeen || !this.isCurrentWebSocket(ws, attempt)) return;
      this.clearSignalWatchdog();
      this.signalWatchdogTimer = setTimeout(
        () => {
          if (this.isCurrentWebSocket(ws, attempt)) ws.close(4008, "keepalive timeout");
        },
        Math.max(1, this.options.watchdogMs ?? SIGNAL_WATCHDOG_MS),
      );
    };
    ws.onopen = () => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      this.lastSignalFrameAt = Date.now();
      if (!this.hasHealthyRtc()) this.setState("open");
    };
    ws.onmessage = (event) => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      this.lastSignalFrameAt = Date.now();
      if (typeof event.data !== "string") {
        if (this.signedRtcSession !== null) this.failRtc();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        this.failRtc();
        return;
      }
      if (!isJsonObject(parsed)) {
        this.failRtc();
        return;
      }
      if (pingSeen) armWatchdog();
      if (parsed.type === "ping") {
        pingSeen = true;
        this.reconnectAttempt = 0;
        armWatchdog();
        if (typeof parsed.ts === "number" && Number.isFinite(parsed.ts)) {
          ws.send(JSON.stringify({ type: "pong", ts: parsed.ts }));
        }
        return;
      }
      if (parsed.type === "error") {
        this.reconnectAttempt = 0;
        if (this.resumeInFlight) this.fallBackFromResume();
        return;
      }
      const message = parsed as unknown as SignalMessage;
      if (!this.matchesMetadata(message)) {
        if (message.type === "rtc.answer" && this.signedRtcSession !== null) this.failRtc();
        return;
      }
      this.reconnectAttempt = 0;
      if (message.type === "rtc.config" && message.enabled) {
        if (!this.hasHealthyRtc()) this.setState("open");
        this.latestIceServers = sanitizeIceServers(message.ice_servers ?? []);
        this.latestIceTransportPolicy = message.ice_transport_policy === "relay" ? "relay" : "all";
        this.finishRtcConfigRefresh();
        if (resumeNeeded && this.hasHealthyRtc()) {
          resumeNeeded = false;
          this.resumeHealthyRtc(ws, attempt);
        } else if (!this.pc) {
          void this.startRtc(this.latestIceServers, this.latestIceTransportPolicy, ws, attempt);
        } else if (this.pc.connectionState !== "connected") {
          void this.restartIce("wake");
        }
      } else if (message.type === "rtc.config") {
        this.latestIceServers = null;
        this.finishRtcConfigRefresh();
        this.cleanupRtc(true);
        this.setState("error");
      } else if (message.type === "rtc.answer" && this.signedRtcSession !== null) {
        this.captureBindingMetadata(message);
        const pc = this.pc;
        const session = this.signedRtcSession;
        const expectedSessionId = this.sessionId ?? undefined;
        if (!pc || expectedSessionId === undefined) {
          this.failRtc(expectedSessionId);
          return;
        }
        void session
          .verifyAndApplyAnswer(pc, message)
          .then(() => {
            if (!this.isCurrentWebSocket(ws, attempt) || this.pc !== pc) return;
            for (const candidate of this.pendingRemoteCandidates.splice(0)) {
              void pc.addIceCandidate(candidate).catch(() => {});
            }
          })
          .catch(() => {
            if (this.isCurrentWebSocket(ws, attempt)) this.failRtc(expectedSessionId);
          });
      } else if (
        message.type === "rtc.answer" &&
        !this.signedRtcRequired &&
        message.session_id === this.sessionId
      ) {
        this.captureBindingMetadata(message);
        // Legacy unpinned (TOFU) path only. Once this generation has selected
        // signed mode, signedRtcRequired stays true for its whole lifetime, so
        // a raw answer can never reach the peer's remote-description setter here
        // — even in the window before signedRtcSession is armed; it is dropped.
        const pc = this.pc;
        if (!pc) return;
        if (typeof message.sdp !== "string") {
          this.failRtc(message.session_id);
          return;
        }
        void pc
          .setRemoteDescription({ type: "answer", sdp: message.sdp })
          .then(() => {
            if (!this.isCurrentWebSocket(ws, attempt) || this.pc !== pc) return;
            for (const candidate of this.pendingRemoteCandidates.splice(0)) {
              void pc.addIceCandidate(candidate).catch(() => {});
            }
          })
          .catch(() => {
            if (this.isCurrentWebSocket(ws, attempt)) this.failRtc(message.session_id);
          });
      } else if (message.type === "rtc.candidate" && message.session_id === this.sessionId) {
        this.captureBindingMetadata(message);
        if (this.pc?.remoteDescription) {
          void this.pc.addIceCandidate(message.candidate).catch(() => {});
        } else {
          this.pendingRemoteCandidates.push(message.candidate);
        }
      } else if (message.type === "rtc.status" && message.session_id === this.sessionId) {
        this.captureBindingMetadata(message);
        if (["resumed", "rebound", "signalling_lost", "connected"].includes(message.status)) {
          if (message.status === "resumed") this.clearRtcResumeTimer();
          return;
        }
        if (this.resumeInFlight && message.status === "unavailable") {
          this.fallBackFromResume();
          return;
        }
        if (["failed", "disabled", "unavailable"].includes(message.status)) {
          this.failRtc(message.session_id);
        }
      }
    };
    ws.onerror = () => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      this.setState("error");
    };
    ws.onclose = (event) => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      this.detachWebSocket(ws);
      this.ws = null;
      this.clearSignalWatchdog();
      this.clearConnectDeadline();
      this.finishRtcConfigRefresh();
      this.clearRtcResumeTimer();
      const action = socketCloseAction(event?.code ?? 1006);
      if (
        !this.hasHealthyRtc() ||
        action === "unauthorized" ||
        action === "client_bug" ||
        action === "client_stale"
      ) {
        this.cleanupRtc(false);
      }
      if (action === "client_stale") {
        this.terminalReason = "protocol_required";
        this.setState("error");
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("spawn:client-stale", { detail: { hard: true } }));
        }
        return;
      }
      if (action === "unauthorized") {
        this.stopped = true;
        this.setState("unauthorized");
        notifySocketUnauthorized();
        return;
      }
      if (action === "client_bug") {
        this.terminalReason = "client_bug";
        this.setState("error");
        console.error("SPAWN D host signalling stopped after a client protocol error.");
        return;
      }
      if (action === "reconnect_immediately") {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.openWebSocket();
        }, 0);
        return;
      }
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private async startRtc(
    iceServers: RTCIceServer[],
    iceTransportPolicy: RTCIceTransportPolicy,
    ws: WebSocket,
    attempt: number,
  ): Promise<void> {
    if (!this.isCurrentWebSocket(ws, attempt)) return;
    this.cleanupRtc(true);
    if (!this.isCurrentWebSocket(ws, attempt) || ws.readyState !== WebSocket.OPEN) return;
    const sessionId = crypto.randomUUID();
    let pc: RTCPeerConnection;
    let channel: RTCDataChannel;
    try {
      pc = new RTCPeerConnection({
        iceServers: sanitizeIceServers(iceServers),
        iceTransportPolicy,
        iceCandidatePoolSize: RTC_ICE_CANDIDATE_POOL_SIZE,
      });
      channel = pc.createDataChannel(HOST_CONTROL_PROTOCOL, { ordered: true });
    } catch {
      this.failRtc();
      return;
    }
    this.pc = pc;
    this.channel = channel;
    this.sessionId = sessionId;
    this.bindingNonce = null;
    this.bindingGeneration = null;
    this.pendingRemoteCandidates = [];
    // Locally-gathered ICE candidates carry the session_id. Emitting them
    // before the (possibly signed) offer is armed and sent would disclose the
    // session to the server ahead of the signed envelope, reopening the raw
    // remote-answer race. Buffer them until the offer is on the wire.
    let offerSent = false;
    const pendingLocalCandidates: RTCIceCandidateInit[] = [];
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.sessionId !== sessionId || !this.isCurrentWebSocket(ws, attempt))
        return;
      const candidate = event.candidate.toJSON();
      if (!offerSent) {
        pendingLocalCandidates.push(candidate);
        return;
      }
      this.sendSignal(
        {
          type: "rtc.candidate",
          session_id: sessionId,
          candidate,
          ...(this.bindingNonce ? { binding_nonce: this.bindingNonce } : {}),
          ...(this.bindingGeneration !== null
            ? { binding_generation: this.bindingGeneration }
            : {}),
        },
        ws,
        attempt,
      );
    };
    this.localCandidateGate = {
      block: () => {
        offerSent = false;
      },
      release: () => {
        offerSent = true;
        for (const candidate of pendingLocalCandidates.splice(0)) {
          this.sendSignal(
            {
              type: "rtc.candidate",
              session_id: sessionId,
              candidate,
              ...(this.bindingNonce ? { binding_nonce: this.bindingNonce } : {}),
              ...(this.bindingGeneration !== null
                ? { binding_generation: this.bindingGeneration }
                : {}),
            },
            ws,
            attempt,
          );
        }
      },
    };
    pc.onconnectionstatechange = () => {
      if (this.sessionId !== sessionId || this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        this.clearRtcDisconnectedTimer();
      } else if (pc.connectionState === "disconnected") {
        if (!this.rtcDisconnectedTimer) {
          this.rtcDisconnectedTimer = setTimeout(() => {
            this.rtcDisconnectedTimer = null;
            if (this.sessionId === sessionId && pc.connectionState === "disconnected") {
              void this.restartIce("disconnected");
            }
          }, RTC_DISCONNECTED_GRACE_MS);
        }
      } else if (pc.connectionState === "failed") {
        void this.restartIce("failed");
      } else if (pc.connectionState === "closed") {
        this.failRtc(sessionId);
      }
    };
    channel.onmessage = (event) => {
      if (this.sessionId !== sessionId || this.channel !== channel) return;
      this.handleControlMessage(event.data, sessionId);
    };
    channel.onclose = () => {
      if (this.sessionId === sessionId && this.channel === channel) this.failRtc(sessionId);
    };
    channel.onerror = () => {
      if (this.sessionId !== sessionId || this.channel !== channel) return;
      this.setState("error");
      this.failRtc(sessionId);
    };

    try {
      // Resolve trust BEFORE creating the offer: the decision reads IndexedDB,
      // and deciding afterwards delays the offer past ICE gathering, which both
      // emits candidates ahead of the offer and biases ICE toward a relay pair.
      let decision: SignedRtcTrustDecision = { mode: "unpinned" };
      if (this.options.resolveSignedRtcTrust) {
        const decisionPromise = this.prefetchedTrustDecision ?? this.resolveTrustDecision();
        this.prefetchedTrustDecision = null;
        decision = await decisionPromise;
        if (this.sessionId !== sessionId || !this.isCurrentWebSocket(ws, attempt)) return;
      }
      if (decision.mode === "refuse") {
        // Host identity could not be verified against a local pin. Refuse the
        // control channel outright — no raw fallback, no auto-reconnect.
        this.signedRtcRefusal = decision.reason;
        this.setState("error");
        this.failRtc(sessionId);
        return;
      }
      this.signedRtcRefusal = null;
      // Commit to signed mode for this generation BEFORE gathering starts, so
      // the legacy raw-answer branch is gated off for the entire lifetime of a
      // signed generation, not only once signedRtcSession is assigned below.
      this.signedRtcRequired = decision.mode === "signed";

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.sessionId !== sessionId || !this.isCurrentWebSocket(ws, attempt)) return;
      const nextSignedRtcSession =
        decision.mode === "signed"
          ? new SignedRtcLiveSession(
              {
                scopeType: "host",
                scopeId: this.hostId,
                protocol: HOST_CONTROL_PROTOCOL,
                protocolVersion: HOST_CONTROL_VERSION,
              },
              sessionId,
              decision.capability,
            )
          : null;
      const carrier = nextSignedRtcSession
        ? await nextSignedRtcSession.createOffer(offer.sdp ?? "")
        : { sdp: offer.sdp ?? "" };
      // A device the host does not directly pin carries its account endorsement
      // edges so the daemon can admit it via a chain to an anchor (device mesh
      // §3). Best-effort: on failure the offer still goes, and a directly-pinned
      // device is admitted exactly as before.
      let carried: CarriedEndorsement[] = [];
      if (nextSignedRtcSession && this.options.loadCarriedEndorsements) {
        try {
          carried = await this.options.loadCarriedEndorsements();
        } catch {
          carried = [];
        }
      }
      if (this.sessionId !== sessionId || !this.isCurrentWebSocket(ws, attempt)) return;
      this.signedRtcSession = nextSignedRtcSession;
      const offerFrame: Record<string, unknown> = {
        type: "rtc.offer",
        session_id: sessionId,
        ...carrier,
      };
      if (carried.length > 0) offerFrame.carried_endorsements = carried;
      this.sendSignal(offerFrame, ws, attempt);
      // The offer (signed envelope when signed) is now the first frame that can
      // disclose this session to the server. Only now release the buffered
      // local candidates, and let later ones flow directly.
      this.localCandidateGate?.release();
    } catch {
      if (this.isCurrentWebSocket(ws, attempt)) this.failRtc(sessionId);
    }
  }

  private async resolveTrustDecision(): Promise<SignedRtcTrustDecision> {
    if (!this.options.resolveSignedRtcTrust) return { mode: "unpinned" };
    return this.options
      .resolveSignedRtcTrust()
      .catch(() => ({ mode: "refuse", reason: "pin_storage_error" }) as const);
  }

  private prefetchTrustDecision(): void {
    if (this.options.resolveSignedRtcTrust) {
      this.prefetchedTrustDecision ??= this.resolveTrustDecision();
    }
  }

  private captureBindingMetadata(message: HostBindingMetadata): void {
    if (typeof message.binding_nonce === "string" && /^[0-9a-f]{32}$/.test(message.binding_nonce)) {
      this.bindingNonce = message.binding_nonce;
    }
    if (
      typeof message.binding_generation === "number" &&
      Number.isSafeInteger(message.binding_generation) &&
      message.binding_generation > 0
    ) {
      this.bindingGeneration = message.binding_generation;
    }
  }

  private async refreshRtcConfigIfStale(): Promise<void> {
    if (!this.latestIceServers || !iceServersNeedRefresh(this.latestIceServers)) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.rtcConfigRefreshResolve) {
      await new Promise<void>((resolve) => {
        const previous = this.rtcConfigRefreshResolve;
        this.rtcConfigRefreshResolve = () => {
          previous?.();
          resolve();
        };
      });
      return;
    }
    ws.send(JSON.stringify({ type: "rtc.config.request" }));
    await new Promise<void>((resolve) => {
      this.rtcConfigRefreshResolve = resolve;
      this.rtcConfigRefreshTimer = setTimeout(
        () => this.finishRtcConfigRefresh(),
        RTC_CONFIG_REFRESH_TIMEOUT_MS,
      );
    });
  }

  private async startRtcWithLatest(): Promise<void> {
    await this.refreshRtcConfigIfStale();
    const ws = this.ws;
    if (
      this.stopped ||
      this.pc ||
      !this.latestIceServers ||
      !ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    await this.startRtc(
      this.latestIceServers,
      this.latestIceTransportPolicy,
      ws,
      this.connectionAttempt,
    );
  }

  /**
   * "Restart" on the host channel is a rebuild of its peer on the same socket.
   *
   * The daemon has no host-scope ICE restart: `create_host_answer` refuses a
   * second offer for a signal id it already holds a peer for, and its host
   * dispatch never reads `ice_restart`. A restart offer sent here can only
   * come back `failed`, which tears the websocket down and redials with
   * backoff — a far worse recovery than the in-place rebuild this had always
   * performed in practice, because the restart's `setConfiguration` threw in
   * Chromium (#71) and the catch block rebuilt. Until the daemon gains the
   * branch, the rebuild is the contract, stated rather than stumbled into.
   */
  private async restartIce(_reason: "disconnected" | "failed" | "wake"): Promise<void> {
    const pc = this.pc;
    const sessionId = this.sessionId;
    if (!pc || !sessionId) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.fallBackToFreshRtc(sessionId);
  }

  private fallBackToFreshRtc(expectedSessionId: string | null): void {
    if (!expectedSessionId || this.sessionId !== expectedSessionId) return;
    this.cleanupRtc(true);
    this.prefetchTrustDecision();
    if (this.ws?.readyState === WebSocket.OPEN && this.latestIceServers) {
      void this.startRtcWithLatest();
    } else {
      this.scheduleReconnect();
    }
  }

  private hasHealthyRtc(): boolean {
    return this.pc?.connectionState === "connected" && this.channel?.readyState === "open";
  }

  private resumeHealthyRtc(ws: WebSocket, attempt: number): boolean {
    if (!this.hasHealthyRtc()) return false;
    if (!this.sessionId || !this.bindingNonce || this.bindingGeneration === null) {
      this.fallBackFromResume();
      return false;
    }
    if (this.resumeInFlight) return true;
    this.resumeInFlight = true;
    this.sendSignal(
      {
        type: "rtc.resume",
        session_id: this.sessionId,
        binding_nonce: this.bindingNonce,
        binding_generation: this.bindingGeneration,
      },
      ws,
      attempt,
    );
    this.rtcResumeTimer = setTimeout(
      () => this.fallBackFromResume(),
      Math.max(1, this.options.resumeTimeoutMs ?? RTC_RESUME_TIMEOUT_MS),
    );
    return true;
  }

  private fallBackFromResume(): void {
    this.clearRtcResumeTimer();
    this.cleanupRtc(false);
    this.prefetchTrustDecision();
    if (this.ws?.readyState === WebSocket.OPEN && this.latestIceServers) {
      void this.startRtcWithLatest();
    } else {
      this.scheduleReconnect();
    }
  }

  private handleControlMessage(raw: unknown, sessionId: string): void {
    if (this.sessionId !== sessionId) return;
    if (typeof raw !== "string") {
      this.failRtc(sessionId);
      return;
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_CONTROL_FRAME_BYTES) {
      this.failRtc(sessionId);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.failRtc(sessionId);
      return;
    }
    if (!isJsonObject(parsed)) {
      this.failRtc(sessionId);
      return;
    }
    const message = parsed as {
      version?: number;
      type?: string;
      protocol?: string;
      request_id?: string;
      ok?: boolean;
      result?: unknown;
      error?: { code?: string; detail?: string };
      stream_id?: string;
      sequence?: number;
      bytes_b64?: string;
      length?: number;
      sha256?: string;
      path?: string;
      capabilities?: unknown;
    };
    if (message.version !== HOST_CONTROL_VERSION) {
      this.failRtc(sessionId);
      return;
    }
    if (message.type === "hello" && message.protocol === HOST_CONTROL_PROTOCOL) {
      this.clearConnectDeadline();
      this.reconnectAttempt = 0;
      // Parsed before `ready` so no subscriber can observe a ready client with
      // an empty capability set and decide the host supports nothing. A
      // malformed list degrades to "offers nothing extra" rather than failing
      // the channel: the connection is fine, we just cannot read its menu.
      this.capabilities = parseCapabilities(message.capabilities);
      this.setState("ready");
      return;
    }
    if (message.type?.startsWith("stream.")) {
      if (typeof message.stream_id !== "string") {
        this.failRtc(sessionId);
        return;
      }
      if (message.type === "stream.chunk") {
        const incoming = this.incomingStreams.get(message.stream_id);
        if (!incoming) {
          const accepted = this.acceptCancelledIncomingChunk(
            message.stream_id,
            message.sequence,
            message.bytes_b64,
          );
          if (accepted === true) return;
          this.failRtc(sessionId);
          return;
        }
        if (message.sequence !== incoming.nextSequence || typeof message.bytes_b64 !== "string") {
          this.failRtc(sessionId);
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(message.bytes_b64);
        } catch {
          this.failRtc(sessionId);
          return;
        }
        if (
          bytes.byteLength === 0 ||
          bytes.byteLength > STREAM_CHUNK_BYTES ||
          incoming.received + bytes.byteLength > incoming.expectedLength
        ) {
          this.failRtc(sessionId);
          return;
        }
        incoming.nextSequence += 1;
        incoming.received += bytes.byteLength;
        incoming.hash.update(bytes);
        incoming.controller.enqueue(bytes);
        this.resetIncomingTimeout(message.stream_id, incoming);
        return;
      }
      if (message.type === "stream.end") {
        const incoming = this.incomingStreams.get(message.stream_id);
        if (!incoming) {
          const accepted = this.acceptCancelledIncomingEnd(
            message.stream_id,
            message.length,
            message.sha256,
          );
          if (accepted === true) return;
          this.failRtc(sessionId);
          return;
        }
        this.incomingStreams.delete(message.stream_id);
        clearTimeout(incoming.timer);
        const digest = incoming.hash.digestHex();
        if (
          message.length !== incoming.expectedLength ||
          incoming.received !== incoming.expectedLength ||
          message.sha256 !== incoming.expectedSha256 ||
          digest !== incoming.expectedSha256
        ) {
          incoming.controller.error(
            new HostControlError("integrity_mismatch", "Host file stream failed integrity checks"),
          );
        } else {
          incoming.controller.close();
        }
        return;
      }
      if (message.type === "stream.committed") {
        const outgoing = this.outgoingStreams.get(message.stream_id);
        if (!outgoing || typeof message.path !== "string") {
          this.failRtc(sessionId);
          return;
        }
        this.outgoingStreams.delete(message.stream_id);
        clearTimeout(outgoing.timer);
        outgoing.resolve(message.path);
        return;
      }
      if (message.type === "stream.error") {
        const error = new HostControlError(
          message.error?.code ?? "stream_failed",
          message.error?.detail,
        );
        const incoming = this.incomingStreams.get(message.stream_id);
        if (incoming) {
          this.incomingStreams.delete(message.stream_id);
          clearTimeout(incoming.timer);
          incoming.controller.error(error);
          return;
        }
        this.pruneIncomingTombstones();
        if (this.cancelledIncomingStreams.delete(message.stream_id)) return;
        const outgoing = this.outgoingStreams.get(message.stream_id);
        if (outgoing) {
          this.outgoingStreams.delete(message.stream_id);
          clearTimeout(outgoing.timer);
          outgoing.reject(error);
          return;
        }
        this.failRtc(sessionId);
        return;
      }
      this.failRtc(sessionId);
      return;
    }
    if (message.type !== "response" || typeof message.request_id !== "string") return;
    const pending = this.finishPending(message.request_id);
    if (!pending) return;
    if (message.ok) pending.resolve(message.result);
    else
      pending.reject(
        new HostControlError(
          message.error?.code ?? "request_failed",
          message.error?.detail ?? "Host control request failed",
        ),
      );
  }

  private sendSignal(
    values: Record<string, unknown>,
    expectedWs?: WebSocket,
    expectedAttempt?: number,
  ): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (expectedWs !== undefined && ws !== expectedWs) return;
    if (expectedAttempt !== undefined && this.connectionAttempt !== expectedAttempt) return;
    ws.send(
      JSON.stringify({
        ...values,
        scope_type: "host",
        scope_id: this.hostId,
        protocol: HOST_CONTROL_PROTOCOL,
        protocol_version: HOST_CONTROL_VERSION,
      }),
    );
  }

  private matchesMetadata(message: SignalMessage): boolean {
    return (
      message.scope_type === "host" &&
      message.scope_id === this.hostId &&
      message.protocol === HOST_CONTROL_PROTOCOL &&
      message.protocol_version === HOST_CONTROL_VERSION
    );
  }

  private sendCancel(requestId: string): void {
    if (this.channel?.readyState !== "open") return;
    try {
      this.channel.send(
        JSON.stringify({ version: HOST_CONTROL_VERSION, type: "cancel", request_id: requestId }),
      );
    } catch {
      // Cancellation is best-effort. Timeout/abort must still settle the
      // original request even if the channel failed between those steps.
    }
  }

  private sendStreamFrame(
    type: "stream.chunk" | "stream.end" | "stream.cancel" | "stream.ack",
    streamId: string,
    values: Record<string, unknown> = {},
  ): void {
    const channel = this.channel;
    if (channel?.readyState !== "open") {
      throw new HostControlError("connection_closed", "Host control channel is not open");
    }
    const frame = JSON.stringify({
      version: HOST_CONTROL_VERSION,
      type,
      stream_id: streamId,
      ...values,
    });
    if (new TextEncoder().encode(frame).byteLength > MAX_CONTROL_FRAME_BYTES) {
      throw new HostControlError("frame_too_large", "Host stream frame exceeds the limit");
    }
    channel.send(frame);
  }

  private cancelStream(streamId: string): void {
    try {
      this.sendStreamFrame("stream.cancel", streamId);
    } catch {
      // Best effort: local cancellation and cleanup must still settle even if
      // the DataChannel was lost at the same moment.
    }
  }

  private pruneIncomingTombstones(): void {
    const now = Date.now();
    for (const [streamId, tombstone] of this.cancelledIncomingStreams) {
      if (tombstone.expiresAt <= now) this.cancelledIncomingStreams.delete(streamId);
    }
  }

  private rememberIncomingCancellation(streamId: string, incoming: IncomingStream): boolean {
    this.pruneIncomingTombstones();
    if (
      !this.cancelledIncomingStreams.has(streamId) &&
      this.cancelledIncomingStreams.size >= MAX_STREAM_TOMBSTONES
    ) {
      return false;
    }
    this.cancelledIncomingStreams.set(streamId, {
      nextSequence: incoming.nextSequence,
      maxSequenceExclusive: incoming.acknowledged + STREAM_WINDOW_CHUNKS,
      received: incoming.received,
      expectedLength: incoming.expectedLength,
      expectedSha256: incoming.expectedSha256,
      hash: incoming.hash,
      expiresAt: Date.now() + STREAM_TOMBSTONE_TTL_MS,
    });
    return true;
  }

  private acceptCancelledIncomingChunk(
    streamId: string,
    sequence: unknown,
    encoded: unknown,
  ): boolean | null {
    this.pruneIncomingTombstones();
    const tombstone = this.cancelledIncomingStreams.get(streamId);
    if (!tombstone) return null;
    if (
      sequence !== tombstone.nextSequence ||
      tombstone.nextSequence >= tombstone.maxSequenceExclusive ||
      typeof encoded !== "string"
    ) {
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(encoded);
    } catch {
      return false;
    }
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > STREAM_CHUNK_BYTES ||
      tombstone.received + bytes.byteLength > tombstone.expectedLength
    ) {
      return false;
    }
    tombstone.nextSequence += 1;
    tombstone.received += bytes.byteLength;
    tombstone.hash.update(bytes);
    return true;
  }

  private acceptCancelledIncomingEnd(
    streamId: string,
    length: unknown,
    sha256: unknown,
  ): boolean | null {
    this.pruneIncomingTombstones();
    const tombstone = this.cancelledIncomingStreams.get(streamId);
    if (!tombstone) return null;
    this.cancelledIncomingStreams.delete(streamId);
    return (
      length === tombstone.expectedLength &&
      tombstone.received === tombstone.expectedLength &&
      sha256 === tombstone.expectedSha256 &&
      tombstone.hash.digestHex() === tombstone.expectedSha256
    );
  }

  private resetIncomingTimeout(streamId: string, incoming: IncomingStream): void {
    clearTimeout(incoming.timer);
    incoming.timer = setTimeout(() => {
      if (this.incomingStreams.get(streamId) !== incoming) return;
      if (!this.rememberIncomingCancellation(streamId, incoming)) {
        this.failRtc();
        return;
      }
      this.incomingStreams.delete(streamId);
      this.cancelStream(streamId);
      incoming.controller.error(new HostControlError("stream_timeout", "File read timed out"));
    }, this.streamTimeoutMs());
  }

  private resetOutgoingTimeout(streamId: string, outgoing: OutgoingStream): void {
    clearTimeout(outgoing.timer);
    outgoing.timer = setTimeout(() => {
      if (this.outgoingStreams.get(streamId) !== outgoing) return;
      this.outgoingStreams.delete(streamId);
      this.cancelOutgoing(streamId, outgoing);
      outgoing.reject(
        this.writeAcknowledgementLost(
          outgoing,
          new HostControlError("stream_timeout", "File write timed out"),
        ),
      );
    }, this.streamTimeoutMs());
  }

  private async waitForWritable(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const channel = this.channel;
      if (channel?.readyState !== "open") {
        throw new HostControlError("connection_closed", "Host control channel is not open");
      }
      if (channel.bufferedAmount <= STREAM_BUFFERED_HIGH_WATER) return;
      if (signal?.aborted) throw new DOMException("Host file write aborted", "AbortError");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 10);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Host file write aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  private finishPending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    return pending;
  }

  private requestAcknowledgementLost(pending: PendingRequest, fallback: Error): Error {
    if (!pending.mutation || !pending.dispatched) return fallback;
    return new HostControlError(
      "outcome_unknown",
      "The host mutation may have completed; reconcile host state before retrying",
    );
  }

  private writeAcknowledgementLost(outgoing: OutgoingStream, fallback: Error): Error {
    if (!outgoing.commitDispatched) return fallback;
    return new HostControlError(
      "outcome_unknown",
      "The host write may have committed; reconcile host state before retrying",
    );
  }

  private cancelOutgoing(streamId: string, outgoing: OutgoingStream): void {
    if (outgoing.cancelSent) return;
    outgoing.cancelSent = true;
    this.cancelStream(streamId);
  }

  private rejectPending(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.finishPending(requestId);
      if (pending) pending.reject(this.requestAcknowledgementLost(pending, error));
    }
  }

  private cleanupRtc(notifyServer: boolean): void {
    const sessionId = this.sessionId;
    const bindingNonce = this.bindingNonce;
    const bindingGeneration = this.bindingGeneration;
    this.sessionId = null;
    this.bindingNonce = null;
    this.bindingGeneration = null;
    this.clearRtcRecoveryTimers();
    this.signedRtcSession?.abort();
    this.signedRtcSession = null;
    this.signedRtcRequired = false;
    this.capabilities = new Set();
    if (notifyServer && sessionId) {
      this.sendSignal({
        type: "rtc.close",
        session_id: sessionId,
        ...(bindingNonce ? { binding_nonce: bindingNonce } : {}),
        ...(bindingGeneration !== null ? { binding_generation: bindingGeneration } : {}),
      });
    }
    const channel = this.channel;
    const pc = this.pc;
    this.channel = null;
    this.pc = null;
    this.pendingRemoteCandidates = [];
    this.localCandidateGate = null;
    if (channel) {
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    this.rejectPending(new Error("Host control session ended"));
    const streamError = new HostControlError("connection_closed", "Host control session ended");
    for (const [streamId, incoming] of this.incomingStreams) {
      this.incomingStreams.delete(streamId);
      clearTimeout(incoming.timer);
      incoming.controller.error(streamError);
    }
    this.cancelledIncomingStreams.clear();
    for (const [streamId, outgoing] of this.outgoingStreams) {
      this.outgoingStreams.delete(streamId);
      clearTimeout(outgoing.timer);
      outgoing.reject(this.writeAcknowledgementLost(outgoing, streamError));
    }
    if (!this.stopped && this.state === "ready") this.setState("open");
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.signedRtcRefusal !== null ||
      this.terminalReason !== null ||
      this.reconnectTimer
    )
      return;
    this.clearConnectDeadline();
    const attempt = this.connectionAttempt;
    const delay = backoffDelay(
      this.reconnectAttempt,
      {
        base: Math.max(1, this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS),
        cap: 30_000,
      },
      this.options.reconnectRandom,
    );
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 30);
    const timer = setTimeout(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = null;
      if (this.stopped || this.connectionAttempt !== attempt) return;
      const ws = this.ws;
      this.ws = null;
      if (ws) {
        this.detachWebSocket(ws);
        ws.close();
      }
      if (!this.hasHealthyRtc()) this.cleanupRtc(false);
      this.openWebSocket();
    }, delay);
    this.reconnectTimer = timer;
  }

  private failRtc(expectedSessionId?: string): void {
    if (expectedSessionId !== undefined && this.sessionId !== expectedSessionId) return;
    if (this.sessionId === null && this.reconnectTimer) return;
    this.cleanupRtc(true);
    this.scheduleReconnect();
  }

  private clearConnectDeadline(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearSignalWatchdog(): void {
    if (this.signalWatchdogTimer) clearTimeout(this.signalWatchdogTimer);
    this.signalWatchdogTimer = null;
  }

  private clearRtcDisconnectedTimer(): void {
    if (this.rtcDisconnectedTimer) clearTimeout(this.rtcDisconnectedTimer);
    this.rtcDisconnectedTimer = null;
  }

  private clearRtcResumeTimer(): void {
    if (this.rtcResumeTimer) clearTimeout(this.rtcResumeTimer);
    this.rtcResumeTimer = null;
    this.resumeInFlight = false;
  }

  private clearRtcRecoveryTimers(): void {
    this.clearRtcDisconnectedTimer();
    this.clearRtcResumeTimer();
  }

  private finishRtcConfigRefresh(): void {
    if (this.rtcConfigRefreshTimer) clearTimeout(this.rtcConfigRefreshTimer);
    this.rtcConfigRefreshTimer = null;
    const resolve = this.rtcConfigRefreshResolve;
    this.rtcConfigRefreshResolve = null;
    resolve?.();
  }

  private redialNow(): void {
    const ws = this.ws;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    if (ws) {
      this.ws = null;
      this.detachWebSocket(ws);
      try {
        ws.close();
      } catch {
        // A replacement socket is opened below either way.
      }
    }
    this.openWebSocket();
  }

  private wake(): void {
    if (this.stopped || this.terminalReason !== null || this.signedRtcRefusal !== null) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.redialNow();
      return;
    }
    if (this.pc?.connectionState === "connected") return;
    const silenceSuspectMs = this.options.silenceSuspectMs ?? SIGNAL_SILENCE_SUSPECT_MS;
    if (Date.now() - this.lastSignalFrameAt > silenceSuspectMs) {
      // OPEN is the socket's claim, not the network's: a sleep leaves
      // half-open sockets that never fire onclose, and the server pings
      // every 25 s, so a live one is never this quiet. Redial — the fresh
      // socket also carries fresh TURN credentials in on its rtc.config.
      this.redialNow();
      return;
    }
    if (this.pc) {
      void this.restartIce("wake");
    } else if (this.latestIceServers) {
      void this.startRtcWithLatest();
    }
  }

  private installGlobalListeners(): void {
    if (this.globalListenersInstalled || typeof window === "undefined") return;
    this.globalListenersInstalled = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("online", this.onWake);
    window.addEventListener("pageshow", this.onWake);
    // The desktop shell's webview sleeps and wakes with the machine without
    // firing any of the three events above; the clock jump always arrives.
    this.stopSuspendWatch = watchSuspendResume(this.onWake);
  }

  private uninstallGlobalListeners(): void {
    if (!this.globalListenersInstalled || typeof window === "undefined") return;
    this.globalListenersInstalled = false;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("online", this.onWake);
    window.removeEventListener("pageshow", this.onWake);
    this.stopSuspendWatch?.();
    this.stopSuspendWatch = null;
  }

  private isCurrentWebSocket(ws: WebSocket, attempt: number): boolean {
    return !this.stopped && this.ws === ws && this.connectionAttempt === attempt;
  }

  private detachWebSocket(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  }

  private maxPendingRequests(): number {
    const configured = this.options.maxPendingRequests;
    if (configured === undefined || !Number.isFinite(configured)) return MAX_PENDING_REQUESTS;
    return Math.max(0, Math.min(MAX_PENDING_REQUESTS, Math.floor(configured)));
  }

  private streamTimeoutMs(): number {
    const configured = this.options.streamTimeoutMs;
    if (configured === undefined || !Number.isFinite(configured)) return STREAM_TIMEOUT_MS;
    return Math.max(1, Math.min(STREAM_TIMEOUT_MS, Math.floor(configured)));
  }

  private setState(state: HostControlState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    binary += String.fromCharCode(bytes[offset]);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 1) {
    bytes[offset] = binary.charCodeAt(offset);
  }
  return bytes;
}
