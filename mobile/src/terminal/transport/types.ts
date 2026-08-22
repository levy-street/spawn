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
}

export interface SessionTransport {
  readonly sessionId: string;
  readonly state: TransportState;
  open(): Promise<void>;
  close(): void;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  requestReplay(fromOffset?: number): void;
  upload(file: UploadRequest): UploadHandle;
  on(ev: "state", fn: (s: TransportState) => void): () => void;
  on(ev: "error", fn: (e: TransportError) => void): () => void;
  on(ev: "title", fn: (t: string) => void): () => void;
  on(ev: "bell", fn: () => void): () => void;
  on(ev: "scroll", fn: (s: ScrollState) => void): () => void;
  on(ev: "diagnostic", fn: (d: WorkerDiagnostic) => void): () => void;
}

export interface HostControlError {
  code: string;
  detail?: string;
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
}

export interface HostTransport {
  readonly hostId: string;
  readonly state: TransportState;
  open(): Promise<void>;
  close(): void;
  request<T>(operation: string, payload?: unknown): Promise<T>;
  cancel(requestId: string): void;
  on(ev: "state", fn: (state: TransportState) => void): () => void;
  on(ev: "error", fn: (error: TransportError) => void): () => void;
  on(ev: "diagnostic", fn: (diagnostic: WorkerDiagnostic) => void): () => void;
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
