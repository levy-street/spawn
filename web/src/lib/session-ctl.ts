export const SESSION_CTL_VERSION = 1;
export const SESSION_CTL_MAX_REQUEST_BYTES = 16 * 1024;
export const SESSION_CTL_MAX_REPLAY_BYTES = 12 * 1024 * 1024;
export const SESSION_CTL_MAX_PENDING_PTY_BYTES = 12 * 1024 * 1024;
export const SESSION_CTL_CHUNK_PAYLOAD_BYTES = 48 * 1024;
export const SESSION_CTL_MAX_REPLAY_CHUNKS = Math.ceil(
  SESSION_CTL_MAX_REPLAY_BYTES / SESSION_CTL_CHUNK_PAYLOAD_BYTES,
);
export const SESSION_CTL_MAX_OUTSTANDING_REQUESTS = 128;
export const SESSION_CTL_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const SESSION_CTL_UPLOAD_CHUNK_BYTES = 48 * 1024;
export const SESSION_CTL_UPLOAD_BUFFER_HIGH_WATER = 256 * 1024;
export const SESSION_CTL_UPLOAD_BUFFER_LOW_WATER = 128 * 1024;
export const SESSION_PTY_INPUT_CHUNK_BYTES = 16 * 1024;
export const SESSION_PTY_INPUT_BUFFER_HIGH_WATER = 256 * 1024;
export const SESSION_PTY_INPUT_BUFFER_LOW_WATER = 128 * 1024;

const CHUNK_HEADER_BYTES = 28;
const CHUNK_MAGIC = [0x53, 0x50, 0x43, 0x54]; // SPCT

export type SessionCtlOperation =
  | "history"
  | "snapshot"
  | "resize"
  | "scroll"
  | "redraw"
  | "take_control"
  | "upload_start"
  | "upload_cancel"
  | "upload_complete"
  | "history_subscribe";

export interface SessionCtlResponse {
  version: number;
  kind: "response";
  request_id?: string | null;
  operation?: SessionCtlOperation;
  ok: boolean;
  plain?: boolean;
  pty_offset?: number | null;
  total_bytes?: number;
  chunks?: number;
  error?: { code?: string; detail?: string };
  state?: "ready" | "complete";
  next_sequence?: number;
  received_bytes?: number;
  path?: string;
  sha256?: string;
  /** Committed-history anchor at capture (string: u64 epoch exceeds JS safe
   *  integers). Present only on replays from delta-streaming workers. */
  history_epoch?: string;
  history_offset?: number;
}

export interface SessionCtlDisplayEvent {
  version: number;
  kind: "event";
  event: "display_state";
  owner: boolean;
  cols: number | null;
  rows: number | null;
  viewers: number;
}

export interface SessionCtlReadyEvent {
  version: number;
  kind: "event";
  event: "ready";
  upload_capability: string;
  /** spawn.ctl protocol v1 keeps its historical wire key for this value. */
  agent_generation: number;
  upload_max_bytes: number;
  upload_chunk_bytes: number;
}

/** Committed-history stream events (only sent after `history_subscribe`).
 *  `history_delta` carries one base64 fragment of committed lines starting at
 *  `history_offset` within `history_epoch`; `history_wipe` announces an `ED 3`
 *  scrollback erase (new epoch, offset restarts at 0); `history_gap` means
 *  deltas were lost and the client must re-anchor from a fresh snapshot. */
export interface SessionCtlHistoryDeltaEvent {
  version: number;
  kind: "event";
  event: "history_delta";
  history_epoch: string;
  history_offset: number;
  data: string;
}

export interface SessionCtlHistoryWipeEvent {
  version: number;
  kind: "event";
  event: "history_wipe";
  history_epoch: string;
}

export interface SessionCtlHistoryGapEvent {
  version: number;
  kind: "event";
  event: "history_gap";
}

/** The daemon shed output queued for this slow viewer. The next PTY byte is
 * anchored at `offset`; clients must replace their local replay first. */
export interface SessionCtlPtyGapEvent {
  version: number;
  kind: "event";
  event: "pty_gap";
  offset: number;
}

export type SessionCtlHistoryEvent =
  | SessionCtlHistoryDeltaEvent
  | SessionCtlHistoryWipeEvent
  | SessionCtlHistoryGapEvent;

export type SessionCtlTextMessage =
  | SessionCtlResponse
  | SessionCtlDisplayEvent
  | SessionCtlReadyEvent
  | SessionCtlHistoryEvent
  | SessionCtlPtyGapEvent;

export interface SessionCtlChunk {
  requestId: string;
  sequence: number;
  last: boolean;
  payload: Uint8Array;
}

export interface SessionCtlUploadStart {
  capability: string;
  sessionGeneration: number;
  uploadId: string;
  name: string;
  mimeType: string;
  destination: "attachments" | "cwd";
  totalBytes: number;
  chunks: number;
  sha256: string;
}

export interface SessionCtlUploadResult {
  uploadId: string;
  path: string;
  totalBytes: number;
  sha256: string;
}

export class DirectSessionUploadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DirectSessionUploadError";
    this.code = code;
  }
}

export interface AnchoredPtySlice {
  bytes: Uint8Array | null;
  anchor: number | null;
}

/** SCTP message boundaries are not PTY boundaries. Keep every browser send
 * comfortably below the peer's negotiated/default maximum. */
export function sessionPtyInputChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += SESSION_PTY_INPUT_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, offset + SESSION_PTY_INPUT_CHUNK_BYTES));
  }
  return chunks;
}

/** Send as many ordered chunks as the channel can currently accept. The
 * returned byte offset lets the caller queue the exact unsent remainder. */
export function writeSessionPtyInput(channel: RTCDataChannel, bytes: Uint8Array): number {
  let offset = 0;
  for (const chunk of sessionPtyInputChunks(bytes)) {
    if (
      channel.readyState !== "open" ||
      channel.bufferedAmount > SESSION_PTY_INPUT_BUFFER_HIGH_WATER
    ) {
      break;
    }
    try {
      channel.send(
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
      );
    } catch {
      break;
    }
    offset += chunk.byteLength;
  }
  return offset;
}

export type SessionCtlTrackedResult =
  | { kind: "response"; response: SessionCtlResponse }
  | { kind: "replay"; response: SessionCtlResponse; bytes: Uint8Array };

type PendingSessionCtlRequest = {
  operation: SessionCtlOperation;
  metadata: SessionCtlResponse | null;
  chunks: Map<number, Uint8Array>;
};

/**
 * Correlates replies with requests actually emitted by this RTC generation.
 * Unknown, duplicate, cross-operation, and structurally impossible replies
 * are ignored instead of consuming browser memory.
 */
export class SessionCtlRequestTracker {
  readonly #pending = new Map<string, PendingSessionCtlRequest>();
  #bufferedBytes = 0;

  get size(): number {
    return this.#pending.size;
  }

  register(requestId: string, operation: SessionCtlOperation): boolean {
    if (
      !isSessionCtlRequestId(requestId) ||
      this.#pending.has(requestId) ||
      this.#pending.size >= SESSION_CTL_MAX_OUTSTANDING_REQUESTS
    ) {
      return false;
    }
    this.#pending.set(requestId, { operation, metadata: null, chunks: new Map() });
    return true;
  }

  cancel(requestId: string): void {
    this.#remove(requestId);
  }

  clear(): void {
    this.#pending.clear();
    this.#bufferedBytes = 0;
  }

  acceptResponse(response: SessionCtlResponse): SessionCtlTrackedResult | null {
    const requestId = response.request_id;
    if (typeof requestId !== "string" || !isSessionCtlRequestId(requestId)) return null;
    const pending = this.#pending.get(requestId);
    if (!pending) return null;

    if (!response.ok) {
      this.#remove(requestId);
      // Error responses omit `operation`; graft the pending one on so the
      // consumer can route the failure without its own request-id ledger.
      return { kind: "response", response: { ...response, operation: pending.operation } };
    }
    if (response.operation !== pending.operation || pending.metadata) return null;
    if (pending.operation !== "history" && pending.operation !== "snapshot") {
      this.#remove(requestId);
      return { kind: "response", response };
    }

    const totalBytes = response.total_bytes;
    const chunks = response.chunks;
    const ptyOffset = response.pty_offset;
    if (
      typeof totalBytes !== "number" ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 0 ||
      totalBytes > SESSION_CTL_MAX_REPLAY_BYTES ||
      typeof chunks !== "number" ||
      !Number.isSafeInteger(chunks) ||
      chunks < 0 ||
      chunks > SESSION_CTL_MAX_REPLAY_CHUNKS ||
      chunks !== Math.ceil(totalBytes / SESSION_CTL_CHUNK_PAYLOAD_BYTES) ||
      typeof response.plain !== "boolean" ||
      (ptyOffset !== null &&
        ptyOffset !== undefined &&
        (typeof ptyOffset !== "number" || !Number.isSafeInteger(ptyOffset) || ptyOffset < 0))
    ) {
      return null;
    }
    pending.metadata = response;
    if (chunks !== 0) return null;
    this.#remove(requestId);
    return { kind: "replay", response, bytes: new Uint8Array() };
  }

  acceptChunk(chunk: SessionCtlChunk): SessionCtlTrackedResult | null {
    const pending = this.#pending.get(chunk.requestId);
    const metadata = pending?.metadata;
    if (!pending || !metadata || pending.chunks.has(chunk.sequence)) return null;
    const expectedChunks = metadata.chunks;
    const expectedBytes = metadata.total_bytes;
    if (
      typeof expectedChunks !== "number" ||
      typeof expectedBytes !== "number" ||
      chunk.sequence >= expectedChunks
    ) {
      return null;
    }
    const finalSequence = expectedChunks - 1;
    const expectedPayloadBytes =
      chunk.sequence === finalSequence
        ? expectedBytes - SESSION_CTL_CHUNK_PAYLOAD_BYTES * finalSequence
        : SESSION_CTL_CHUNK_PAYLOAD_BYTES;
    if (
      chunk.last !== (chunk.sequence === finalSequence) ||
      chunk.payload.byteLength !== expectedPayloadBytes ||
      this.#bufferedBytes + chunk.payload.byteLength > SESSION_CTL_MAX_REPLAY_BYTES
    ) {
      return null;
    }
    pending.chunks.set(chunk.sequence, chunk.payload);
    this.#bufferedBytes += chunk.payload.byteLength;
    if (pending.chunks.size !== expectedChunks) return null;

    const bytes = combineSessionCtlChunks(pending.chunks, expectedChunks, expectedBytes);
    if (!bytes) return null;
    this.#remove(chunk.requestId);
    return { kind: "replay", response: metadata, bytes };
  }

  #remove(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    for (const bytes of pending.chunks.values()) this.#bufferedBytes -= bytes.byteLength;
    this.#pending.delete(requestId);
  }
}

/** Serializes asynchronous decodes so ordered DataChannel messages stay ordered. */
export class OrderedAsyncQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue<T>(
    decode: () => T | Promise<T>,
    deliver: (value: T) => void | Promise<void>,
  ): Promise<void> {
    const completion = this.#tail.then(async () => deliver(await decode()));
    this.#tail = completion.catch(() => {});
    return this.#tail;
  }
}

/** Bounded input held for one committed session-effect generation only. */
export class SessionGenerationInputQueue {
  readonly #entries: Array<{ generation: number; bytes: Uint8Array; enqueuedAt: number }> = [];
  #bytes = 0;

  constructor(readonly maxBytes: number) {}

  enqueue(generation: number, bytes: Uint8Array, enqueuedAt = Date.now()): boolean {
    if (this.#bytes + bytes.byteLength > this.maxBytes) return false;
    const copy = bytes.slice();
    this.#entries.push({ generation, bytes: copy, enqueuedAt });
    this.#bytes += copy.byteLength;
    return true;
  }

  drain(generation: number, maxAgeMs = Number.POSITIVE_INFINITY, now = Date.now()): Uint8Array[] {
    return this.take(generation, maxAgeMs, now).map((entry) => entry.bytes);
  }

  take(
    generation: number,
    maxAgeMs = Number.POSITIVE_INFINITY,
    now = Date.now(),
  ): Array<{ bytes: Uint8Array; enqueuedAt: number }> {
    const matching = this.#entries
      .filter((entry) => entry.generation === generation && now - entry.enqueuedAt <= maxAgeMs)
      .map((entry) => ({ bytes: entry.bytes, enqueuedAt: entry.enqueuedAt }));
    this.clear();
    return matching;
  }

  prune(generation: number, maxAgeMs: number, now = Date.now()): void {
    let write = 0;
    let bytes = 0;
    for (const entry of this.#entries) {
      if (entry.generation !== generation || now - entry.enqueuedAt > maxAgeMs) continue;
      this.#entries[write] = entry;
      write += 1;
      bytes += entry.bytes.byteLength;
    }
    this.#entries.length = write;
    this.#bytes = bytes;
  }

  count(generation: number): number {
    return this.#entries.filter((entry) => entry.generation === generation).length;
  }

  bytes(generation: number): number {
    return this.#entries
      .filter((entry) => entry.generation === generation)
      .reduce((total, entry) => total + entry.bytes.byteLength, 0);
  }

  oldestEnqueuedAt(generation: number): number | null {
    return this.#entries.find((entry) => entry.generation === generation)?.enqueuedAt ?? null;
  }

  clear(): void {
    this.#entries.splice(0);
    this.#bytes = 0;
  }
}

/**
 * Remove bytes already represented by a replay snapshot. The anchor may be
 * ahead of what this DataChannel has delivered because spawn.ctl and
 * spawn.pty have no shared arrival order; callers keep the returned anchor
 * until the PTY stream reaches it.
 */
export function slicePtyChunkAfterAnchor(
  bytes: Uint8Array,
  offsetAfter: number,
  anchor: number | null,
): AnchoredPtySlice {
  if (anchor === null) return { bytes, anchor: null };
  if (offsetAfter <= anchor) {
    return { bytes: null, anchor: offsetAfter === anchor ? null : anchor };
  }
  const start = offsetAfter - bytes.byteLength;
  return {
    bytes: start < anchor ? bytes.subarray(anchor - start) : bytes,
    anchor: null,
  };
}

export function makeSessionCtlRequest(
  requestId: string,
  operation: SessionCtlOperation,
  parameters: Record<string, unknown> = {},
): string | null {
  if (!isSessionCtlRequestId(requestId)) return null;
  try {
    const text = JSON.stringify({
      ...parameters,
      version: SESSION_CTL_VERSION,
      kind: "request",
      request_id: requestId,
      operation,
    });
    return new TextEncoder().encode(text).byteLength <= SESSION_CTL_MAX_REQUEST_BYTES ? text : null;
  } catch {
    return null;
  }
}

export function makeSessionCtlUploadStart(start: SessionCtlUploadStart): string | null {
  if (
    !isSessionCtlRequestId(start.capability) ||
    !isSessionCtlRequestId(start.uploadId) ||
    !Number.isSafeInteger(start.sessionGeneration) ||
    start.sessionGeneration <= 0 ||
    !Number.isSafeInteger(start.totalBytes) ||
    start.totalBytes <= 0 ||
    start.totalBytes > SESSION_CTL_MAX_UPLOAD_BYTES ||
    start.chunks !== Math.ceil(start.totalBytes / SESSION_CTL_UPLOAD_CHUNK_BYTES) ||
    start.name.length === 0 ||
    new TextEncoder().encode(start.name).byteLength > 255 ||
    start.name === "." ||
    start.name === ".." ||
    Array.from(start.name).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    }) ||
    start.name.includes("/") ||
    start.name.includes("\\") ||
    (start.destination !== "attachments" && start.destination !== "cwd") ||
    start.mimeType.length === 0 ||
    new TextEncoder().encode(start.mimeType).byteLength > 128 ||
    !/^[!-~]+$/.test(start.mimeType) ||
    start.mimeType.includes(";") ||
    !/^[0-9a-f]{64}$/.test(start.sha256)
  ) {
    return null;
  }
  return makeSessionCtlRequest(start.uploadId, "upload_start", {
    capability: start.capability,
    agent_generation: start.sessionGeneration,
    name: start.name,
    mime_type: start.mimeType,
    destination: start.destination,
    total_bytes: start.totalBytes,
    chunks: start.chunks,
    sha256: start.sha256,
  });
}

export function makeSessionCtlUploadCancel(
  requestId: string,
  uploadId: string,
  capability: string,
  sessionGeneration: number,
): string | null {
  if (
    !isSessionCtlRequestId(uploadId) ||
    !isSessionCtlRequestId(capability) ||
    !Number.isSafeInteger(sessionGeneration) ||
    sessionGeneration <= 0
  ) {
    return null;
  }
  return makeSessionCtlRequest(requestId, "upload_cancel", {
    capability,
    agent_generation: sessionGeneration,
    upload_id: uploadId,
  });
}

export function encodeSessionCtlUploadChunk(
  uploadId: string,
  sequence: number,
  last: boolean,
  payload: Uint8Array,
): Uint8Array | null {
  if (
    !isSessionCtlRequestId(uploadId) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > 0xffff_ffff ||
    payload.byteLength === 0 ||
    payload.byteLength > SESSION_CTL_UPLOAD_CHUNK_BYTES
  ) {
    return null;
  }
  const requestBytes = uuidToBytes(uploadId);
  if (!requestBytes) return null;
  const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  frame.set(CHUNK_MAGIC);
  frame[4] = SESSION_CTL_VERSION;
  frame[5] = 2;
  const view = new DataView(frame.buffer);
  view.setUint16(6, last ? 1 : 0, true);
  frame.set(requestBytes, 8);
  view.setUint32(24, sequence, true);
  frame.set(payload, CHUNK_HEADER_BYTES);
  return frame;
}

export function parseSessionCtlUploadResponse(
  response: SessionCtlResponse,
  expected: SessionCtlUploadStart,
):
  | { kind: "ready"; nextSequence: number; receivedBytes: number }
  | { kind: "complete"; result: SessionCtlUploadResult }
  | { kind: "error"; code: string; message: string }
  | null {
  if (response.request_id !== expected.uploadId) return null;
  if (!response.ok) {
    return {
      kind: "error",
      code: response.error?.code || "upload_failed",
      message: response.error?.detail || "Upload failed.",
    };
  }
  if (
    response.operation === "upload_start" &&
    response.state === "ready" &&
    Number.isSafeInteger(response.next_sequence) &&
    Number.isSafeInteger(response.received_bytes) &&
    (response.next_sequence as number) >= 0 &&
    (response.next_sequence as number) <= expected.chunks &&
    (response.received_bytes as number) >= 0 &&
    (response.received_bytes as number) <= expected.totalBytes &&
    (response.received_bytes as number) ===
      Math.min(
        (response.next_sequence as number) * SESSION_CTL_UPLOAD_CHUNK_BYTES,
        expected.totalBytes,
      )
  ) {
    return {
      kind: "ready",
      nextSequence: response.next_sequence as number,
      receivedBytes: response.received_bytes as number,
    };
  }
  if (
    response.operation === "upload_complete" &&
    response.state === "complete" &&
    typeof response.path === "string" &&
    response.path.length > 0 &&
    new TextEncoder().encode(response.path).byteLength <= 4096 &&
    response.total_bytes === expected.totalBytes &&
    response.sha256 === expected.sha256
  ) {
    return {
      kind: "complete",
      result: {
        uploadId: expected.uploadId,
        path: response.path,
        totalBytes: expected.totalBytes,
        sha256: expected.sha256,
      },
    };
  }
  return null;
}

export async function sha256Blob(blob: Blob, checkpoint?: () => void): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  if (blob.size <= 0 || blob.size > SESSION_CTL_MAX_UPLOAD_BYTES) return null;
  let buffer: ArrayBuffer | null = null;
  try {
    try {
      buffer = await blob.arrayBuffer();
    } catch {
      return null;
    }
    checkpoint?.();
    let digest: ArrayBuffer;
    try {
      digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    } catch {
      return null;
    }
    checkpoint?.();
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } finally {
    if (buffer) new Uint8Array(buffer).fill(0);
  }
}

export function parseSessionCtlText(raw: string): SessionCtlTextMessage | null {
  if (new TextEncoder().encode(raw).byteLength > SESSION_CTL_MAX_REQUEST_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== SESSION_CTL_VERSION) return null;
    if (
      value.kind === "response" &&
      typeof value.ok === "boolean" &&
      (value.request_id === null ||
        value.request_id === undefined ||
        (typeof value.request_id === "string" && isSessionCtlRequestId(value.request_id))) &&
      (value.operation === undefined || isSessionCtlOperation(value.operation))
    ) {
      return value as unknown as SessionCtlResponse;
    }
    if (
      value.kind === "event" &&
      value.event === "ready" &&
      typeof value.upload_capability === "string" &&
      isSessionCtlRequestId(value.upload_capability) &&
      Number.isSafeInteger(value.agent_generation) &&
      (value.agent_generation as number) > 0 &&
      value.upload_max_bytes === SESSION_CTL_MAX_UPLOAD_BYTES &&
      value.upload_chunk_bytes === SESSION_CTL_UPLOAD_CHUNK_BYTES
    ) {
      return value as unknown as SessionCtlReadyEvent;
    }
    const validEpoch =
      typeof value.history_epoch === "string" && /^\d{1,20}$/.test(value.history_epoch);
    if (value.kind === "event" && value.event === "history_delta") {
      if (
        !validEpoch ||
        !Number.isSafeInteger(value.history_offset) ||
        (value.history_offset as number) < 0 ||
        typeof value.data !== "string"
      ) {
        return null;
      }
      return value as unknown as SessionCtlHistoryDeltaEvent;
    }
    if (value.kind === "event" && value.event === "history_wipe") {
      return validEpoch ? (value as unknown as SessionCtlHistoryWipeEvent) : null;
    }
    if (value.kind === "event" && value.event === "history_gap") {
      return value as unknown as SessionCtlHistoryGapEvent;
    }
    if (
      value.kind === "event" &&
      value.event === "pty_gap" &&
      Number.isSafeInteger(value.offset) &&
      (value.offset as number) >= 0
    ) {
      return value as unknown as SessionCtlPtyGapEvent;
    }
    if (
      value.kind === "event" &&
      value.event === "display_state" &&
      typeof value.owner === "boolean" &&
      Number.isSafeInteger(value.viewers) &&
      (value.viewers as number) >= 1 &&
      (value.cols === null ||
        (Number.isSafeInteger(value.cols) &&
          (value.cols as number) >= 20 &&
          (value.cols as number) <= 400)) &&
      (value.rows === null ||
        (Number.isSafeInteger(value.rows) &&
          (value.rows as number) >= 5 &&
          (value.rows as number) <= 200)) &&
      (value.cols === null) === (value.rows === null)
    ) {
      return value as unknown as SessionCtlDisplayEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function isSessionCtlRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function newSessionCtlRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    const requestId = crypto.randomUUID();
    if (isSessionCtlRequestId(requestId)) return requestId;
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes) ?? "00000000-0000-4000-8000-000000000000";
}

export function decodeSessionCtlChunk(bytes: Uint8Array): SessionCtlChunk | null {
  if (
    bytes.byteLength < CHUNK_HEADER_BYTES ||
    bytes.byteLength > CHUNK_HEADER_BYTES + SESSION_CTL_CHUNK_PAYLOAD_BYTES
  ) {
    return null;
  }
  for (let index = 0; index < CHUNK_MAGIC.length; index += 1) {
    if (bytes[index] !== CHUNK_MAGIC[index]) return null;
  }
  if (bytes[4] !== SESSION_CTL_VERSION || bytes[5] !== 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint16(6, true);
  if ((flags & ~1) !== 0) return null;
  const requestId = bytesToUuid(bytes.subarray(8, 24));
  if (!requestId) return null;
  return {
    requestId,
    sequence: view.getUint32(24, true),
    last: (flags & 1) !== 0,
    payload: bytes.slice(CHUNK_HEADER_BYTES),
  };
}

export function combineSessionCtlChunks(
  chunks: Map<number, Uint8Array>,
  expectedChunks: number,
  expectedBytes: number,
): Uint8Array | null {
  if (
    !Number.isSafeInteger(expectedChunks) ||
    expectedChunks < 0 ||
    expectedChunks > SESSION_CTL_MAX_REPLAY_CHUNKS ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > SESSION_CTL_MAX_REPLAY_BYTES ||
    chunks.size !== expectedChunks
  ) {
    return null;
  }
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  for (let sequence = 0; sequence < expectedChunks; sequence += 1) {
    const chunk = chunks.get(sequence);
    if (!chunk || offset + chunk.byteLength > output.byteLength) return null;
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return offset === output.byteLength ? output : null;
}

function bytesToUuid(bytes: Uint8Array): string | null {
  if (bytes.byteLength !== 16) return null;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function uuidToBytes(value: string): Uint8Array | null {
  if (!isSessionCtlRequestId(value)) return null;
  const hex = value.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function isSessionCtlOperation(value: unknown): value is SessionCtlOperation {
  return (
    value === "history" ||
    value === "snapshot" ||
    value === "resize" ||
    value === "scroll" ||
    value === "redraw" ||
    value === "take_control" ||
    value === "upload_start" ||
    value === "upload_cancel" ||
    value === "upload_complete" ||
    value === "history_subscribe"
  );
}
