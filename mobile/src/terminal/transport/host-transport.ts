import { openHostSignal } from "@/data/realtime/host-signal";
import { loadMemoizedCarriedEndorsements } from "@/data/trust/carried-endorsements";
import {
  DEVICE_NOT_TRUSTED_CODE,
  DEVICE_NOT_TRUSTED_MESSAGE,
  type DeviceHostTrustResult,
  invalidateDeviceHostTrust,
  probeDeviceHostTrustResult,
} from "@/data/trust/device-trust";
import { subscribeHostPinChanges } from "@/data/trust/host-pins";
import { randomBytes } from "@/lib/crypto/bootstrap";
import { bytesToUuid, encodeHex } from "@/lib/crypto/bytes";
import {
  type NativeToWorkerMessage,
  parseWorkerMessage,
  TERMINAL_BRIDGE_VERSION,
  type WorkerToNativeMessage,
} from "@/terminal/transport/bridge";
import { verifyDaemonHost } from "@/terminal/transport/daemon-trust";
import {
  assertHostFileSize,
  collectHostStream,
  HOST_CONTROL_PROTOCOL,
  HOST_FILE_MAX_BYTES,
  HOST_RANGE_MAX_BYTES,
  HOST_STREAM_CHUNK_BYTES,
  HOST_STREAM_TIMEOUT_MS,
  HostControlTransportError,
  type HostReadDeclarationWire,
  HostStreamRuntime,
  hashHostFileSource,
  parseHostHello,
  parseHostReadDeclaration,
  parseHostWriteStreamId,
} from "@/terminal/transport/host-ctl-codec";
import {
  browserIdentityWire,
  signWorkerRequest,
  verifyAnswerFrame,
} from "@/terminal/transport/signed-signalling";
import { reconnectDelay } from "@/terminal/transport/state-machine";
import type {
  HostCapabilities,
  HostFileSource,
  HostPreviewFile,
  HostRangeFile,
  HostReadableFile,
  HostReadHead,
  HostRequestOptions,
  HostTransport,
  HostTransportOptions,
  HostWriteDeclaration,
  HostWriteOptions,
  HostWriteResult,
  SignalChannelLike,
  StreamingHostTransport,
  TransportError,
  TransportState,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import {
  CONNECT_TIMEOUT_MESSAGE,
  CONNECT_TIMEOUT_MS,
  iceServersNeedRefresh,
  LOST_CONNECTION_MESSAGE,
  readTransportPolicy,
  sanitizeIceServers,
} from "@/terminal/transport/types";
import { terminalDark, terminalMetrics } from "@/theme";

const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 15_000;
const PREVIEW_REQUEST_TIMEOUT_MS = 35_000;
const HOST_HELLO_BRIDGE_ID = "$host.hello";
const HOST_STREAM_BRIDGE_PREFIX = "$host.stream:";
const STREAM_COMMAND_PREFIX = "$host.stream.";
const RECONNECT_BUDGET_MS = 3 * 60_000;
const INDETERMINATE_OPERATIONS = new Set([
  "fs.mkdir",
  "fs.rename",
  "fs.remove",
  "desktop.reveal",
  "desktop.open",
]);

interface FrameRecord extends Record<string, unknown> {
  type?: unknown;
  enabled?: unknown;
  ice_servers?: unknown;
  ice_transport_policy?: unknown;
  scope_type?: unknown;
  scope_id?: unknown;
  protocol?: unknown;
  protocol_version?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  dispatched: boolean;
  indeterminate: boolean;
  removeAbort?: () => void;
}

interface PendingCommand {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface CachedRtcConfig {
  iceServers: Array<Record<string, unknown>>;
  iceTransportPolicy: "all" | "relay";
}

function record(value: unknown): FrameRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as FrameRecord)
    : null;
}

function newUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function exposedDeclaration(declaration: HostReadDeclarationWire) {
  return {
    streamId: declaration.streamId,
    path: declaration.path,
    name: declaration.name,
    length: declaration.length,
    sha256: declaration.sha256,
  };
}

class WebViewHostTransport implements StreamingHostTransport {
  readonly hostId: string;
  readonly #streamTimeout: number;
  readonly #streams: HostStreamRuntime;
  #state: TransportState = "idle";
  #lastError: TransportError | null = null;
  #capabilities: HostCapabilities | null = null;
  #browserKey: string | null = null;
  #signal: SignalChannelLike | null = null;
  #signalUnsubscribe: (() => void) | null = null;
  #signalStateUnsubscribe: (() => void) | null = null;
  #bridgeUnsubscribe: (() => void) | null = null;
  #opening: Promise<void> | null = null;
  #prepared = false;
  #prepareEpoch = 0;
  #pinUnsubscribe: (() => void) | null = null;
  #preparePromise: Promise<void> | null = null;
  #workerStarted = false;
  #cachedConfig: CachedRtcConfig | null = null;
  #activeRtcSessionId: string | null = null;
  #activeBindingNonce: string | null = null;
  #activeBindingGeneration: number | null = null;
  #signalHasOpened = false;
  #configWaiters = new Set<() => void>();
  #endorsements: Promise<
    readonly import("@/data/trust/carried-endorsements").CarriedEndorsement[]
  > = Promise.resolve([]);
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #connectDeadline: number | null = null;
  #hasEverReady = false;
  /** True once this host has refused an offer from this device. */
  #refused = false;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #resolveOpen: (() => void) | null = null;
  #rejectOpen: ((error: Error) => void) | null = null;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #commands = new Map<string, PendingCommand>();
  readonly #stateListeners = new Set<(state: TransportState) => void>();
  readonly #errorListeners = new Set<(error: TransportError) => void>();
  readonly #diagnosticListeners = new Set<(diagnostic: WorkerDiagnostic) => void>();
  #consumerId: string | null = null;
  #parentUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly options: HostTransportOptions,
    private readonly parent?: HostTransport,
  ) {
    this.hostId = options.hostId;
    this.#streamTimeout =
      options.streamTimeoutMs === undefined || !Number.isFinite(options.streamTimeoutMs)
        ? HOST_STREAM_TIMEOUT_MS
        : Math.max(1, Math.min(HOST_STREAM_TIMEOUT_MS, Math.floor(options.streamTimeoutMs)));
    this.#streams = new HostStreamRuntime({
      send: (type, payload) => this.#sendStreamCommand(type, payload),
      fatal: (error) => this.#fail("host_stream_protocol", error.message),
      timeoutMs: this.#streamTimeout,
    });
  }

  get state(): TransportState {
    return this.#state;
  }

  get lastError(): TransportError | null {
    return this.#lastError;
  }

  get capabilities(): HostCapabilities | null {
    return this.#capabilities;
  }

  prepare(): void {
    if (this.parent) return;
    if (this.#prepared) return;
    this.#prepared = true;
    this.#lastError = null;
    const epoch = ++this.#prepareEpoch;
    this.#pinUnsubscribe ??= subscribeHostPinChanges(() => {
      this.close();
      void this.open().catch(() => {});
    });
    this.#setState("signalling");
    this.#loadEndorsements(this.#preflightTrust());
    this.#startSignal();
    this.#preparePromise = browserIdentityWire().then(async (browserKey) => {
      await verifyDaemonHost(this.hostId, this.options.hostIdentityPublicKey);
      if (epoch === this.#prepareEpoch) this.#browserKey = browserKey;
    });
    // prepare can start before the WebView loads; open observes the rejection.
    void this.#preparePromise.catch(() => {});
  }

  networkChanged(): void {
    if (this.parent) return;
    if (!this.#workerStarted || this.#state === "closed" || this.#state === "failed") return;
    this.#refreshConfigBefore(() => {
      if (!this.#workerStarted || this.#state === "closed" || this.#state === "failed") return;
      this.#send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "network-changed",
        ...(this.#cachedConfig
          ? {
              iceServers: this.#cachedConfig.iceServers,
              iceTransportPolicy: this.#cachedConfig.iceTransportPolicy,
            }
          : {}),
      });
    });
  }

  hasCapability(operation: string): boolean {
    return this.#capabilities?.operations.includes(operation) === true;
  }

  async open(): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#state === "failed") throw new Error("Host transport is in a failed state.");
    if (this.#opening) return this.#opening;
    this.#capabilities = null;
    this.#opening = new Promise<void>((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
    });
    if (this.parent) {
      const opening = this.#opening;
      this.#prepared = true;
      this.#bridgeUnsubscribe?.();
      this.#parentUnsubscribe?.();
      this.#bridgeUnsubscribe = this.options.bridge.onMessage((message) => {
        if (message.type !== "host-consumer-event" || message.consumerId !== this.#consumerId)
          return;
        try {
          const event = parseWorkerMessage(
            JSON.stringify({
              ...(record(message.message) ?? {}),
              v: TERMINAL_BRIDGE_VERSION,
            }),
          );
          if (["state", "host-response", "error"].includes(event.type)) {
            void this.#handleWorkerMessage(event)
              .then(() => {
                if (
                  message.consumerId === this.#consumerId &&
                  typeof message.sequence === "number"
                ) {
                  this.options.bridge.send({
                    v: TERMINAL_BRIDGE_VERSION,
                    type: "host-consumer-received",
                    consumerId: message.consumerId,
                    sequence: message.sequence,
                  });
                }
              })
              .catch(() => {
                if (message.consumerId === this.#consumerId)
                  this.#fail("host_consumer_protocol", "Host tool event could not be delivered.");
              });
          }
        } catch {
          this.#fail("host_consumer_protocol", "Host tool channel sent an invalid event.");
        }
      });
      this.#parentUnsubscribe = this.parent.on("state", () => this.#syncConsumer());
      this.#syncConsumer();
      return opening;
    }
    this.prepare();
    const opening = this.#opening;
    try {
      await this.#preparePromise;
      if (this.#opening !== opening || ["closed", "failed"].includes(this.#state)) {
        return opening;
      }
      this.#bridgeUnsubscribe?.();
      this.#bridgeUnsubscribe = this.options.bridge.onMessage((message) => {
        void this.#handleWorkerMessage(message);
      });
      this.#send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "init",
        mode: "host",
        scopeId: this.hostId,
        browserIdentityPublicKey: this.#browserKey ?? "",
        hostIdentityPublicKey: this.options.hostIdentityPublicKey,
        cols: 80,
        rows: 24,
        theme: terminalDark,
        fontSize: terminalMetrics.fontSize,
        skipLoopbackProbe: true,
      });
      this.#workerStarted = true;
      this.#armConnectWatchdog();
      if (this.#cachedConfig && this.#state === "signalling") this.#startPeer(this.#cachedConfig);
    } catch (error) {
      if (this.#opening !== opening) return opening;
      this.#fail(
        error instanceof HostControlTransportError ? error.code : "host_open",
        error instanceof Error ? error.message : "Host transport failed to open.",
      );
    }
    return this.#opening;
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#pinUnsubscribe?.();
    this.#pinUnsubscribe = null;
    this.#prepared = false;
    this.#retireWorker();
    this.#setState("closed");
    const error = new HostControlTransportError("connection_closed", "Host transport closed.");
    this.#rejectOpen?.(error);
    this.#settleOpening();
    this.#rejectActive(error);
  }

  /** Retire the native generation before publishing either close or failure. */
  #retireWorker(): void {
    this.#parentUnsubscribe?.();
    this.#parentUnsubscribe = null;
    this.#clearConnectWatchdog();
    this.#clearReconnectTimer();
    this.#connectDeadline = null;
    clearTimeout(this.#resumeTimer ?? undefined);
    this.#resumeTimer = null;
    this.#workerStarted = false;
    this.#prepareEpoch++;
    this.#bridgeUnsubscribe?.();
    this.#bridgeUnsubscribe = null;
    for (const finish of this.#configWaiters) finish();
    this.#configWaiters.clear();
    try {
      this.#send({ v: TERMINAL_BRIDGE_VERSION, type: "close" });
    } catch {
      // A terminated WebContent process has nothing left to close.
    }
    this.#retireSignal();
    this.#browserKey = null;
    this.#preparePromise = null;
    this.#capabilities = null;
  }

  request<T>(operation: string, payload?: unknown, options: HostRequestOptions = {}): Promise<T> {
    if (this.#state !== "ready") {
      return Promise.reject(
        new HostControlTransportError("not_ready", "Host transport is not ready."),
      );
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new HostControlTransportError("too_many_requests", "Too many host-control requests."),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new HostControlTransportError("cancelled", "Host-control request was cancelled."),
      );
    }
    const requestId = newUuid();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const pending = this.#finishPending(requestId);
          if (!pending) return;
          this.cancel(requestId);
          pending.reject(
            this.#requestFailure(
              pending,
              new HostControlTransportError("request_timeout", "Host-control request timed out."),
            ),
          );
        },
        Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      );
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        dispatched: false,
        indeterminate: INDETERMINATE_OPERATIONS.has(operation),
      };
      if (options.signal) {
        const onAbort = () => {
          const current = this.#finishPending(requestId);
          if (!current) return;
          this.cancel(requestId);
          current.reject(
            this.#requestFailure(
              current,
              new HostControlTransportError("cancelled", "Host-control request was cancelled."),
            ),
          );
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.#pending.set(requestId, pending);
      try {
        this.#send({
          v: TERMINAL_BRIDGE_VERSION,
          type: "host-request",
          requestId,
          operation,
          ...(payload === undefined ? {} : { payload }),
        });
        pending.dispatched = true;
      } catch (error) {
        this.#finishPending(requestId);
        reject(error instanceof Error ? error : new Error("Host-control send failed."));
      }
    });
  }

  cancel(requestId: string): void {
    try {
      this.#send({ v: TERMINAL_BRIDGE_VERSION, type: "host-cancel", requestId });
    } catch {
      // Cancellation remains best-effort if WebContent retired at the same instant.
    }
  }

  async readFile(path: string, options?: HostRequestOptions): Promise<HostReadableFile> {
    const declaration = await this.#beginIncoming("fs.read", { path }, options);
    return {
      ...exposedDeclaration(declaration),
      stream: this.#streams.beginIncoming(declaration, options),
    };
  }

  async readRange(
    path: string,
    offset: number,
    length: number,
    options?: HostRequestOptions,
  ): Promise<HostRangeFile> {
    this.#requireCapability("fs.read.range");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HostControlTransportError("invalid_request", "Range offset is invalid.");
    }
    const rangeLimit = Math.min(
      this.#capabilities?.limits.rangeBytes ?? HOST_RANGE_MAX_BYTES,
      HOST_RANGE_MAX_BYTES,
    );
    if (!Number.isSafeInteger(length) || length <= 0 || length > rangeLimit) {
      throw new HostControlTransportError("invalid_request", "Range length is invalid.");
    }
    const declaration = await this.#beginIncoming(
      "fs.read.range",
      { path, offset, length },
      options,
      rangeLimit,
    );
    const stream = this.#streams.beginIncoming(declaration, options);
    const raw = declaration.raw;
    if (declaration.length > length || !Number.isSafeInteger(raw["file_size"])) {
      await stream.cancel("Invalid range declaration.");
      throw new HostControlTransportError("invalid_response", "Host returned an invalid range.");
    }
    return {
      ...exposedDeclaration(declaration),
      offset: typeof raw["offset"] === "number" ? raw["offset"] : offset,
      fileSize: raw["file_size"] as number,
      version: typeof raw["version"] === "string" ? raw["version"] : null,
      contentType: typeof raw["content_type"] === "string" ? raw["content_type"] : null,
      openAllowed: raw["open_allowed"] === true,
      eof: raw["eof"] === true,
      stream,
    };
  }

  async readHead(
    path: string,
    limit: number,
    options: HostRequestOptions & { size?: number | null } = {},
  ): Promise<HostReadHead> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > HOST_RANGE_MAX_BYTES) {
      throw new HostControlTransportError("invalid_request", "Read-head limit is invalid.");
    }
    const { size, ...requestOptions } = options;
    if (typeof size === "number" && size <= limit) {
      const read = await this.readFile(path, requestOptions);
      return {
        bytes: await collectHostStream(read.stream),
        total: read.length,
        truncated: false,
      };
    }
    const read = await this.readRange(path, 0, limit, requestOptions);
    return {
      bytes: await collectHostStream(read.stream),
      total: read.fileSize,
      truncated: !read.eof,
    };
  }

  async previewImage(
    path: string,
    maxPixels: 128 | 256 | 512 | 1024,
    options: HostRequestOptions = {},
  ): Promise<HostPreviewFile> {
    this.#requireCapability("fs.preview");
    if (!this.#capabilities?.limits.previewPixels.includes(maxPixels)) {
      throw new HostControlTransportError("invalid_request", "Unsupported preview size.");
    }
    const requestOptions = {
      ...options,
      timeoutMs: options.timeoutMs ?? PREVIEW_REQUEST_TIMEOUT_MS,
    };
    const declaration = await this.#beginIncoming(
      "fs.preview",
      { path, max_pixels: maxPixels },
      requestOptions,
      this.#capabilities.limits.previewBytes,
    );
    const raw = declaration.raw;
    return {
      ...exposedDeclaration(declaration),
      mime: typeof raw["content_type"] === "string" ? raw["content_type"] : "image/png",
      width: Number.isSafeInteger(raw["width"]) ? (raw["width"] as number) : 0,
      height: Number.isSafeInteger(raw["height"]) ? (raw["height"] as number) : 0,
      version: typeof raw["version"] === "string" ? raw["version"] : null,
      stream: this.#streams.beginIncoming(declaration, requestOptions),
    };
  }

  async writeStream(
    stream: ReadableStream<Uint8Array>,
    declaration: HostWriteDeclaration,
    options: HostWriteOptions = {},
  ): Promise<HostWriteResult> {
    this.#requireCapability("fs.write.begin");
    assertHostFileSize(declaration.length, this.#capabilities?.limits.fileBytes);
    if (!/^[0-9a-f]{64}$/.test(declaration.sha256)) {
      throw new HostControlTransportError("invalid_digest", "Host write digest is invalid.");
    }
    options.onProgress?.({ phase: "declaring", transferred: 0, total: declaration.length });
    const begin = await this.request<unknown>("fs.write.begin", declaration, {
      timeoutMs: this.#streamTimeout,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.#streams.write(parseHostWriteStreamId(begin), stream, declaration, options);
  }

  async writeFile(
    source: HostFileSource,
    destination: Omit<HostWriteDeclaration, "length" | "sha256">,
    options: HostWriteOptions = {},
  ): Promise<HostWriteResult> {
    this.#requireCapability("fs.write.begin");
    assertHostFileSize(source.size, this.#capabilities?.limits.fileBytes ?? HOST_FILE_MAX_BYTES);
    options.onProgress?.({ phase: "hashing", transferred: 0, total: source.size });
    const digest = await hashHostFileSource(source, options.signal, (read) =>
      options.onProgress?.({ phase: "hashing", transferred: read, total: source.size }),
    );
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (options.signal?.aborted) {
          controller.error(
            new HostControlTransportError("cancelled", "Host file transfer was cancelled."),
          );
          return;
        }
        if (offset >= source.size) {
          controller.close();
          return;
        }
        const expected = Math.min(HOST_STREAM_CHUNK_BYTES, source.size - offset);
        const chunk = await source.read(offset, expected);
        if (chunk.byteLength !== expected) {
          controller.error(
            new HostControlTransportError(
              "local_file_changed",
              "The selected file changed while it was being read.",
            ),
          );
          return;
        }
        offset += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return this.writeStream(
      stream,
      { ...destination, length: source.size, sha256: digest },
      options,
    );
  }

  async transferFileTo(
    destination: HostTransport,
    path: string,
    destinationDirectory: string,
    options: HostWriteOptions & { overwrite?: boolean } = {},
  ): Promise<HostWriteResult> {
    if (!destination.writeStream) {
      throw new HostControlTransportError(
        "streaming_unsupported",
        "Destination host transport cannot receive file streams.",
      );
    }
    const read = await this.readFile(path, options);
    try {
      return await destination.writeStream(
        read.stream,
        {
          dir: destinationDirectory,
          name: read.name,
          length: read.length,
          sha256: read.sha256,
          overwrite: options.overwrite ?? false,
        },
        options,
      );
    } catch (error) {
      await read.stream.cancel(error).catch(() => undefined);
      throw error;
    }
  }

  on(ev: "state", fn: (state: TransportState) => void): () => void;
  on(ev: "error", fn: (error: TransportError) => void): () => void;
  on(ev: "diagnostic", fn: (diagnostic: WorkerDiagnostic) => void): () => void;
  on(
    ev: "state" | "error" | "diagnostic",
    fn:
      | ((state: TransportState) => void)
      | ((error: TransportError) => void)
      | ((diagnostic: WorkerDiagnostic) => void),
  ): () => void {
    if (ev === "state") {
      const listener = fn as (state: TransportState) => void;
      this.#stateListeners.add(listener);
      return () => this.#stateListeners.delete(listener);
    }
    if (ev === "error") {
      const listener = fn as (error: TransportError) => void;
      this.#errorListeners.add(listener);
      return () => this.#errorListeners.delete(listener);
    }
    const listener = fn as (diagnostic: WorkerDiagnostic) => void;
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  async #beginIncoming(
    operation: "fs.read" | "fs.read.range" | "fs.preview",
    payload: Record<string, unknown>,
    options: HostRequestOptions = {},
    declarationLimit?: number,
  ): Promise<HostReadDeclarationWire> {
    this.#requireCapability(operation);
    const response = await this.request<unknown>(operation, payload, {
      ...options,
      timeoutMs: options.timeoutMs ?? this.#streamTimeout,
    });
    return parseHostReadDeclaration(
      response,
      declarationLimit ?? this.#capabilities?.limits.fileBytes,
    );
  }

  #requireCapability(operation: string): void {
    if (!this.#capabilities) {
      throw new HostControlTransportError(
        "capabilities_unavailable",
        "The host has not advertised its capabilities.",
      );
    }
    if (!this.hasCapability(operation)) {
      throw new HostControlTransportError(
        "unsupported_operation",
        `The connected host does not support ${operation}.`,
      );
    }
  }

  #sendStreamCommand(
    type: "ack" | "cancel" | "chunk" | "end",
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.#state !== "ready") {
      return Promise.reject(
        new HostControlTransportError("connection_closed", "Host-control channel is not ready."),
      );
    }
    const requestId = newUuid();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#commands.delete(requestId);
        reject(new HostControlTransportError("stream_timeout", "Host stream stalled."));
      }, this.#streamTimeout);
      this.#commands.set(requestId, { resolve, reject, timer });
      try {
        this.#send({
          v: TERMINAL_BRIDGE_VERSION,
          type: "host-request",
          requestId,
          operation: `${STREAM_COMMAND_PREFIX}${type}`,
          payload,
        });
      } catch (error) {
        clearTimeout(timer);
        this.#commands.delete(requestId);
        reject(error instanceof Error ? error : new Error("Host stream send failed."));
      }
    });
  }

  #startSignal(): void {
    this.#retireSignal();
    const openSignal = this.options.openSignal ?? openHostSignal;
    this.#signal = openSignal(this.hostId);
    this.#signalUnsubscribe = this.#signal.onFrame((frame) => this.#handleSignalFrame(frame));
    this.#signalStateUnsubscribe =
      this.#signal.onState?.((state) => this.#handleSignalState(state)) ?? null;
    if (this.#signal.state === "open") this.#signalHasOpened = true;
  }

  #send(message: NativeToWorkerMessage): void {
    if (!this.parent) {
      this.options.bridge.send(message);
      return;
    }
    if (message.type === "close") {
      this.#detachConsumer();
      return;
    }
    if (!this.#consumerId || !["host-request", "host-cancel"].includes(message.type))
      throw new HostControlTransportError("not_ready", "Host tool channel is not ready.");
    if (message.type === "host-request" || message.type === "host-cancel")
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "host-consumer-command",
        consumerId: this.#consumerId,
        command: message,
      });
  }

  #detachConsumer(): void {
    const consumerId = this.#consumerId;
    this.#consumerId = null;
    if (consumerId) {
      try {
        this.options.bridge.send({
          v: TERMINAL_BRIDGE_VERSION,
          type: "host-consumer-close",
          consumerId,
        });
      } catch {
        /* A retired WebView has no remaining channels. */
      }
    }
  }

  #syncConsumer(): void {
    if (!this.parent || !this.#prepared) return;
    if (this.parent.state !== "ready") {
      this.#clearReconnectTimer();
      this.#detachConsumer();
      this.#clearConnectWatchdog();
      this.#connectDeadline = null;
      this.#capabilities = null;
      const parentError = this.parent.state === "failed" ? this.parent.lastError : null;
      const error = new HostControlTransportError(
        parentError?.code ?? "connection_lost",
        parentError?.message ?? "Host connection is paused.",
      );
      this.#rejectActive(error);
      this.#setState(this.parent.state === "failed" ? "failed" : "connecting");
      if (this.parent.state === "failed") {
        if (parentError) this.#emitError(parentError);
        this.#rejectOpen?.(error);
        this.#settleOpening();
      }
      return;
    }
    if (this.#consumerId) return;
    this.#clearReconnectTimer();
    this.#consumerId = newUuid();
    this.#capabilities = null;
    this.#setState("connecting");
    this.#armConnectWatchdog();
    try {
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "host-consumer-open",
        consumerId: this.#consumerId,
      });
    } catch (error) {
      this.#fail(
        "host_consumer_open",
        error instanceof Error ? error.message : "Host tool channel could not open.",
      );
    }
  }

  #retireSignal(): void {
    this.#signalUnsubscribe?.();
    this.#signalUnsubscribe = null;
    this.#signalStateUnsubscribe?.();
    this.#signalStateUnsubscribe = null;
    this.#signal?.close();
    this.#signal = null;
  }

  #handleSignalFrame(value: unknown): void {
    const frame = record(value);
    if (!frame) return;
    if (frame.type === "rtc.config") {
      if (frame.protocol_version !== 2) {
        this.#fail(
          "server_update_required",
          "Update the SPAWN D server to share daemon connections.",
        );
        return;
      }
      // /ws/host binds every frame to the host tuple instead of advertising
      // `binding_nonce_required`; that flag only exists on the session channel.
      if (
        frame.enabled !== true ||
        !Array.isArray(frame.ice_servers) ||
        frame.scope_type !== "host" ||
        frame.scope_id !== this.hostId ||
        frame.protocol !== HOST_CONTROL_PROTOCOL ||
        frame.protocol_version !== 2
      ) {
        this.#fail("rtc_config", "Host RTC configuration is disabled or weakly bound.");
        return;
      }
      const iceServers = sanitizeIceServers(frame.ice_servers);
      if (frame.ice_servers.length > 0 && iceServers.length === 0) {
        this.#fail("rtc_config", "Host RTC configuration did not contain a safe ICE server.");
        return;
      }
      this.#cachedConfig = {
        iceServers,
        iceTransportPolicy: readTransportPolicy(frame.ice_transport_policy),
      };
      for (const waiter of this.#configWaiters) waiter();
      this.#configWaiters.clear();
      if (this.#workerStarted && this.#state === "signalling") this.#startPeer(this.#cachedConfig);
      return;
    }
    if (frame.type === "rtc.status") {
      const matchesActiveBinding = frame["session_id"] === this.#activeRtcSessionId;
      if (matchesActiveBinding && frame["code"] === "daemon_update_required") {
        this.#fail(
          "daemon_update_required",
          "Update SPAWN D on this host to share its connection.",
        );
        return;
      }
      if (matchesActiveBinding && Number.isSafeInteger(frame["binding_generation"])) {
        this.#activeBindingGeneration = frame["binding_generation"] as number;
      }
      if (
        matchesActiveBinding &&
        frame["status"] === "unavailable" &&
        this.#resumeTimer !== null &&
        this.#cachedConfig &&
        this.#workerStarted
      ) {
        // Only a refused resume earns an immediate fresh binding. An unavailable
        // offer reaches worker teardown below, then the bounded reconnect delay.
        clearTimeout(this.#resumeTimer ?? undefined);
        this.#resumeTimer = null;
        this.#startPeer(this.#cachedConfig, true);
        return;
      }
      if (
        matchesActiveBinding &&
        ["resumed", "rebound", "connected", "negotiating"].includes(String(frame["status"]))
      ) {
        clearTimeout(this.#resumeTimer ?? undefined);
        this.#resumeTimer = null;
      }
      if (matchesActiveBinding && frame["status"] === "failed") this.#handleRtcRefusal();
    }
    try {
      const verified = verifyAnswerFrame(
        value,
        this.options.hostIdentityPublicKey,
        this.#browserKey ?? "",
        {
          scopeType: "host",
          scopeId: this.hostId,
          protocol: "spawn.host.ctl",
          protocolVersion: 2,
        },
      );
      this.#send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "signal-frame",
        frame: verified,
      });
    } catch (error) {
      this.#fail(
        "signal_verification",
        error instanceof Error ? error.message : "Host RTC answer verification failed.",
      );
    }
  }

  #startPeer(config: CachedRtcConfig, forceRebuild = false): void {
    if (this.#remainingConnectTime() === 0) {
      this.#fail(
        "connect_timeout",
        this.#hasEverReady ? LOST_CONNECTION_MESSAGE : CONNECT_TIMEOUT_MESSAGE,
      );
      return;
    }
    this.#setState("connecting");
    this.#armConnectWatchdog();
    this.#activeRtcSessionId = newUuid();
    this.#activeBindingNonce = encodeHex(randomBytes(16));
    this.#activeBindingGeneration = null;
    this.#send({
      v: TERMINAL_BRIDGE_VERSION,
      type: "connect",
      rtcSessionId: this.#activeRtcSessionId,
      bindingNonce: this.#activeBindingNonce,
      iceServers: config.iceServers,
      iceTransportPolicy: config.iceTransportPolicy,
      forceRelay: this.options.forceRelay ?? false,
      ...(forceRebuild ? { forceRebuild: true } : {}),
    });
  }

  #handleSignalState(state: string): void {
    if (state === "open") {
      if (
        this.#signalHasOpened &&
        this.#state === "ready" &&
        this.#activeRtcSessionId &&
        this.#activeBindingNonce &&
        this.#activeBindingGeneration
      ) {
        this.#signal?.send({
          type: "rtc.resume",
          session_id: this.#activeRtcSessionId,
          binding_nonce: this.#activeBindingNonce,
          binding_generation: this.#activeBindingGeneration,
          scope_type: "host",
          scope_id: this.hostId,
          protocol: HOST_CONTROL_PROTOCOL,
          protocol_version: 2,
        });
        clearTimeout(this.#resumeTimer ?? undefined);
        this.#resumeTimer = setTimeout(() => {
          this.#resumeTimer = null;
          if (this.#state === "ready" && this.#cachedConfig && this.#workerStarted) {
            this.#startPeer(this.#cachedConfig, true);
          }
        }, 2_000);
      }
      this.#signalHasOpened = true;
      return;
    }
    if (state !== "failed" && state !== "unauthenticated") return;
    const close = this.#signal?.closeInfo;
    const message =
      close?.code === 4003
        ? "Update SPAWN D to reconnect to this host."
        : state === "unauthenticated" || close?.code === 1008
          ? "You've been signed out."
          : close?.reason || "The host signalling connection failed.";
    this.#fail("signal_failed", message);
  }

  #refreshConfigBefore(callback: () => void): void {
    if (
      !this.#cachedConfig ||
      !iceServersNeedRefresh(this.#cachedConfig.iceServers) ||
      this.#signal?.state !== "open"
    ) {
      callback();
      return;
    }
    const epoch = this.#prepareEpoch;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.#configWaiters.delete(finish);
      if (epoch === this.#prepareEpoch) callback();
    };
    const timer = setTimeout(finish, 2_000);
    this.#configWaiters.add(finish);
    try {
      this.#signal.send({ type: "rtc.config.request" });
    } catch {
      finish();
    }
  }

  async #handleWorkerMessage(message: WorkerToNativeMessage): Promise<void> {
    if (this.#state === "closed" || this.#state === "failed") return;
    switch (message.type) {
      case "state":
        // Only an explicit native close command produces this acknowledgement.
        // close() already retired the transport synchronously. WebView delivery
        // may reach a later open() on the same bridge, so it cannot close that
        // replacement or stop its signing and signalling messages.
        if (message.state === "closed") break;
        if (message.state === "reconnecting") this.#scheduleReconnect();
        else this.#setState(message.state);
        break;
      case "signal-frame":
        try {
          this.#signal?.send(message.frame);
        } catch {
          // The reconnecting signalling socket will either resume this binding
          // or the worker's restart deadline will request a fresh one.
        }
        break;
      case "sign-request": {
        const epoch = this.#prepareEpoch;
        try {
          const [signature, carriedEndorsements] = await Promise.all([
            signWorkerRequest(message),
            this.#endorsements,
          ]);
          if (epoch !== this.#prepareEpoch || !this.#workerStarted) return;
          this.#send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "sign-response",
            requestId: message.requestId,
            signature,
            ...(carriedEndorsements.length > 0 ? { carriedEndorsements } : {}),
          });
        } catch (error) {
          if (epoch !== this.#prepareEpoch || !this.#workerStarted) return;
          this.#send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "sign-response",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : "Signal signing failed.",
          });
        }
        break;
      }
      case "host-response":
        this.#handleHostResponse(message);
        break;
      case "diagnostic":
        for (const listener of this.#diagnosticListeners) listener(message.diagnostic);
        if (
          !message.diagnostic.isSecureContext ||
          !message.diagnostic.peerConnection ||
          !message.diagnostic.dataChannel ||
          !message.diagnostic.loopback
        ) {
          this.#fail(
            "worker_capability",
            message.diagnostic.detail ?? "WKWebView cannot create host WebRTC control.",
          );
        }
        break;
      case "error":
        if (!message.retryable) {
          this.#fail(message.code, message.message);
          break;
        }
        this.#emitError({
          code: message.code,
          message: message.message,
          retryable: message.retryable,
          ...(message.detail === undefined ? {} : { detail: message.detail }),
        });
        break;
      default:
        break;
    }
  }

  #handleHostResponse(message: Extract<WorkerToNativeMessage, { type: "host-response" }>): void {
    if (message.requestId === HOST_HELLO_BRIDGE_ID) {
      try {
        this.#capabilities = parseHostHello(message.result);
        if (!this.parent && !this.hasCapability("session.transport.v1")) {
          this.#fail(
            "daemon_update_required",
            "Update SPAWN D on this host to share its connection.",
          );
        }
      } catch (error) {
        this.#fail(
          "host_hello",
          error instanceof Error ? error.message : "Host hello could not be decoded.",
        );
      }
      return;
    }
    if (message.requestId.startsWith(HOST_STREAM_BRIDGE_PREFIX)) {
      this.#streams.handle(message.result);
      return;
    }
    const command = this.#commands.get(message.requestId);
    if (command) {
      clearTimeout(command.timer);
      this.#commands.delete(message.requestId);
      if (message.ok) command.resolve();
      else {
        command.reject(
          new HostControlTransportError(
            message.error?.code ?? "stream_send_failed",
            message.error?.detail,
          ),
        );
      }
      return;
    }
    const pending = this.#finishPending(message.requestId);
    if (!pending) return;
    if (message.ok) pending.resolve(message.result);
    else {
      pending.reject(
        new HostControlTransportError(
          message.error?.code ?? "request_failed",
          message.error?.detail ?? "Host-control request failed.",
        ),
      );
    }
  }

  #finishPending(requestId: string): PendingRequest | undefined {
    const pending = this.#pending.get(requestId);
    if (!pending) return undefined;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    return pending;
  }

  #requestFailure(
    pending: PendingRequest,
    fallback: HostControlTransportError,
  ): HostControlTransportError {
    return pending.indeterminate && pending.dispatched
      ? new HostControlTransportError(
          "outcome_unknown",
          "The host mutation may have completed; reconcile before retrying.",
        )
      : fallback;
  }

  #setState(state: TransportState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
    if (state === "ready") {
      this.#clearReconnectTimer();
      this.#hasEverReady = true;
      this.#reconnectAttempt = 0;
      this.#connectDeadline = null;
      this.#clearConnectWatchdog();
      if (!this.#capabilities) {
        this.#fail("host_hello", "Host became ready without a capability hello.");
        return;
      }
      this.#resolveOpen?.();
      this.#settleOpening();
    }
  }

  #armConnectWatchdog(): void {
    this.#clearConnectWatchdog();
    const remaining = this.#remainingConnectTime();
    this.#connectTimer = setTimeout(
      () => {
        this.#connectTimer = null;
        if (this.#state === "ready" || this.#state === "closed" || this.#state === "failed") return;
        if (this.#hasEverReady && this.#remainingConnectTime() > 0) {
          this.#scheduleReconnect();
          return;
        }
        this.#fail(
          "connect_timeout",
          this.#hasEverReady ? LOST_CONNECTION_MESSAGE : CONNECT_TIMEOUT_MESSAGE,
        );
      },
      Math.min(remaining, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS),
    );
  }

  #remainingConnectTime(): number {
    // Prompt refusals must not extend the same connection attempt indefinitely.
    this.#connectDeadline ??=
      Date.now() +
      (this.#hasEverReady
        ? RECONNECT_BUDGET_MS
        : (this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS));
    return Math.max(0, this.#connectDeadline - Date.now());
  }

  #clearConnectWatchdog(): void {
    if (this.#connectTimer === null) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  #scheduleReconnect(): void {
    if (this.#state === "closed" || this.#state === "failed" || this.#reconnectTimer !== null) {
      return;
    }
    this.#clearConnectWatchdog();
    const remaining = this.#remainingConnectTime();
    this.#setState("reconnecting");
    const lost = new HostControlTransportError(
      "connection_lost",
      "The host connection was lost. Retry the request when it reconnects.",
    );
    this.#emitError({ code: lost.code, message: lost.message, retryable: true });
    this.#rejectActive(lost);
    const delay = Math.min(remaining, reconnectDelay(this.#reconnectAttempt++));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#state === "closed" || this.#state === "failed") return;
      if (this.#remainingConnectTime() === 0) {
        this.#fail(
          "connect_timeout",
          this.#hasEverReady ? LOST_CONNECTION_MESSAGE : CONNECT_TIMEOUT_MESSAGE,
        );
        return;
      }
      this.#capabilities = null;
      if (this.parent) {
        this.#detachConsumer();
        this.#syncConsumer();
        return;
      }
      this.#setState("signalling");
      this.#loadEndorsements(this.#preflightTrust());
      this.#armConnectWatchdog();
      this.#startSignal();
    }, delay);
  }

  #clearReconnectTimer(): void {
    clearTimeout(this.#reconnectTimer ?? undefined);
    this.#reconnectTimer = null;
  }

  /**
   * The endorsement edges the next offer will carry, read once per attempt.
   * Mirrors the session transport: a set frozen when the channel opened is the
   * set from before the refusal, and the edge that admits this device is
   * written by the approval that follows it.
   */
  #loadEndorsements(trust: Promise<DeviceHostTrustResult>): void {
    this.#endorsements = trust
      .then((result) =>
        result.directlyPinned && !this.#refused
          ? []
          : (this.options.loadCarriedEndorsements ?? loadMemoizedCarriedEndorsements)(),
      )
      .catch(() => []);
  }

  /** A refusal makes both memoized views of this device's admission wrong: the
   * verdict, and the edges the next offer carries. */
  #handleRtcRefusal(): void {
    this.#refused = true;
    invalidateDeviceHostTrust(this.hostId);
  }

  /** Mirrors the session transport: a host that never pinned this device drops
   * its offers silently, so name that instead of waiting out the watchdog. */
  #preflightTrust(): Promise<DeviceHostTrustResult> {
    const epoch = this.#prepareEpoch;
    const result = (
      this.options.probeTrustResult
        ? this.options.probeTrustResult(this.hostId)
        : this.options.probeTrust
          ? this.options
              .probeTrust(this.hostId)
              .then((status) => ({ status, directlyPinned: false }))
          : probeDeviceHostTrustResult(this.hostId)
    ).catch(() => ({ status: "unknown" as const, directlyPinned: false }));
    void result.then(({ status }) => {
      if (epoch !== this.#prepareEpoch) return;
      if (status !== "untrusted") return;
      if (this.#state === "ready" || this.#state === "closed" || this.#state === "failed") return;
      this.#fail(DEVICE_NOT_TRUSTED_CODE, DEVICE_NOT_TRUSTED_MESSAGE);
    });
    return result;
  }

  #fail(code: string, message: string): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#retireWorker();
    const error = new HostControlTransportError(code, message);
    this.#emitError({ code, message, retryable: false });
    this.#setState("failed");
    this.#rejectOpen?.(error);
    this.#settleOpening();
    this.#rejectActive(error);
  }

  #rejectActive(error: Error): void {
    for (const requestId of [...this.#pending.keys()]) {
      const pending = this.#finishPending(requestId);
      if (pending) {
        pending.reject(
          this.#requestFailure(
            pending,
            error instanceof HostControlTransportError
              ? error
              : new HostControlTransportError("connection_closed", error.message),
          ),
        );
      }
    }
    for (const [requestId, command] of this.#commands) {
      clearTimeout(command.timer);
      command.reject(error);
      this.#commands.delete(requestId);
    }
    this.#streams.close(error);
  }

  #emitError(error: TransportError): void {
    this.#lastError = error;
    for (const listener of this.#errorListeners) listener(error);
  }

  #settleOpening(): void {
    this.#opening = null;
    this.#resolveOpen = null;
    this.#rejectOpen = null;
  }
}

export function createHostTransport(options: HostTransportOptions): StreamingHostTransport {
  return new WebViewHostTransport(options);
}

/** A file-tool protocol instance with its own channel on the retained root. */
export function createHostConsumerTransport(
  options: HostTransportOptions,
  parent: HostTransport,
): StreamingHostTransport {
  return new WebViewHostTransport(options, parent);
}
