export const AGENT_CTL_VERSION = 1;
export const AGENT_CTL_MAX_REQUEST_BYTES = 16 * 1024;
export const AGENT_CTL_MAX_REPLAY_BYTES = 12 * 1024 * 1024;
export const AGENT_CTL_MAX_PENDING_PTY_BYTES = 12 * 1024 * 1024;
export const AGENT_CTL_CHUNK_PAYLOAD_BYTES = 48 * 1024;
export const AGENT_CTL_MAX_REPLAY_CHUNKS = Math.ceil(
  AGENT_CTL_MAX_REPLAY_BYTES / AGENT_CTL_CHUNK_PAYLOAD_BYTES,
);
export const AGENT_CTL_MAX_OUTSTANDING_REQUESTS = 128;
export const AGENT_CTL_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const AGENT_CTL_UPLOAD_CHUNK_BYTES = 48 * 1024;
export const AGENT_CTL_UPLOAD_BUFFER_HIGH_WATER = 256 * 1024;
export const AGENT_CTL_UPLOAD_BUFFER_LOW_WATER = 128 * 1024;

const CHUNK_HEADER_BYTES = 28;
const CHUNK_MAGIC = [0x53, 0x50, 0x43, 0x54]; // SPCT

export type AgentCtlOperation =
  | "history"
  | "snapshot"
  | "resize"
  | "scroll"
  | "redraw"
  | "take_control"
  | "upload_start"
  | "upload_cancel"
  | "upload_complete";

export interface AgentCtlResponse {
  version: number;
  kind: "response";
  request_id?: string | null;
  operation?: AgentCtlOperation;
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
}

export interface AgentCtlDisplayEvent {
  version: number;
  kind: "event";
  event: "display_state";
  owner: boolean;
  cols: number | null;
  rows: number | null;
  viewers: number;
}

export interface AgentCtlReadyEvent {
  version: number;
  kind: "event";
  event: "ready";
  upload_capability: string;
  agent_generation: number;
  upload_max_bytes: number;
  upload_chunk_bytes: number;
}

export type AgentCtlTextMessage = AgentCtlResponse | AgentCtlDisplayEvent | AgentCtlReadyEvent;

export interface AgentCtlChunk {
  requestId: string;
  sequence: number;
  last: boolean;
  payload: Uint8Array;
}

export interface AgentCtlUploadStart {
  capability: string;
  agentGeneration: number;
  uploadId: string;
  name: string;
  mimeType: string;
  destination: "attachments" | "cwd";
  totalBytes: number;
  chunks: number;
  sha256: string;
}

export interface AgentCtlUploadResult {
  uploadId: string;
  path: string;
  totalBytes: number;
  sha256: string;
}

export interface AnchoredPtySlice {
  bytes: Uint8Array | null;
  anchor: number | null;
}

export type AgentCtlTrackedResult =
  | { kind: "response"; response: AgentCtlResponse }
  | { kind: "replay"; response: AgentCtlResponse; bytes: Uint8Array };

type PendingAgentCtlRequest = {
  operation: AgentCtlOperation;
  metadata: AgentCtlResponse | null;
  chunks: Map<number, Uint8Array>;
};

/**
 * Correlates replies with requests actually emitted by this RTC generation.
 * Unknown, duplicate, cross-operation, and structurally impossible replies
 * are ignored instead of consuming browser memory.
 */
export class AgentCtlRequestTracker {
  readonly #pending = new Map<string, PendingAgentCtlRequest>();
  #bufferedBytes = 0;

  get size(): number {
    return this.#pending.size;
  }

  register(requestId: string, operation: AgentCtlOperation): boolean {
    if (
      !isAgentCtlRequestId(requestId) ||
      this.#pending.has(requestId) ||
      this.#pending.size >= AGENT_CTL_MAX_OUTSTANDING_REQUESTS
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

  acceptResponse(response: AgentCtlResponse): AgentCtlTrackedResult | null {
    const requestId = response.request_id;
    if (typeof requestId !== "string" || !isAgentCtlRequestId(requestId)) return null;
    const pending = this.#pending.get(requestId);
    if (!pending) return null;

    if (!response.ok) {
      this.#remove(requestId);
      return { kind: "response", response };
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
      totalBytes > AGENT_CTL_MAX_REPLAY_BYTES ||
      typeof chunks !== "number" ||
      !Number.isSafeInteger(chunks) ||
      chunks < 0 ||
      chunks > AGENT_CTL_MAX_REPLAY_CHUNKS ||
      chunks !== Math.ceil(totalBytes / AGENT_CTL_CHUNK_PAYLOAD_BYTES) ||
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

  acceptChunk(chunk: AgentCtlChunk): AgentCtlTrackedResult | null {
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
        ? expectedBytes - AGENT_CTL_CHUNK_PAYLOAD_BYTES * finalSequence
        : AGENT_CTL_CHUNK_PAYLOAD_BYTES;
    if (
      chunk.last !== (chunk.sequence === finalSequence) ||
      chunk.payload.byteLength !== expectedPayloadBytes ||
      this.#bufferedBytes + chunk.payload.byteLength > AGENT_CTL_MAX_REPLAY_BYTES
    ) {
      return null;
    }
    pending.chunks.set(chunk.sequence, chunk.payload);
    this.#bufferedBytes += chunk.payload.byteLength;
    if (pending.chunks.size !== expectedChunks) return null;

    const bytes = combineAgentCtlChunks(pending.chunks, expectedChunks, expectedBytes);
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

/** Bounded input held for one committed agent-effect generation only. */
export class AgentGenerationInputQueue {
  readonly #entries: Array<{ generation: number; bytes: Uint8Array }> = [];
  #bytes = 0;

  constructor(readonly maxBytes: number) {}

  enqueue(generation: number, bytes: Uint8Array): boolean {
    if (this.#bytes + bytes.byteLength > this.maxBytes) return false;
    const copy = bytes.slice();
    this.#entries.push({ generation, bytes: copy });
    this.#bytes += copy.byteLength;
    return true;
  }

  drain(generation: number): Uint8Array[] {
    const matching = this.#entries
      .filter((entry) => entry.generation === generation)
      .map((entry) => entry.bytes);
    this.clear();
    return matching;
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

export function makeAgentCtlRequest(
  requestId: string,
  operation: AgentCtlOperation,
  parameters: Record<string, unknown> = {},
): string | null {
  if (!isAgentCtlRequestId(requestId)) return null;
  try {
    const text = JSON.stringify({
      ...parameters,
      version: AGENT_CTL_VERSION,
      kind: "request",
      request_id: requestId,
      operation,
    });
    return new TextEncoder().encode(text).byteLength <= AGENT_CTL_MAX_REQUEST_BYTES ? text : null;
  } catch {
    return null;
  }
}

export function makeAgentCtlUploadStart(start: AgentCtlUploadStart): string | null {
  if (
    !isAgentCtlRequestId(start.capability) ||
    !isAgentCtlRequestId(start.uploadId) ||
    !Number.isSafeInteger(start.agentGeneration) ||
    start.agentGeneration <= 0 ||
    !Number.isSafeInteger(start.totalBytes) ||
    start.totalBytes <= 0 ||
    start.totalBytes > AGENT_CTL_MAX_UPLOAD_BYTES ||
    start.chunks !== Math.ceil(start.totalBytes / AGENT_CTL_UPLOAD_CHUNK_BYTES) ||
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
  return makeAgentCtlRequest(start.uploadId, "upload_start", {
    capability: start.capability,
    agent_generation: start.agentGeneration,
    name: start.name,
    mime_type: start.mimeType,
    destination: start.destination,
    total_bytes: start.totalBytes,
    chunks: start.chunks,
    sha256: start.sha256,
  });
}

export function makeAgentCtlUploadCancel(
  requestId: string,
  uploadId: string,
  capability: string,
  agentGeneration: number,
): string | null {
  if (
    !isAgentCtlRequestId(uploadId) ||
    !isAgentCtlRequestId(capability) ||
    !Number.isSafeInteger(agentGeneration) ||
    agentGeneration <= 0
  ) {
    return null;
  }
  return makeAgentCtlRequest(requestId, "upload_cancel", {
    capability,
    agent_generation: agentGeneration,
    upload_id: uploadId,
  });
}

export function encodeAgentCtlUploadChunk(
  uploadId: string,
  sequence: number,
  last: boolean,
  payload: Uint8Array,
): Uint8Array | null {
  if (
    !isAgentCtlRequestId(uploadId) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > 0xffff_ffff ||
    payload.byteLength === 0 ||
    payload.byteLength > AGENT_CTL_UPLOAD_CHUNK_BYTES
  ) {
    return null;
  }
  const requestBytes = uuidToBytes(uploadId);
  if (!requestBytes) return null;
  const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  frame.set(CHUNK_MAGIC);
  frame[4] = AGENT_CTL_VERSION;
  frame[5] = 2;
  const view = new DataView(frame.buffer);
  view.setUint16(6, last ? 1 : 0, true);
  frame.set(requestBytes, 8);
  view.setUint32(24, sequence, true);
  frame.set(payload, CHUNK_HEADER_BYTES);
  return frame;
}

export function parseAgentCtlUploadResponse(
  response: AgentCtlResponse,
  expected: AgentCtlUploadStart,
):
  | { kind: "ready"; nextSequence: number; receivedBytes: number }
  | { kind: "complete"; result: AgentCtlUploadResult }
  | { kind: "error"; message: string }
  | null {
  if (response.request_id !== expected.uploadId) return null;
  if (!response.ok) {
    return { kind: "error", message: response.error?.detail || "Upload failed." };
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
        (response.next_sequence as number) * AGENT_CTL_UPLOAD_CHUNK_BYTES,
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

export async function sha256Blob(blob: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  if (blob.size <= 0 || blob.size > AGENT_CTL_MAX_UPLOAD_BYTES) return null;
  let buffer: ArrayBuffer | null = null;
  try {
    buffer = await blob.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return null;
  } finally {
    if (buffer) new Uint8Array(buffer).fill(0);
  }
}

export function parseAgentCtlText(raw: string): AgentCtlTextMessage | null {
  if (new TextEncoder().encode(raw).byteLength > AGENT_CTL_MAX_REQUEST_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== AGENT_CTL_VERSION) return null;
    if (
      value.kind === "response" &&
      typeof value.ok === "boolean" &&
      (value.request_id === null ||
        value.request_id === undefined ||
        (typeof value.request_id === "string" && isAgentCtlRequestId(value.request_id))) &&
      (value.operation === undefined || isAgentCtlOperation(value.operation))
    ) {
      return value as unknown as AgentCtlResponse;
    }
    if (
      value.kind === "event" &&
      value.event === "ready" &&
      typeof value.upload_capability === "string" &&
      isAgentCtlRequestId(value.upload_capability) &&
      Number.isSafeInteger(value.agent_generation) &&
      (value.agent_generation as number) > 0 &&
      value.upload_max_bytes === AGENT_CTL_MAX_UPLOAD_BYTES &&
      value.upload_chunk_bytes === AGENT_CTL_UPLOAD_CHUNK_BYTES
    ) {
      return value as unknown as AgentCtlReadyEvent;
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
      return value as unknown as AgentCtlDisplayEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function isAgentCtlRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function newAgentCtlRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    const requestId = crypto.randomUUID();
    if (isAgentCtlRequestId(requestId)) return requestId;
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

export function decodeAgentCtlChunk(bytes: Uint8Array): AgentCtlChunk | null {
  if (
    bytes.byteLength < CHUNK_HEADER_BYTES ||
    bytes.byteLength > CHUNK_HEADER_BYTES + AGENT_CTL_CHUNK_PAYLOAD_BYTES
  ) {
    return null;
  }
  for (let index = 0; index < CHUNK_MAGIC.length; index += 1) {
    if (bytes[index] !== CHUNK_MAGIC[index]) return null;
  }
  if (bytes[4] !== AGENT_CTL_VERSION || bytes[5] !== 1) return null;
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

export function combineAgentCtlChunks(
  chunks: Map<number, Uint8Array>,
  expectedChunks: number,
  expectedBytes: number,
): Uint8Array | null {
  if (
    !Number.isSafeInteger(expectedChunks) ||
    expectedChunks < 0 ||
    expectedChunks > AGENT_CTL_MAX_REPLAY_CHUNKS ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > AGENT_CTL_MAX_REPLAY_BYTES ||
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
  if (!isAgentCtlRequestId(value)) return null;
  const hex = value.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function isAgentCtlOperation(value: unknown): value is AgentCtlOperation {
  return (
    value === "history" ||
    value === "snapshot" ||
    value === "resize" ||
    value === "scroll" ||
    value === "redraw" ||
    value === "take_control" ||
    value === "upload_start" ||
    value === "upload_cancel" ||
    value === "upload_complete"
  );
}
