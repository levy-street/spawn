import type { DeviceHostTrust } from "@/data/trust/device-trust";
import type { TerminalTheme } from "@/theme";

export type TransportState =
  | "idle"
  | "signalling"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed"
  | "failed";

export interface TransportError {
  code: string;
  message: string;
  retryable: boolean;
  detail?: unknown;
}

export interface ScrollState {
  atBottom: boolean;
  viewportY: number;
  baseY: number;
  buffer: "normal" | "alternate";
  newOutputWhileAway: boolean;
}

/**
 * Who owns the shared PTY geometry. Several viewers can watch one session, but
 * only the owner's grid sizes it — a follower that resizes anyway is refused,
 * and every row it draws is written for a terminal it does not have.
 */
export interface DisplayControlState {
  owner: boolean;
  viewers: number;
  cols: number | null;
  rows: number | null;
}

export interface WorkerDiagnostic {
  isSecureContext: boolean;
  peerConnection: boolean;
  dataChannel: boolean;
  loopback: boolean;
  renderer: "webgl" | "dom" | null;
  detail?: string;
}

export interface UploadSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface UploadRequest {
  uploadId?: string;
  name: string;
  mimeType: string;
  destination: "attachments" | "cwd";
  totalBytes: number;
  sha256: string;
  source: UploadSource;
  /** Must durably reserve outcome_unknown before the final chunk is dispatched. */
  beforeFinalDispatch(): Promise<void>;
}

export type UploadState =
  | "queued"
  | "starting"
  | "uploading"
  | "outcome_unknown"
  | "complete"
  | "cancelled"
  | "failed";

export interface UploadProgress {
  uploadId: string;
  state: UploadState;
  sentBytes: number;
  totalBytes: number;
  path?: string;
  error?: TransportError;
}

export interface UploadResult {
  uploadId: string;
  path: string;
  totalBytes: number;
  sha256: string;
}

export interface UploadHandle {
  readonly uploadId: string;
  readonly state: UploadState;
  readonly result: Promise<UploadResult>;
  cancel(): void;
  onProgress(fn: (progress: UploadProgress) => void): () => void;
}

export interface WorkerEndpoint {
  send(message: import("@/terminal/transport/bridge").NativeToWorkerMessage): void;
  onMessage(
    fn: (message: import("@/terminal/transport/bridge").WorkerToNativeMessage) => void,
  ): () => void;
}

export interface SignalChannelLike {
  readonly state: string;
  send(frame: unknown): void;
  onFrame(fn: (frame: unknown) => void): () => void;
  close(): void;
}

export interface SessionTransportOptions {
  sessionId: string;
  hostIdentityPublicKey: string;
  initialSize: { cols: number; rows: number };
  theme: TerminalTheme;
  bridge: WorkerEndpoint;
  fontSize?: number;
  forceRelay?: boolean;
  openSignal?: (sessionId: string) => SignalChannelLike;
  /** Enables the trust preflight; without it an unapproved device only learns from the watchdog. */
  hostId?: string;
  probeTrust?: (hostId: string) => Promise<DeviceHostTrust>;
  /** Defaults to {@link CONNECT_TIMEOUT_MS}; lower values support deterministic tests. */
  connectTimeoutMs?: number;
}

export interface SessionTransport {
  readonly sessionId: string;
  readonly state: TransportState;
  open(): Promise<void>;
  close(): void;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Claims the shared display so this viewer's grid sizes the PTY. */
  takeControl(): void;
  requestReplay(fromOffset?: number): void;
  upload(file: UploadRequest): UploadHandle;
  on(ev: "state", fn: (s: TransportState) => void): () => void;
  on(ev: "error", fn: (e: TransportError) => void): () => void;
  on(ev: "title", fn: (t: string) => void): () => void;
  on(ev: "bell", fn: () => void): () => void;
  on(ev: "scroll", fn: (s: ScrollState) => void): () => void;
  on(ev: "diagnostic", fn: (d: WorkerDiagnostic) => void): () => void;
  on(ev: "display", fn: (d: DisplayControlState) => void): () => void;
}

export interface HostControlError {
  code: string;
  detail?: string;
}

export interface HostControlLimits {
  readonly frameBytes: number;
  readonly chunkBytes: number;
  readonly fileBytes: number;
  readonly rangeBytes: number;
  readonly previewBytes: number;
  readonly previewPixels: readonly (128 | 256 | 512 | 1024)[];
  readonly normalQueue: number | null;
  readonly fastQueue: number | null;
}

export interface HostCapabilities {
  readonly protocol: "spawn.host.ctl";
  readonly version: 1;
  readonly operations: readonly string[];
  readonly limits: HostControlLimits;
}

export interface HostRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HostReadableFile {
  readonly streamId: string;
  readonly path: string;
  readonly name: string;
  readonly length: number;
  readonly sha256: string;
  readonly stream: ReadableStream<Uint8Array>;
}

export interface HostRangeFile extends HostReadableFile {
  readonly offset: number;
  readonly fileSize: number;
  readonly version: string | null;
  readonly contentType: string | null;
  readonly openAllowed: boolean;
  readonly eof: boolean;
}

export interface HostPreviewFile extends HostReadableFile {
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly version?: string | null;
}

export interface HostReadHead {
  readonly bytes: Uint8Array;
  readonly total: number;
  readonly truncated: boolean;
}

export interface HostFileSource {
  readonly size: number;
  /** Sources used by writeFile must support the hashing pass and the later upload pass. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface HostWriteDeclaration {
  readonly dir: string;
  readonly name: string;
  readonly length: number;
  readonly sha256: string;
  readonly overwrite?: boolean;
}

export type HostWritePhase =
  | "hashing"
  | "declaring"
  | "streaming"
  | "finalizing"
  | "outcome_unknown"
  | "complete"
  | "failed"
  | "cancelled";

export interface HostWriteProgress {
  readonly phase: HostWritePhase;
  readonly transferred: number;
  readonly total: number;
}

export interface HostWriteOptions extends HostRequestOptions {
  onProgress?(progress: HostWriteProgress): void;
}

export interface HostWriteResult {
  readonly path: string;
  readonly length: number;
  readonly sha256: string;
}

export interface HostControlResponse<T = unknown> {
  version: 1;
  type: "response";
  request_id: string;
  ok: boolean;
  result?: T;
  error?: HostControlError;
}

export interface HostTransportOptions {
  hostId: string;
  hostIdentityPublicKey: string;
  bridge: WorkerEndpoint;
  forceRelay?: boolean;
  openSignal?: (hostId: string) => SignalChannelLike;
  /** Defaults to the protocol maximum of 60 seconds; lower values support deterministic tests. */
  streamTimeoutMs?: number;
  probeTrust?: (hostId: string) => Promise<DeviceHostTrust>;
  /** Defaults to {@link CONNECT_TIMEOUT_MS}; lower values support deterministic tests. */
  connectTimeoutMs?: number;
}

export interface HostTransport {
  readonly hostId: string;
  readonly state: TransportState;
  /** Null until this RTC generation's hello frame is decoded. */
  readonly capabilities?: HostCapabilities | null;
  open(): Promise<void>;
  close(): void;
  request<T>(operation: string, payload?: unknown, options?: HostRequestOptions): Promise<T>;
  cancel(requestId: string): void;
  hasCapability?(operation: string): boolean;
  readFile?(path: string, options?: HostRequestOptions): Promise<HostReadableFile>;
  readRange?(
    path: string,
    offset: number,
    length: number,
    options?: HostRequestOptions,
  ): Promise<HostRangeFile>;
  readHead?(
    path: string,
    limit: number,
    options?: HostRequestOptions & { size?: number | null },
  ): Promise<HostReadHead>;
  previewImage?(
    path: string,
    maxPixels: 128 | 256 | 512 | 1024,
    options?: HostRequestOptions,
  ): Promise<HostPreviewFile>;
  writeStream?(
    stream: ReadableStream<Uint8Array>,
    declaration: HostWriteDeclaration,
    options?: HostWriteOptions,
  ): Promise<HostWriteResult>;
  writeFile?(
    source: HostFileSource,
    destination: Omit<HostWriteDeclaration, "length" | "sha256">,
    options?: HostWriteOptions,
  ): Promise<HostWriteResult>;
  transferFileTo?(
    destination: HostTransport,
    path: string,
    destinationDirectory: string,
    options?: HostWriteOptions & { overwrite?: boolean },
  ): Promise<HostWriteResult>;
  on(ev: "state", fn: (state: TransportState) => void): () => void;
  on(ev: "error", fn: (error: TransportError) => void): () => void;
  on(ev: "diagnostic", fn: (diagnostic: WorkerDiagnostic) => void): () => void;
}

/** Production host-control surface. HostTransport keeps stream members optional for test doubles. */
export interface StreamingHostTransport extends HostTransport {
  readonly capabilities: HostCapabilities | null;
  hasCapability(operation: string): boolean;
  readFile(path: string, options?: HostRequestOptions): Promise<HostReadableFile>;
  readRange(
    path: string,
    offset: number,
    length: number,
    options?: HostRequestOptions,
  ): Promise<HostRangeFile>;
  readHead(
    path: string,
    limit: number,
    options?: HostRequestOptions & { size?: number | null },
  ): Promise<HostReadHead>;
  previewImage(
    path: string,
    maxPixels: 128 | 256 | 512 | 1024,
    options?: HostRequestOptions,
  ): Promise<HostPreviewFile>;
  writeStream(
    stream: ReadableStream<Uint8Array>,
    declaration: HostWriteDeclaration,
    options?: HostWriteOptions,
  ): Promise<HostWriteResult>;
  writeFile(
    source: HostFileSource,
    destination: Omit<HostWriteDeclaration, "length" | "sha256">,
    options?: HostWriteOptions,
  ): Promise<HostWriteResult>;
  transferFileTo(
    destination: HostTransport,
    path: string,
    destinationDirectory: string,
    options?: HostWriteOptions & { overwrite?: boolean },
  ): Promise<HostWriteResult>;
}

export type NamedTerminalKey =
  | "Escape"
  | "Tab"
  | "BackTab"
  | "Enter"
  | "ShiftEnter"
  | "MobileReturn"
  | "Backspace"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "Insert"
  | "Delete"
  | "PageUp"
  | "PageDown"
  | "F1"
  | "F2"
  | "F3"
  | "F4"
  | "F5"
  | "F6"
  | "F7"
  | "F8"
  | "F9"
  | "F10"
  | "F11"
  | "F12";

export interface KeyModifiers {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

export type KeySpec =
  | { kind: "named"; key: NamedTerminalKey; modifiers?: KeyModifiers; applicationCursor?: boolean }
  | { kind: "text"; text: string; modifiers?: KeyModifiers };
