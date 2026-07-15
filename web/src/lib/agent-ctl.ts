export const AGENT_CTL_VERSION = 1;
export const AGENT_CTL_MAX_REQUEST_BYTES = 16 * 1024;
export const AGENT_CTL_MAX_REPLAY_BYTES = 12 * 1024 * 1024;
export const AGENT_CTL_MAX_PENDING_PTY_BYTES = 12 * 1024 * 1024;
export const AGENT_CTL_CHUNK_PAYLOAD_BYTES = 48 * 1024;
export const AGENT_CTL_MAX_REPLAY_CHUNKS = Math.ceil(
  AGENT_CTL_MAX_REPLAY_BYTES / AGENT_CTL_CHUNK_PAYLOAD_BYTES,
);

const CHUNK_HEADER_BYTES = 28;
const CHUNK_MAGIC = [0x53, 0x50, 0x43, 0x54]; // SPCT

export type AgentCtlOperation =
  | "history"
  | "snapshot"
  | "resize"
  | "scroll"
  | "redraw"
  | "take_control";

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

export type AgentCtlTextMessage = AgentCtlResponse | AgentCtlDisplayEvent;

export interface AgentCtlChunk {
  requestId: string;
  sequence: number;
  last: boolean;
  payload: Uint8Array;
}

export interface AnchoredPtySlice {
  bytes: Uint8Array | null;
  anchor: number | null;
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
  const text = JSON.stringify({
    version: AGENT_CTL_VERSION,
    kind: "request",
    request_id: requestId,
    operation,
    ...parameters,
  });
  return new TextEncoder().encode(text).byteLength <= AGENT_CTL_MAX_REQUEST_BYTES ? text : null;
}

export function parseAgentCtlText(raw: string): AgentCtlTextMessage | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== AGENT_CTL_VERSION) return null;
    if (value.kind === "response" && typeof value.ok === "boolean") {
      return value as unknown as AgentCtlResponse;
    }
    if (
      value.kind === "event" &&
      value.event === "display_state" &&
      typeof value.owner === "boolean" &&
      typeof value.viewers === "number"
    ) {
      return value as unknown as AgentCtlDisplayEvent;
    }
    return null;
  } catch {
    return null;
  }
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
    expectedChunks < 0 ||
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
