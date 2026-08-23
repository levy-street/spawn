import { openHostSignal } from "@/data/realtime/host-signal";
import {
  DEVICE_NOT_TRUSTED_CODE,
  DEVICE_NOT_TRUSTED_MESSAGE,
  probeDeviceHostTrust,
} from "@/data/trust/device-trust";
import { randomBytes } from "@/lib/crypto/bootstrap";
import { bytesToUuid, encodeHex } from "@/lib/crypto/bytes";
import { TERMINAL_BRIDGE_VERSION, type WorkerToNativeMessage } from "@/terminal/transport/bridge";
import {
  assertHostFileSize,
  collectHostStream,
  HOST_CONTROL_PROTOCOL,
  HOST_CONTROL_VERSION,
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
  CONNECT_TIMEOUT_MESSAGE,
  CONNECT_TIMEOUT_MS,
} from "@/terminal/transport/session-transport";
import {
  browserIdentityWire,
  signWorkerRequest,
  verifyAnswerFrame,
} from "@/terminal/transport/signed-signalling";
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
import { terminalDark, terminalMetrics } from "@/theme";

const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 15_000;
const PREVIEW_REQUEST_TIMEOUT_MS = 35_000;
const HOST_HELLO_BRIDGE_ID = "$host.hello";
const HOST_STREAM_BRIDGE_PREFIX = "$host.stream:";
const STREAM_COMMAND_PREFIX = "$host.stream.";
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
  #capabilities: HostCapabilities | null = null;
  #browserKey: string | null = null;
  #signal: SignalChannelLike | null = null;
  #signalUnsubscribe: (() => void) | null = null;
  #bridgeUnsubscribe: (() => void) | null = null;
  #opening: Promise<void> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #resolveOpen: (() => void) | null = null;
  #rejectOpen: ((error: Error) => void) | null = null;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #commands = new Map<string, PendingCommand>();
  readonly #stateListeners = new Set<(state: TransportState) => void>();
  readonly #errorListeners = new Set<(error: TransportError) => void>();
  readonly #diagnosticListeners = new Set<(diagnostic: WorkerDiagnostic) => void>();

  constructor(private readonly options: HostTransportOptions) {
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

  get capabilities(): HostCapabilities | null {
    return this.#capabilities;
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
    try {
      this.#browserKey = await browserIdentityWire();
      this.#bridgeUnsubscribe = this.options.bridge.onMessage((message) => {
        void this.#handleWorkerMessage(message);
      });
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "init",
        mode: "host",
        scopeId: this.hostId,
        browserIdentityPublicKey: this.#browserKey,
        hostIdentityPublicKey: this.options.hostIdentityPublicKey,
        cols: 80,
        rows: 24,
        theme: terminalDark,
        fontSize: terminalMetrics.fontSize,
      });
      this.#setState("signalling");
      this.#armConnectWatchdog();
      this.#preflightTrust();
      this.#startSignal();
    } catch (error) {
      this.#fail(
        "host_open",
        error instanceof Error ? error.message : "Host transport failed to open.",
      );
    }
    return this.#opening;
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#clearConnectWatchdog();
    try {
      this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "close" });
    } catch {
      // A terminated WebContent process has nothing left to close.
    }
    this.#retireSignal();
    this.#bridgeUnsubscribe?.();
    this.#bridgeUnsubscribe = null;
    this.#capabilities = null;
    this.#setState("closed");
    const error = new HostControlTransportError("connection_closed", "Host transport closed.");
    this.#rejectOpen?.(error);
    this.#settleOpening();
    this.#rejectActive(error);
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
        this.options.bridge.send({
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
      this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "host-cancel", requestId });
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
        this.options.bridge.send({
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
  }

  #retireSignal(): void {
    this.#signalUnsubscribe?.();
    this.#signalUnsubscribe = null;
    this.#signal?.close();
    this.#signal = null;
  }

  #handleSignalFrame(value: unknown): void {
    const frame = record(value);
    if (!frame) return;
    if (frame.type === "rtc.config") {
      // /ws/host binds every frame to the host tuple instead of advertising
      // `binding_nonce_required`; that flag only exists on the session channel.
      if (
        frame.enabled !== true ||
        !Array.isArray(frame.ice_servers) ||
        frame.scope_type !== "host" ||
        frame.scope_id !== this.hostId ||
        frame.protocol !== HOST_CONTROL_PROTOCOL ||
        frame.protocol_version !== HOST_CONTROL_VERSION
      ) {
        this.#fail("rtc_config", "Host RTC configuration is disabled or weakly bound.");
        return;
      }
      this.#setState("connecting");
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "connect",
        rtcSessionId: newUuid(),
        bindingNonce: encodeHex(randomBytes(16)),
        iceServers: frame.ice_servers,
        forceRelay: this.options.forceRelay ?? false,
      });
      return;
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
          protocolVersion: 1,
        },
      );
      this.options.bridge.send({
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

  async #handleWorkerMessage(message: WorkerToNativeMessage): Promise<void> {
    switch (message.type) {
      case "state":
        this.#setState(message.state);
        break;
      case "signal-frame":
        this.#signal?.send(message.frame);
        break;
      case "sign-request":
        try {
          const signature = await signWorkerRequest(message);
          this.options.bridge.send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "sign-response",
            requestId: message.requestId,
            signature,
          });
        } catch (error) {
          this.options.bridge.send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "sign-response",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : "Signal signing failed.",
          });
        }
        break;
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
        this.#emitError({
          code: message.code,
          message: message.message,
          retryable: message.retryable,
          ...(message.detail === undefined ? {} : { detail: message.detail }),
        });
        if (!message.retryable) {
          const error = new HostControlTransportError(message.code, message.message);
          this.#setState("failed");
          this.#rejectActive(error);
        }
        break;
      default:
        break;
    }
  }

  #handleHostResponse(message: Extract<WorkerToNativeMessage, { type: "host-response" }>): void {
    if (message.requestId === HOST_HELLO_BRIDGE_ID) {
      try {
        this.#capabilities = parseHostHello(message.result);
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
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#state === "ready" || this.#state === "closed" || this.#state === "failed") return;
      this.#fail("connect_timeout", CONNECT_TIMEOUT_MESSAGE);
    }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  }

  #clearConnectWatchdog(): void {
    if (this.#connectTimer === null) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  /** Mirrors the session transport: a host that never pinned this device drops
   * its offers silently, so name that instead of waiting out the watchdog. */
  #preflightTrust(): void {
    const probe = this.options.probeTrust ?? probeDeviceHostTrust;
    void probe(this.hostId).then((trust) => {
      if (trust !== "untrusted") return;
      if (this.#state === "ready" || this.#state === "closed" || this.#state === "failed") return;
      this.#fail(DEVICE_NOT_TRUSTED_CODE, DEVICE_NOT_TRUSTED_MESSAGE);
    });
  }

  #fail(code: string, message: string): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#clearConnectWatchdog();
    const error = new HostControlTransportError(code, message);
    this.#emitError({ code, message, retryable: false });
    this.#setState("failed");
    this.#rejectOpen?.(error);
    this.#settleOpening();
    this.#retireSignal();
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
