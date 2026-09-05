export const SESSION_CTL_VERSION = 1;
export const SESSION_CTL_MAX_TEXT_BYTES = 16 * 1024;
export const SESSION_CTL_MAX_REPLAY_BYTES = 12 * 1024 * 1024;
export const SESSION_CTL_MAX_PENDING_PTY_BYTES = 12 * 1024 * 1024;
/** The largest chunk payload accepted, and the size of this client's own
 *  upload chunks. The daemon frames a replay as 16 KiB SCTP messages, 28 of
 *  them header (`proto/session-ctl-replay-framing-v1-vectors.json`); the
 *  size is learned from the first non-final chunk, never assumed. */
export const SESSION_CTL_CHUNK_PAYLOAD_BYTES = 48 * 1024;
/** A non-final replay chunk smaller than this is no framing the daemon
 *  produces; refusing it bounds how many chunks one replay may cost. */
export const SESSION_CTL_MIN_REPLAY_CHUNK_PAYLOAD_BYTES = 1024;
export const SESSION_CTL_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const SESSION_CTL_MAX_OUTSTANDING_REQUESTS = 128;
export const PTY_INPUT_MAX_BYTES = 64 * 1024;
export const PTY_INPUT_CHUNK_BYTES = 16 * 1024;
export const SPCT_HEADER_BYTES = 28;

const SPCT_MAGIC = new Uint8Array([0x53, 0x50, 0x43, 0x54]);

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
  version: 1;
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
  history_epoch?: string;
  history_offset?: number;
}

export interface SessionCtlReadyEvent {
  version: 1;
  kind: "event";
  event: "ready";
  upload_capability: string;
  agent_generation: number;
  upload_max_bytes: number;
  upload_chunk_bytes: number;
}

export interface SessionCtlDisplayEvent {
  version: 1;
  kind: "event";
  event: "display_state";
  owner: boolean;
  cols: number | null;
  rows: number | null;
  viewers: number;
}

export interface SessionCtlHistoryEvent {
  version: 1;
  kind: "event";
  event: "history_delta" | "history_wipe" | "history_gap" | "pty_gap";
  history_epoch?: string;
  history_offset?: number;
  data?: string;
  offset?: number;
}

export type SessionCtlTextMessage =
  | SessionCtlResponse
  | SessionCtlReadyEvent
  | SessionCtlDisplayEvent
  | SessionCtlHistoryEvent;

export interface SpctFrame {
  kind: "replay" | "upload";
  requestId: string;
  sequence: number;
  last: boolean;
  payload: Uint8Array;
}

export interface UploadStartParameters {
  capability: string;
  uploadId: string;
  sessionGeneration: number;
  name: string;
  mimeType: string;
  destination: "attachments" | "cwd";
  totalBytes: number;
  chunks: number;
  sha256: string;
}

export type ReplayAssemblyResult =
  | { kind: "pending" }
  | { kind: "complete"; response: SessionCtlResponse; bytes: Uint8Array }
  | { kind: "invalid"; reason: string };

export interface AnchoredPtySlice {
  bytes: Uint8Array | null;
  anchor: number | null;
}

interface ParsedCtlRecord extends Record<string, unknown> {
  version?: unknown;
  kind?: unknown;
  ok?: unknown;
  request_id?: unknown;
  event?: unknown;
  upload_capability?: unknown;
  agent_generation?: unknown;
  upload_max_bytes?: unknown;
  upload_chunk_bytes?: unknown;
  owner?: unknown;
  viewers?: unknown;
  cols?: unknown;
  rows?: unknown;
  history_epoch?: unknown;
  history_offset?: unknown;
  data?: unknown;
}

function isRecord(value: unknown): value is ParsedCtlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isControlId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function uuidToBytes(value: string): Uint8Array | null {
  if (!isControlId(value)) return null;
  const compact = value.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

export function bytesToUuid(bytes: Uint8Array): string | null {
  if (bytes.byteLength !== 16) return null;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeSpctFrame(frame: SpctFrame): Uint8Array | null {
  const requestId = uuidToBytes(frame.requestId);
  if (
    !requestId ||
    !Number.isSafeInteger(frame.sequence) ||
    frame.sequence < 0 ||
    frame.sequence > 0xffff_ffff ||
    frame.payload.byteLength === 0 ||
    frame.payload.byteLength > SESSION_CTL_CHUNK_PAYLOAD_BYTES
  ) {
    return null;
  }
  const output = new Uint8Array(SPCT_HEADER_BYTES + frame.payload.byteLength);
  output.set(SPCT_MAGIC, 0);
  output[4] = SESSION_CTL_VERSION;
  output[5] = frame.kind === "replay" ? 1 : 2;
  const view = new DataView(output.buffer);
  view.setUint16(6, frame.last ? 1 : 0, true);
  output.set(requestId, 8);
  view.setUint32(24, frame.sequence, true);
  output.set(frame.payload, SPCT_HEADER_BYTES);
  return output;
}

export function decodeSpctFrame(bytes: Uint8Array): SpctFrame | null {
  if (
    bytes.byteLength < SPCT_HEADER_BYTES ||
    bytes.byteLength > SPCT_HEADER_BYTES + SESSION_CTL_CHUNK_PAYLOAD_BYTES
  ) {
    return null;
  }
  for (let index = 0; index < SPCT_MAGIC.byteLength; index += 1) {
    if (bytes[index] !== SPCT_MAGIC[index]) return null;
  }
  if (bytes[4] !== SESSION_CTL_VERSION || (bytes[5] !== 1 && bytes[5] !== 2)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint16(6, true);
  const requestId = bytesToUuid(bytes.subarray(8, 24));
  if ((flags & ~1) !== 0 || !requestId) return null;
  return {
    kind: bytes[5] === 1 ? "replay" : "upload",
    requestId,
    sequence: view.getUint32(24, true),
    last: (flags & 1) !== 0,
    payload: bytes.slice(SPCT_HEADER_BYTES),
  };
}

export function makeSessionCtlRequest(
  requestId: string,
  operation: SessionCtlOperation,
  parameters: Record<string, unknown> = {},
): string | null {
  if (!isControlId(requestId)) return null;
  try {
    const text = JSON.stringify({
      ...parameters,
      version: SESSION_CTL_VERSION,
      kind: "request",
      request_id: requestId,
      operation,
    });
    return new TextEncoder().encode(text).byteLength <= SESSION_CTL_MAX_TEXT_BYTES ? text : null;
  } catch {
    return null;
  }
}

export function makeUploadStart(start: UploadStartParameters): string | null {
  const nameBytes = new TextEncoder().encode(start.name).byteLength;
  const mimeBytes = new TextEncoder().encode(start.mimeType).byteLength;
  const invalidName = Array.from(start.name).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
  if (
    !isControlId(start.capability) ||
    !isControlId(start.uploadId) ||
    !Number.isSafeInteger(start.sessionGeneration) ||
    start.sessionGeneration <= 0 ||
    !Number.isSafeInteger(start.totalBytes) ||
    start.totalBytes <= 0 ||
    start.totalBytes > SESSION_CTL_MAX_UPLOAD_BYTES ||
    start.chunks !== Math.ceil(start.totalBytes / SESSION_CTL_CHUNK_PAYLOAD_BYTES) ||
    nameBytes < 1 ||
    nameBytes > 255 ||
    start.name === "." ||
    start.name === ".." ||
    invalidName ||
    start.name.includes("/") ||
    start.name.includes("\\") ||
    (start.destination !== "attachments" && start.destination !== "cwd") ||
    mimeBytes < 1 ||
    mimeBytes > 128 ||
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

export function parseSessionCtlText(raw: string): SessionCtlTextMessage | null {
  if (new TextEncoder().encode(raw).byteLength > SESSION_CTL_MAX_TEXT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== SESSION_CTL_VERSION) return null;
    if (value.kind === "response" && typeof value.ok === "boolean") {
      if (
        value.request_id !== undefined &&
        value.request_id !== null &&
        (typeof value.request_id !== "string" || !isControlId(value.request_id))
      ) {
        return null;
      }
      return value as unknown as SessionCtlResponse;
    }
    if (value.kind !== "event" || typeof value.event !== "string") return null;
    if (
      value.event === "ready" &&
      typeof value.upload_capability === "string" &&
      isControlId(value.upload_capability) &&
      Number.isSafeInteger(value.agent_generation) &&
      (value.agent_generation as number) > 0 &&
      value.upload_max_bytes === SESSION_CTL_MAX_UPLOAD_BYTES &&
      value.upload_chunk_bytes === SESSION_CTL_CHUNK_PAYLOAD_BYTES
    ) {
      return value as unknown as SessionCtlReadyEvent;
    }
    if (
      value.event === "display_state" &&
      typeof value.owner === "boolean" &&
      Number.isSafeInteger(value.viewers) &&
      (value.viewers as number) >= 1 &&
      validGrid(value.cols, 20, 400) &&
      validGrid(value.rows, 5, 200) &&
      (value.cols === null) === (value.rows === null)
    ) {
      return value as unknown as SessionCtlDisplayEvent;
    }
    if (value.event === "history_gap") return value as unknown as SessionCtlHistoryEvent;
    const validEpoch =
      typeof value.history_epoch === "string" && /^\d{1,20}$/.test(value.history_epoch);
    if (value.event === "history_wipe" && validEpoch) {
      return value as unknown as SessionCtlHistoryEvent;
    }
    if (
      value.event === "history_delta" &&
      validEpoch &&
      Number.isSafeInteger(value.history_offset) &&
      (value.history_offset as number) >= 0 &&
      typeof value.data === "string"
    ) {
      return value as unknown as SessionCtlHistoryEvent;
    }
    return null;
  } catch {
    return null;
  }
}

function validGrid(value: unknown, min: number, max: number): boolean {
  return (
    value === null ||
    (Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max)
  );
}

export function chunkPtyInput(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += PTY_INPUT_CHUNK_BYTES) {
    chunks.push(bytes.slice(offset, offset + PTY_INPUT_CHUNK_BYTES));
  }
  return chunks;
}

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
  return { bytes: start < anchor ? bytes.subarray(anchor - start) : bytes, anchor: null };
}

/**
 * Whether `chunks` can carry `totalBytes` under some chunk size in the
 * accepted range: every non-final chunk between the minimum and the ceiling,
 * the final one at least a byte. The header cannot pin the exact size; the
 * first non-final chunk does.
 */
export function replayChunkCountIsPlausible(totalBytes: number, chunks: number): boolean {
  if (chunks === 0) return totalBytes === 0;
  if (totalBytes === 0) return false;
  if (chunks === 1) return totalBytes <= SESSION_CTL_CHUNK_PAYLOAD_BYTES;
  return (
    (chunks - 1) * SESSION_CTL_MIN_REPLAY_CHUNK_PAYLOAD_BYTES < totalBytes &&
    totalBytes <= chunks * SESSION_CTL_CHUNK_PAYLOAD_BYTES
  );
}

export class ReplayAssembler {
  readonly #chunks = new Map<number, Uint8Array>();
  readonly #response: SessionCtlResponse;
  #bufferedBytes = 0;
  /** Learned from the first non-final chunk; every later one must match. */
  #chunkPayloadBytes: number | null = null;

  constructor(response: SessionCtlResponse) {
    this.#response = response;
  }

  accept(frame: SpctFrame): ReplayAssemblyResult {
    const totalBytes = this.#response.total_bytes;
    const expectedChunks = this.#response.chunks;
    if (
      frame.kind !== "replay" ||
      frame.requestId !== this.#response.request_id ||
      typeof totalBytes !== "number" ||
      typeof expectedChunks !== "number" ||
      totalBytes < 0 ||
      totalBytes > SESSION_CTL_MAX_REPLAY_BYTES ||
      !replayChunkCountIsPlausible(totalBytes, expectedChunks) ||
      frame.sequence >= expectedChunks ||
      this.#chunks.has(frame.sequence)
    ) {
      return { kind: "invalid", reason: "Replay metadata or sequence mismatch." };
    }
    const finalSequence = expectedChunks - 1;
    const isFinal = frame.sequence === finalSequence;
    const length = frame.payload.byteLength;
    if (frame.last !== isFinal || length === 0 || length > SESSION_CTL_CHUNK_PAYLOAD_BYTES) {
      return { kind: "invalid", reason: "Replay chunk flag or length is out of range." };
    }
    if (isFinal) {
      const expected =
        this.#chunkPayloadBytes === null
          ? expectedChunks === 1
            ? totalBytes
            : null
          : totalBytes - this.#chunkPayloadBytes * finalSequence;
      if (expected !== null && length !== expected) {
        return { kind: "invalid", reason: "Final replay chunk does not complete the total." };
      }
    } else if (this.#chunkPayloadBytes === null) {
      // The first non-final chunk fixes the framing for the rest; the
      // daemon's size is never assumed, only required to carry the total.
      if (
        length < SESSION_CTL_MIN_REPLAY_CHUNK_PAYLOAD_BYTES ||
        length * finalSequence >= totalBytes ||
        length * expectedChunks < totalBytes
      ) {
        return { kind: "invalid", reason: "Replay chunk size cannot carry the total." };
      }
      const held = this.#chunks.get(finalSequence);
      if (held && held.byteLength !== totalBytes - length * finalSequence) {
        return { kind: "invalid", reason: "Final replay chunk does not complete the total." };
      }
      this.#chunkPayloadBytes = length;
    } else if (length !== this.#chunkPayloadBytes) {
      return { kind: "invalid", reason: "Replay chunks are not one size." };
    }
    this.#bufferedBytes += length;
    if (this.#bufferedBytes > SESSION_CTL_MAX_REPLAY_BYTES) {
      return { kind: "invalid", reason: "Replay exceeds the aggregate byte limit." };
    }
    this.#chunks.set(frame.sequence, frame.payload);
    if (this.#chunks.size !== expectedChunks) return { kind: "pending" };
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (let sequence = 0; sequence < expectedChunks; sequence += 1) {
      const chunk = this.#chunks.get(sequence);
      if (!chunk || offset + chunk.byteLength > totalBytes) {
        return { kind: "invalid", reason: "Replay has a missing or oversized chunk." };
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return offset === totalBytes
      ? { kind: "complete", response: this.#response, bytes }
      : { kind: "invalid", reason: "Replay byte count mismatch." };
  }
}
