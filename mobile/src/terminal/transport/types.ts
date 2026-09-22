import type { CarriedEndorsement } from "@/data/trust/carried-endorsements";
import type { DeviceHostTrust, DeviceHostTrustResult } from "@/data/trust/device-trust";
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

export interface ConnectionInfo {
  kind: "direct" | "stun" | "relay" | "unknown";
  rttMs: number | null;
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
  /** Native documents must finish loading before initialization can be sent. */
  whenReady?(): Promise<void>;
  send(message: import("@/terminal/transport/bridge").NativeToWorkerMessage): void;
  onMessage(
    fn: (message: import("@/terminal/transport/bridge").WorkerToNativeMessage) => void,
  ): () => void;
}

export interface SignalChannelLike {
  readonly state: string;
  readonly closeInfo?: { code: number; reason: string } | null;
  send(frame: unknown): void;
  onFrame(fn: (frame: unknown) => void): () => void;
  onState?(fn: (state: string) => void): () => void;
  close(): void;
}

export interface SessionTransportOptions {
  sessionId: string;
  hostIdentityPublicKey: string;
  initialSize: { cols: number; rows: number };
  theme: TerminalTheme;
  bridge: WorkerEndpoint;
  fontSize?: number;
  /** The daemon whose persistent connection owns this terminal attachment. */
  hostId?: string;
  /** Defaults to {@link CONNECT_TIMEOUT_MS}; lower values support deterministic tests. */
  connectTimeoutMs?: number;
}

export interface SessionTransport {
  readonly sessionId: string;
  readonly state: TransportState;
  readonly daemonState?: TransportState;
  /** Retains the app-owned daemon connection before the terminal WebView loads. */
  prepare?(): void;
  networkChanged?(): void;
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
  on(ev: "connection-info", fn: (info: ConnectionInfo) => void): () => void;
  on(ev: "display", fn: (d: DisplayControlState) => void): () => void;
  on(ev: "agent-notice", fn: (notice: AgentNotice | null) => void): () => void;
}

/**
 * A notice an agent CLI paints into its own status bar, read back off the
 * rendered screen by the worker that is showing it — never off the wire, so
 * the daemon and server stay content-blind. The one recognised so far: the
 * agent installed a newer version of itself in the background and is still
 * running the old one.
 */
export type AgentNotice = "update_installed";

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
  loadCarriedEndorsements?: () => Promise<readonly CarriedEndorsement[]>;
  /** Defaults to the protocol maximum of 60 seconds; lower values support deterministic tests. */
  streamTimeoutMs?: number;
  probeTrust?: (hostId: string) => Promise<DeviceHostTrust>;
  probeTrustResult?: (hostId: string) => Promise<DeviceHostTrustResult>;
  /** Defaults to {@link CONNECT_TIMEOUT_MS}; lower values support deterministic tests. */
  connectTimeoutMs?: number;
}

export interface HostTransport {
  readonly hostId: string;
  readonly lastError?: TransportError | null;
  readonly state: TransportState;
  /** Null until this RTC generation's hello frame is decoded. */
  readonly capabilities?: HostCapabilities | null;
  prepare?(): void;
  networkChanged?(): void;
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

/**
 * The server's `ice_transport_policy`, read defensively.
 *
 * Anything but an explicit "relay" means the deployment still offers direct
 * paths: an older server that does not send the field at all must not be read
 * as forbidding them.
 */
export function readTransportPolicy(value: unknown): "all" | "relay" {
  if (value !== undefined && value !== "all" && value !== "relay") {
    console.warn(`Ignoring unrecognised ice_transport_policy: ${String(value)}`);
  }
  return value === "relay" ? "relay" : "all";
}

const ICE_URL = /^(?:stun|stuns|turn|turns):/i;
const TURN_URL = /^turns?:/i;
const MAX_ICE_SERVER_ENTRIES = 8;

/** Keep only browser-safe ICE schemes and require credentials for TURN. */
export function sanitizeIceServers(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const sanitized: Array<Record<string, unknown>> = [];
  for (const candidate of value) {
    if (sanitized.length >= MAX_ICE_SERVER_ENTRIES) break;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const rawUrls = typeof record["urls"] === "string" ? [record["urls"]] : record["urls"];
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) continue;
    if (!rawUrls.every((url) => typeof url === "string" && ICE_URL.test(url))) continue;
    const hasTurn = rawUrls.some((url) => TURN_URL.test(url as string));
    if (
      hasTurn &&
      (typeof record["username"] !== "string" ||
        record["username"].length === 0 ||
        typeof record["credential"] !== "string" ||
        record["credential"].length === 0)
    ) {
      continue;
    }
    sanitized.push({
      urls: typeof record["urls"] === "string" ? rawUrls[0] : rawUrls,
      ...(hasTurn ? { username: record["username"], credential: record["credential"] } : {}),
    });
  }
  return sanitized;
}

/** Coturn REST usernames start with their Unix expiry. Refresh one hour early. */
export function iceServersNeedRefresh(
  iceServers: readonly Record<string, unknown>[],
  nowMs = Date.now(),
): boolean {
  const refreshBeforeSeconds = Math.floor(nowMs / 1_000) + 60 * 60;
  for (const server of iceServers) {
    const rawUrls = server["urls"];
    const urls = typeof rawUrls === "string" ? [rawUrls] : rawUrls;
    if (
      !Array.isArray(urls) ||
      !urls.some((url) => typeof url === "string" && TURN_URL.test(url))
    ) {
      continue;
    }
    const username = server["username"];
    const expiry = Number.parseInt(
      typeof username === "string" ? (username.split(":", 1)[0] ?? "") : "",
      10,
    );
    if (Number.isSafeInteger(expiry) && expiry <= refreshBeforeSeconds) return true;
  }
  return false;
}

export const CONNECT_TIMEOUT_MS = 25_000;
export const CONNECT_TIMEOUT_MESSAGE =
  "The host did not answer in time. It may be offline, or it may not have approved this device.";
export const LOST_CONNECTION_MESSAGE =
  "SPAWN D lost the connection to this host and could not restore it.";
