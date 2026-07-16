import { hashStream, Sha256 } from "@/lib/sha256";
import { buildHostWsUrl } from "@/lib/ws";

export const HOST_CONTROL_PROTOCOL = "spawn.host.ctl";
export const HOST_CONTROL_VERSION = 1;

const HOST_SIGNAL_SUBPROTOCOL = "spawn.host.v1";
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const STREAM_CHUNK_BYTES = 8 * 1024;
const STREAM_WINDOW_CHUNKS = 8;
const STREAM_BUFFERED_HIGH_WATER = 256 * 1024;
const STREAM_TIMEOUT_MS = 60_000;
const FALLBACK_DOWNLOAD_MEMORY_LIMIT = 32 * 1024 * 1024;
const MAX_STREAM_TOMBSTONES = 256;
const STREAM_TOMBSTONE_TTL_MS = 120_000;
const INDETERMINATE_REQUEST_OPERATIONS = new Set([
  "fs.mkdir",
  "fs.rename",
  "fs.remove",
  "tool.install",
]);
const MAX_TOOL_TARGETS = 8;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024;
const TOOL_CHECK_TIMEOUT_MS = 30_000;
const TOOL_INSTALL_TIMEOUT_MS = 195_000;
const TOOL_CANCEL_RESPONSE_TIMEOUT_MS = 5_000;
const TOOL_COMMANDS = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  aider: "aider",
  shell: "bash",
} as const;
const TOOL_INSTALL_ARGV = {
  "claude-code": ["npm", "install", "--global", "@anthropic-ai/claude-code"],
  codex: ["npm", "install", "--global", "@openai/codex"],
  opencode: ["npm", "install", "--global", "opencode-ai"],
  aider: ["python3", "-m", "pip", "install", "--user", "--upgrade", "aider-chat"],
} as const;
export const HOST_DIRECTORY_PAGE_ENTRIES = 96;

export class HostControlError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
    public readonly data?: unknown,
  ) {
    super(detail || code);
    this.name = "HostControlError";
  }
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

export type InteractiveToolKind = keyof typeof TOOL_COMMANDS;

export interface HostToolTargetRef {
  target_id: string;
  tool: InteractiveToolKind;
}

export interface HostToolStatus {
  target_id: string;
  tool: InteractiveToolKind;
  command: string[];
  installed: boolean;
  path?: string | null;
  version?: string | null;
  latest_version?: string | null;
  update_available?: boolean | null;
  error?: string | null;
}

export interface HostToolInstallResult {
  target_id: string;
  tool: InteractiveToolKind;
  command: string[];
  install_argv: string[];
  outcome: "succeeded" | "unknown";
  success: boolean;
  exit_code?: number | null;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
  error?: string | null;
  status?: HostToolStatus | null;
}

export interface HostReadStream {
  streamId: string;
  path: string;
  name: string;
  length: number;
  sha256: string;
  stream: ReadableStream<Uint8Array>;
}

export type HostControlState = "idle" | "connecting" | "open" | "ready" | "closed" | "error";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  mutation: boolean;
  operation: string;
  dispatched: boolean;
  cancelRequested?: boolean;
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

type SignalMessage =
  | ({
      type: "rtc.config";
      enabled: boolean;
      ice_servers?: RTCIceServer[];
      ice_transport_policy?: RTCIceTransportPolicy;
    } & SignalMetadata)
  | ({ type: "rtc.answer"; session_id: string; sdp: string } & SignalMetadata)
  | ({ type: "rtc.candidate"; session_id: string; candidate: RTCIceCandidateInit } & SignalMetadata)
  | ({ type: "rtc.status"; session_id?: string; status: string } & SignalMetadata);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HostControlRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HostControlClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
  reconnectBaseDelayMs?: number;
  /** Primarily useful for bounded clients and deterministic timeout tests. */
  streamTimeoutMs?: number;
}

export class HostControlClient {
  private state: HostControlState = "idle";
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private sessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectionAttempt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private stopped = true;
  private pending = new Map<string, PendingRequest>();
  private incomingStreams = new Map<string, IncomingStream>();
  private cancelledIncomingStreams = new Map<string, CancelledIncomingStream>();
  private outgoingStreams = new Map<string, OutgoingStream>();
  private listeners = new Set<(state: HostControlState) => void>();

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
    this.openWebSocket();
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
    this.connectionAttempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearConnectDeadline();
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
        operation,
        dispatched: false,
      };
      if (options.signal) {
        const onAbort = () => {
          const pendingInstall = this.pending.get(requestId);
          if (
            pendingInstall?.operation === "tool.install" &&
            pendingInstall.dispatched &&
            !pendingInstall.cancelRequested
          ) {
            pendingInstall.cancelRequested = true;
            pendingInstall.removeAbort?.();
            pendingInstall.removeAbort = undefined;
            clearTimeout(pendingInstall.timer);
            this.sendCancel(requestId);
            pendingInstall.timer = setTimeout(
              () => {
                const current = this.finishPending(requestId);
                if (!current) return;
                current.reject(
                  this.requestAcknowledgementLost(
                    current,
                    new DOMException("Host tool install cancellation timed out", "AbortError"),
                  ),
                );
              },
              Math.min(timeoutMs, TOOL_CANCEL_RESPONSE_TIMEOUT_MS),
            );
            return;
          }
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

  async readFile(path: string, options?: HostControlRequestOptions): Promise<HostReadStream> {
    const declaration = await this.request<{
      stream_id: string;
      path: string;
      name: string;
      length: number;
      sha256: string;
    }>("fs.read", { path }, options);
    const { stream_id: streamId, length, sha256 } = declaration;
    this.pruneIncomingTombstones();
    if (
      typeof streamId !== "string" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
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
    return {
      streamId,
      path: declaration.path,
      name: declaration.name,
      length,
      sha256,
      stream,
    };
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

  async checkTools(
    targets: HostToolTargetRef[],
    options?: HostControlRequestOptions,
  ): Promise<HostToolStatus[]> {
    validateToolTargets(targets);
    const result = await this.request<unknown>(
      "tool.check",
      { targets },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? TOOL_CHECK_TIMEOUT_MS,
      },
    );
    if (
      !isJsonObject(result) ||
      !Array.isArray(result.tools) ||
      result.tools.length !== targets.length
    ) {
      this.failRtc();
      throw new HostControlError("invalid_response", "Host returned an invalid tool check result");
    }
    const statuses = result.tools.map((value, index) => parseToolStatus(value, targets[index]));
    if (statuses.some((status) => status === null)) {
      this.failRtc();
      throw new HostControlError("invalid_response", "Host returned an invalid tool check result");
    }
    return statuses as HostToolStatus[];
  }

  async installTool(
    target: HostToolTargetRef,
    options?: HostControlRequestOptions,
  ): Promise<HostToolInstallResult> {
    validateToolTargets([target]);
    if (target.tool === "shell") {
      throw new HostControlError("install_unavailable", "The shell target has no install policy");
    }
    const value = await this.request<unknown>(
      "tool.install",
      { target },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? TOOL_INSTALL_TIMEOUT_MS,
      },
    );
    const result = parseToolInstallResult(value, target);
    if (!result) {
      this.failRtc();
      throw new HostControlError(
        "invalid_response",
        "Host returned an invalid tool install result",
      );
    }
    if (result.outcome === "unknown") {
      throw new HostControlError(
        "outcome_unknown",
        result.error ||
          "The install may have changed endpoint state; check the tool before retrying",
        result,
      );
    }
    return result;
  }

  private openWebSocket(): void {
    if (this.stopped) return;
    const attempt = ++this.connectionAttempt;
    const previous = this.ws;
    this.ws = null;
    if (previous) {
      this.detachWebSocket(previous);
      previous.close();
    }
    this.setState("connecting");
    this.clearConnectDeadline();
    this.connectTimer = setTimeout(
      () => {
        if (attempt !== this.connectionAttempt || this.stopped) return;
        this.connectTimer = null;
        this.failRtc();
      },
      Math.max(1, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS),
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildHostWsUrl(this.hostId), HOST_SIGNAL_SUBPROTOCOL);
    } catch {
      this.setState("error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      this.setState("open");
    };
    ws.onmessage = (event) => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      if (typeof event.data !== "string") return;
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
      const message = parsed as unknown as SignalMessage;
      if (!this.matchesMetadata(message)) return;
      if (message.type === "rtc.config" && message.enabled) {
        void this.startRtc(
          message.ice_servers ?? [],
          message.ice_transport_policy === "relay" ? "relay" : "all",
          ws,
          attempt,
        );
      } else if (message.type === "rtc.answer" && message.session_id === this.sessionId) {
        const pc = this.pc;
        if (!pc) return;
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
        if (this.pc?.remoteDescription) {
          void this.pc.addIceCandidate(message.candidate).catch(() => {});
        } else {
          this.pendingRemoteCandidates.push(message.candidate);
        }
      } else if (
        message.type === "rtc.status" &&
        message.session_id === this.sessionId &&
        ["failed", "disabled", "unavailable"].includes(message.status)
      ) {
        this.failRtc(message.session_id);
      }
    };
    ws.onerror = () => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      this.setState("error");
    };
    ws.onclose = () => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      this.detachWebSocket(ws);
      this.ws = null;
      this.clearConnectDeadline();
      this.cleanupRtc(false);
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
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    const channel = pc.createDataChannel(HOST_CONTROL_PROTOCOL, { ordered: true });
    this.pc = pc;
    this.channel = channel;
    this.sessionId = sessionId;
    this.pendingRemoteCandidates = [];
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.sessionId !== sessionId || !this.isCurrentWebSocket(ws, attempt))
        return;
      this.sendSignal(
        {
          type: "rtc.candidate",
          session_id: sessionId,
          candidate: event.candidate.toJSON(),
        },
        ws,
        attempt,
      );
    };
    pc.onconnectionstatechange = () => {
      if (
        this.isCurrentWebSocket(ws, attempt) &&
        ["failed", "closed"].includes(pc.connectionState)
      ) {
        this.failRtc(sessionId);
      }
    };
    channel.onmessage = (event) => {
      if (!this.isCurrentWebSocket(ws, attempt)) return;
      this.handleControlMessage(event.data, sessionId);
    };
    channel.onclose = () => {
      if (this.isCurrentWebSocket(ws, attempt)) this.failRtc(sessionId);
    };
    channel.onerror = () => {
      if (!this.isCurrentWebSocket(ws, attempt) || this.sessionId !== sessionId) return;
      this.setState("error");
      this.failRtc(sessionId);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.sessionId !== sessionId || !this.isCurrentWebSocket(ws, attempt)) return;
      this.sendSignal(
        { type: "rtc.offer", session_id: sessionId, sdp: offer.sdp ?? "" },
        ws,
        attempt,
      );
    } catch {
      if (this.isCurrentWebSocket(ws, attempt)) this.failRtc(sessionId);
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
    };
    if (message.version !== HOST_CONTROL_VERSION) {
      this.failRtc(sessionId);
      return;
    }
    if (message.type === "hello" && message.protocol === HOST_CONTROL_PROTOCOL) {
      this.clearConnectDeadline();
      this.reconnectAttempt = 0;
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
    if (pending.operation === "tool.install") {
      return new HostControlError(
        "outcome_unknown",
        "The install may have changed endpoint state; run a tool check before retrying",
      );
    }
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
    this.sessionId = null;
    if (notifyServer && sessionId) this.sendSignal({ type: "rtc.close", session_id: sessionId });
    const channel = this.channel;
    const pc = this.pc;
    this.channel = null;
    this.pc = null;
    this.pendingRemoteCandidates = [];
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
    if (this.stopped || this.reconnectTimer) return;
    this.clearConnectDeadline();
    this.reconnectAttempt += 1;
    const attempt = this.connectionAttempt;
    const delay = Math.min(
      10_000,
      Math.max(1, this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS) *
        this.reconnectAttempt,
    );
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
      this.cleanupRtc(false);
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

export function isInteractiveToolKind(value: string): value is InteractiveToolKind {
  return Object.hasOwn(TOOL_COMMANDS, value);
}

function validateToolTargets(targets: HostToolTargetRef[]): void {
  if (targets.length === 0 || targets.length > MAX_TOOL_TARGETS) {
    throw new HostControlError("invalid_request", "Tool target count is outside the allowed range");
  }
  const ids = new Set<string>();
  for (const target of targets) {
    if (
      !/^[A-Za-z0-9-]{1,128}$/.test(target.target_id) ||
      !isInteractiveToolKind(target.tool) ||
      ids.has(target.target_id)
    ) {
      throw new HostControlError("invalid_request", "Tool target metadata is invalid");
    }
    ids.add(target.target_id);
  }
}

function parseToolStatus(value: unknown, expected: HostToolTargetRef): HostToolStatus | null {
  if (!isJsonObject(value)) return null;
  if (
    !hasOnlyKeys(value, [
      "target_id",
      "tool",
      "command",
      "installed",
      "path",
      "version",
      "latest_version",
      "update_available",
      "error",
    ])
  ) {
    return null;
  }
  const command = value.command;
  if (
    value.target_id !== expected.target_id ||
    value.tool !== expected.tool ||
    !Array.isArray(command) ||
    command.length !== 1 ||
    command[0] !== TOOL_COMMANDS[expected.tool] ||
    typeof value.installed !== "boolean" ||
    !optionalBoundedString(value.path, 512) ||
    !optionalBoundedString(value.version, 240) ||
    !optionalBoundedString(value.latest_version, 240) ||
    !optionalBoundedString(value.error, 512) ||
    (value.update_available !== undefined &&
      value.update_available !== null &&
      typeof value.update_available !== "boolean")
  ) {
    return null;
  }
  if (
    (typeof value.path === "string" && !value.path.startsWith("/")) ||
    (value.installed &&
      (typeof value.path !== "string" ||
        typeof value.version !== "string" ||
        parseNumericVersion(value.version) === null ||
        value.error != null)) ||
    (!value.installed &&
      (value.path != null || value.version != null || value.update_available != null)) ||
    (typeof value.latest_version === "string" && parseNumericVersion(value.latest_version) === null)
  ) {
    return null;
  }
  if (value.installed && typeof value.latest_version === "string") {
    const expectedUpdate = versionSuggestsUpdate(value.version as string, value.latest_version);
    if (expectedUpdate === null || value.update_available !== expectedUpdate) return null;
  } else if (value.update_available != null) {
    return null;
  }
  return value as unknown as HostToolStatus;
}

function parseToolInstallResult(
  value: unknown,
  expected: HostToolTargetRef,
): HostToolInstallResult | null {
  if (!isJsonObject(value) || expected.tool === "shell") return null;
  if (
    !hasOnlyKeys(value, [
      "target_id",
      "tool",
      "command",
      "install_argv",
      "outcome",
      "success",
      "exit_code",
      "stdout",
      "stderr",
      "output_truncated",
      "error",
      "status",
    ])
  ) {
    return null;
  }
  const expectedInstall = TOOL_INSTALL_ARGV[expected.tool];
  if (
    value.target_id !== expected.target_id ||
    value.tool !== expected.tool ||
    !stringArrayEquals(value.command, [TOOL_COMMANDS[expected.tool]]) ||
    !stringArrayEquals(value.install_argv, expectedInstall) ||
    (value.outcome !== "succeeded" && value.outcome !== "unknown") ||
    typeof value.success !== "boolean" ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    encodedLength(value.stdout) > MAX_TOOL_OUTPUT_BYTES ||
    encodedLength(value.stderr) > MAX_TOOL_OUTPUT_BYTES ||
    typeof value.output_truncated !== "boolean" ||
    !optionalBoundedString(value.error, 512) ||
    (value.exit_code !== undefined &&
      value.exit_code !== null &&
      (!Number.isSafeInteger(value.exit_code) || Math.abs(value.exit_code as number) > 255))
  ) {
    return null;
  }
  const status =
    value.status === undefined || value.status === null
      ? null
      : parseToolStatus(value.status, expected);
  if (
    (value.status !== undefined && value.status !== null && status === null) ||
    (value.outcome === "succeeded" &&
      (!value.success ||
        !status?.installed ||
        typeof status.latest_version !== "string" ||
        status.update_available !== false ||
        value.exit_code !== 0 ||
        value.error != null)) ||
    (value.outcome === "unknown" &&
      (value.success ||
        typeof value.error !== "string" ||
        (status?.installed === true && status.update_available === false)))
  ) {
    return null;
  }
  return { ...(value as unknown as HostToolInstallResult), status };
}

function parseNumericVersion(text: string): bigint[] | null {
  let best: bigint[] = [];
  for (const raw of text.split(/[^A-Za-z0-9.]+/)) {
    const candidate = raw.replace(/^v/, "");
    if (!/^\d/.test(candidate)) continue;
    const parts: bigint[] = [];
    for (const part of candidate.split(".")) {
      if (!/^\d+$/.test(part)) break;
      parts.push(BigInt(part));
    }
    if (parts.length > best.length) best = parts;
  }
  return best.length > 0 ? best : null;
}

function versionSuggestsUpdate(installedText: string, latestText: string): boolean | null {
  const installed = parseNumericVersion(installedText);
  const latest = parseNumericVersion(latestText);
  if (!installed || !latest) return null;
  for (let index = 0; index < Math.max(installed.length, latest.length); index += 1) {
    const left = installed[index] ?? 0n;
    const right = latest[index] ?? 0n;
    if (left < right) return true;
    if (left > right) return false;
  }
  return false;
}

function optionalBoundedString(value: unknown, maxBytes: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && encodedLength(value) <= maxBytes)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function stringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((part, index) => part === expected[index])
  );
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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
