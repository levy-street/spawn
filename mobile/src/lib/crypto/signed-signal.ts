import {
  concatBytes,
  decodeBase64UrlExact,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
  equalBytes,
  parseCanonicalUuid,
} from "@/lib/crypto/bytes";
import {
  assertStrictEd25519PublicKey,
  signPureEd25519,
  verifyPureEd25519Strict,
} from "@/lib/crypto/ed25519";

const MAGIC = encodeUtf8("SPAWN-RTC-SIGNAL-SIG-V1");
const REVISION = 2;
const MAX_SDP_BYTES = 1_048_576;
const ENVELOPE_KEYS = [
  "intended_peer_identity_public_key",
  "protocol",
  "protocol_version",
  "scope_id",
  "scope_type",
  "sdp",
  "sender_identity_public_key",
  "sender_role",
  "session_id",
  "signature",
  "signature_algorithm",
  "type",
] as const;

export type SignalKind = "offer" | "answer";
export type SignalScopeType = "session" | "host";
export type SignalSenderRole = "browser" | "daemon";

export interface SignalTranscript {
  signalKind: SignalKind;
  protocolVersion: number;
  sessionId: string;
  scopeType: SignalScopeType;
  scopeId: string;
  senderRole: SignalSenderRole;
  intendedPeerPublicKey: string;
  sdp: string;
}

export interface SignedSignalEnvelope {
  type: "rtc.offer" | "rtc.answer";
  signature_algorithm: "ed25519";
  sender_identity_public_key: string;
  intended_peer_identity_public_key: string;
  protocol: "spawn.pty" | "spawn.host.ctl";
  protocol_version: number;
  session_id: string;
  scope_type: SignalScopeType;
  scope_id: string;
  sender_role: SignalSenderRole;
  sdp: string;
  signature: string;
}

function enumCode<T extends string>(value: T, values: readonly T[], label: string): number {
  const index = values.indexOf(value);
  if (index < 0) throw new Error(`Unknown ${label}`);
  return index + 1;
}

function u16(value: number): Uint8Array {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, false);
  return output;
}

function u32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function checkedText(value: string, label: string, maximum: number): Uint8Array {
  const bytes = encodeUtf8(value);
  if (bytes.length < 1 || bytes.length > maximum) {
    throw new RangeError(`${label} must contain 1 through ${maximum} UTF-8 bytes`);
  }
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL`);
  return bytes;
}

export function encodeSignedSignalV2(input: SignalTranscript): Uint8Array {
  if (
    !Number.isInteger(input.protocolVersion) ||
    input.protocolVersion < 1 ||
    input.protocolVersion > 0xffffffff
  ) {
    throw new RangeError("Protocol version must be a non-zero uint32");
  }
  const sessionId = encodeUtf8(parseCanonicalUuid(input.sessionId));
  const scopeId = encodeUtf8(parseCanonicalUuid(input.scopeId));
  const intendedPeer = decodeBase64UrlExact(input.intendedPeerPublicKey, 32);
  assertStrictEd25519PublicKey(intendedPeer);
  const sdp = checkedText(input.sdp, "SDP", MAX_SDP_BYTES);
  return concatBytes(
    MAGIC,
    Uint8Array.of(REVISION),
    Uint8Array.of(enumCode(input.signalKind, ["offer", "answer"], "signal kind")),
    u32(input.protocolVersion),
    u16(sessionId.length),
    sessionId,
    Uint8Array.of(enumCode(input.scopeType, ["session", "host"], "scope type")),
    u16(scopeId.length),
    scopeId,
    Uint8Array.of(enumCode(input.senderRole, ["browser", "daemon"], "sender role")),
    intendedPeer,
    u32(sdp.length),
    sdp,
  );
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error("Signed-signal transcript is truncated");
    }
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  byte(): number {
    return this.take(1)[0] ?? 0;
  }

  uint16(): number {
    const bytes = this.take(2);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, false);
  }

  uint32(): number {
    const bytes = this.take(4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  }

  finish(): void {
    if (this.offset !== this.bytes.length)
      throw new Error("Signed-signal transcript has trailing bytes");
  }
}

function enumValue<T extends string>(code: number, values: readonly T[], label: string): T {
  const value = values[code - 1];
  if (value === undefined) throw new Error(`Unknown ${label} code`);
  return value;
}

export function decodeSignedSignalV2(bytes: Uint8Array): SignalTranscript {
  const reader = new Reader(bytes);
  if (!equalBytes(reader.take(MAGIC.length), MAGIC)) throw new Error("Wrong signed-signal magic");
  if (reader.byte() !== REVISION) throw new Error("Only signed-signal revision 2 is accepted");
  const signalKind = enumValue(reader.byte(), ["offer", "answer"], "signal kind");
  const protocolVersion = reader.uint32();
  if (protocolVersion === 0) throw new Error("Protocol version must be non-zero");
  const sessionId = parseCanonicalUuid(decodeUtf8(reader.take(reader.uint16())));
  const scopeType = enumValue(reader.byte(), ["session", "host"], "scope type");
  const scopeId = parseCanonicalUuid(decodeUtf8(reader.take(reader.uint16())));
  const senderRole = enumValue(reader.byte(), ["browser", "daemon"], "sender role");
  const intendedPeer = reader.take(32);
  assertStrictEd25519PublicKey(intendedPeer);
  const sdpBytes = reader.take(reader.uint32());
  if (sdpBytes.length < 1 || sdpBytes.length > MAX_SDP_BYTES) throw new Error("Invalid SDP length");
  const sdp = decodeUtf8(sdpBytes);
  if (sdp.includes("\0")) throw new Error("SDP must not contain NUL");
  reader.finish();
  return {
    signalKind,
    protocolVersion,
    sessionId,
    scopeType,
    scopeId,
    senderRole,
    intendedPeerPublicKey: encodeBase64Url(intendedPeer),
    sdp,
  };
}

export function signSignedSignalV2(seed: Uint8Array, input: SignalTranscript): Uint8Array {
  return signPureEd25519(seed, encodeSignedSignalV2(input));
}

export function verifySignedSignalV2(
  publicKey: Uint8Array,
  input: SignalTranscript,
  signature: Uint8Array,
): boolean {
  return verifyPureEd25519Strict(publicKey, encodeSignedSignalV2(input), signature);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${label} must be an integer`);
  return value;
}

function assertEnvelopeTopology(envelope: SignedSignalEnvelope): void {
  const expectedRole = envelope.type === "rtc.offer" ? "browser" : "daemon";
  if (envelope.sender_role !== expectedRole)
    throw new Error("Signal kind and sender role do not match");
  if (envelope.protocol === "spawn.pty") {
    if (envelope.protocol_version !== 2 || envelope.scope_type !== "session") {
      throw new Error("spawn.pty requires session scope and protocol version 2");
    }
  } else if (envelope.protocol_version !== 1 || envelope.scope_type !== "host") {
    throw new Error("spawn.host.ctl requires host scope and protocol version 1");
  }
}

export function parseSignedSignalEnvelope(value: unknown): SignedSignalEnvelope {
  if (!isRecord(value)) throw new Error("Signed-signal envelope must be an object");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== ENVELOPE_KEYS.length ||
    keys.some((key, index) => key !== ENVELOPE_KEYS[index])
  ) {
    throw new Error("Signed-signal envelope fields must match the exact schema");
  }
  const type = requireString(value["type"], "type");
  const signatureAlgorithm = requireString(value["signature_algorithm"], "signature_algorithm");
  const protocol = requireString(value["protocol"], "protocol");
  const scopeType = requireString(value["scope_type"], "scope_type");
  const senderRole = requireString(value["sender_role"], "sender_role");
  if (type !== "rtc.offer" && type !== "rtc.answer") throw new Error("Unknown signal type");
  if (signatureAlgorithm !== "ed25519") throw new Error("Unknown signature algorithm");
  if (protocol !== "spawn.pty" && protocol !== "spawn.host.ctl")
    throw new Error("Unknown protocol");
  if (scopeType !== "session" && scopeType !== "host") throw new Error("Unknown scope type");
  if (senderRole !== "browser" && senderRole !== "daemon") throw new Error("Unknown sender role");
  const envelope: SignedSignalEnvelope = {
    type,
    signature_algorithm: signatureAlgorithm,
    sender_identity_public_key: requireString(value["sender_identity_public_key"], "sender key"),
    intended_peer_identity_public_key: requireString(
      value["intended_peer_identity_public_key"],
      "peer key",
    ),
    protocol,
    protocol_version: requireInteger(value["protocol_version"], "protocol version"),
    session_id: parseCanonicalUuid(requireString(value["session_id"], "session ID")),
    scope_type: scopeType,
    scope_id: parseCanonicalUuid(requireString(value["scope_id"], "scope ID")),
    sender_role: senderRole,
    sdp: requireString(value["sdp"], "SDP"),
    signature: requireString(value["signature"], "signature"),
  };
  assertStrictEd25519PublicKey(decodeBase64UrlExact(envelope.sender_identity_public_key, 32));
  assertStrictEd25519PublicKey(
    decodeBase64UrlExact(envelope.intended_peer_identity_public_key, 32),
  );
  decodeBase64UrlExact(envelope.signature, 64);
  assertEnvelopeTopology(envelope);
  encodeSignedSignalV2(envelopeToTranscript(envelope));
  return envelope;
}

export function envelopeToTranscript(envelope: SignedSignalEnvelope): SignalTranscript {
  return {
    signalKind: envelope.type === "rtc.offer" ? "offer" : "answer",
    protocolVersion: envelope.protocol_version,
    sessionId: envelope.session_id,
    scopeType: envelope.scope_type,
    scopeId: envelope.scope_id,
    senderRole: envelope.sender_role,
    intendedPeerPublicKey: envelope.intended_peer_identity_public_key,
    sdp: envelope.sdp,
  };
}

export function serializeSignedSignalEnvelope(envelope: SignedSignalEnvelope): string {
  return JSON.stringify(parseSignedSignalEnvelope(envelope));
}

export function decodeSignedSignalEnvelope(value: string): SignedSignalEnvelope {
  return parseSignedSignalEnvelope(JSON.parse(value) as unknown);
}

export function verifySignedSignalEnvelope(
  value: unknown,
  trustedSenderPublicKey?: string,
): SignedSignalEnvelope {
  const envelope = parseSignedSignalEnvelope(value);
  if (
    trustedSenderPublicKey !== undefined &&
    envelope.sender_identity_public_key !== trustedSenderPublicKey
  ) {
    throw new Error("Signed-signal sender does not match the trusted key");
  }
  const publicKey = decodeBase64UrlExact(envelope.sender_identity_public_key, 32);
  const signature = decodeBase64UrlExact(envelope.signature, 64);
  if (!verifySignedSignalV2(publicKey, envelopeToTranscript(envelope), signature)) {
    throw new Error("Signed-signal signature is invalid");
  }
  return envelope;
}
