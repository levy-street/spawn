import {
  assertBrowserDeviceIdentitySignerActive,
  type EpochScopedBrowserDeviceIdentity,
  signBrowserDeviceRtcTranscriptWithinTrustEpoch,
} from "./browser-device-identity";
import {
  decodeBase64Url,
  ED25519_PUBLIC_KEY_BYTES,
  encodeBase64Url,
  exportEd25519PublicKeyWire,
  importEd25519PublicKeyWire,
  MAX_SCOPE_ID_BYTES,
  MAX_SDP_BYTES,
  MAX_SESSION_ID_BYTES,
  type ScopeType,
  type SenderRole,
  type SignalKind,
  SignedSignalError,
  type SignedSignalTranscript,
  verifySignedSignalTranscript,
} from "./signed-signal";

export const SIGNED_RTC_SIGNATURE_ALGORITHM = "ed25519";
export const MAX_SIGNED_RTC_WIRE_CHARS =
  6 * (MAX_SESSION_ID_BYTES + MAX_SCOPE_ID_BYTES + MAX_SDP_BYTES) + 2048;

export type RtcSignalProtocol = "spawn.pty" | "spawn.host.ctl";

export interface SignedRtcSignalInput {
  protocol: RtcSignalProtocol;
  transcript: SignedSignalTranscript;
}

export interface VerifiedRtcSignal {
  readonly protocol: RtcSignalProtocol;
  readonly senderPublicKey: CryptoKey;
  readonly senderPublicKeyWire: string;
  readonly transcript: SignedSignalTranscript;
}

export class SignedRtcWireError extends Error {
  constructor(
    readonly code:
      | "inconsistent_tuple"
      | "invalid_enum"
      | "invalid_json"
      | "invalid_shape"
      | "peer_pin_mismatch"
      | "sender_pin_mismatch"
      | "signature_mismatch"
      | "unsupported_algorithm"
      | "wire_too_large",
    message: string,
  ) {
    super(message);
    this.name = "SignedRtcWireError";
  }
}

interface SignedRtcEnvelope {
  type: "rtc.offer" | "rtc.answer";
  signature_algorithm: typeof SIGNED_RTC_SIGNATURE_ALGORITHM;
  sender_identity_public_key: string;
  intended_peer_identity_public_key: string;
  protocol: RtcSignalProtocol;
  protocol_version: number;
  session_id: string;
  scope_type: ScopeType;
  scope_id: string;
  sender_role: SenderRole;
  sdp: string;
  signature: string;
}

const envelopeFields = [
  "type",
  "signature_algorithm",
  "sender_identity_public_key",
  "intended_peer_identity_public_key",
  "protocol",
  "protocol_version",
  "session_id",
  "scope_type",
  "scope_id",
  "sender_role",
  "sdp",
  "signature",
] as const;

export async function signRtcSignalWire(
  signer: EpochScopedBrowserDeviceIdentity,
  input: SignedRtcSignalInput,
): Promise<string> {
  // This check intentionally precedes every field access or validation. A raw
  // identity, structural copy, wrapper, proxy, or rebound signing method is
  // not the exact epoch capability and must never reach the signing boundary.
  assertBrowserDeviceIdentitySignerActive(signer);
  const transcript = copyTranscript(input.transcript);
  validateTuple(input.protocol, transcript);
  const senderPublicKey = await importEd25519PublicKeyWire(signer.publicKeyWire);
  const senderPublicKeyWire = await exportEd25519PublicKeyWire(senderPublicKey);
  const intendedPeerWire = encodeKey(transcript.intendedPeerPublicKey);
  // Re-import so signing cannot emit an invalid or weak intended-peer key.
  await importEd25519PublicKeyWire(intendedPeerWire);
  const signature = await signBrowserDeviceRtcTranscriptWithinTrustEpoch(
    signer,
    copyTranscript(transcript),
  );
  assertBrowserDeviceIdentitySignerActive(signer);
  // The accepted browser identity intentionally exposes no signer or private
  // CryptoKey. This proof binds its public view to the private exact-object
  // capability and fails closed if a caller combines identity halves.
  const signatureVerified = await verifySignedSignalTranscript(
    senderPublicKey,
    transcript,
    signature,
  );
  assertBrowserDeviceIdentitySignerActive(signer);
  if (!signatureVerified) {
    throw new SignedRtcWireError(
      "signature_mismatch",
      "identity signer did not produce a signature for its public key",
    );
  }
  const envelope: SignedRtcEnvelope = {
    type: signalType(transcript.signalKind),
    signature_algorithm: SIGNED_RTC_SIGNATURE_ALGORITHM,
    sender_identity_public_key: senderPublicKeyWire,
    intended_peer_identity_public_key: intendedPeerWire,
    protocol: input.protocol,
    protocol_version: transcript.protocolVersion,
    session_id: transcript.sessionId,
    scope_type: transcript.scopeType,
    scope_id: transcript.scopeId,
    sender_role: transcript.senderRole,
    sdp: transcript.sdp,
    signature,
  };
  const wire = JSON.stringify(envelope);
  if (wire.length > MAX_SIGNED_RTC_WIRE_CHARS) {
    throw new SignedRtcWireError("wire_too_large", "signed RTC envelope exceeds its wire bound");
  }
  assertBrowserDeviceIdentitySignerActive(signer);
  return wire;
}

export async function verifyRtcSignalWire(
  wire: string,
  expectedSenderPublicKeyWire: string,
  expectedIntendedPeerPublicKeyWire: string,
): Promise<VerifiedRtcSignal> {
  if (typeof wire !== "string" || wire.length > MAX_SIGNED_RTC_WIRE_CHARS) {
    throw new SignedRtcWireError("wire_too_large", "signed RTC envelope exceeds its wire bound");
  }
  rejectDuplicateTopLevelKeys(wire);
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire);
  } catch {
    throw new SignedRtcWireError("invalid_json", "invalid signed RTC envelope JSON");
  }
  const envelope = parseEnvelope(parsed);
  const senderPublicKey = await importEd25519PublicKeyWire(envelope.sender_identity_public_key);
  const intendedPeerPublicKey = await importEd25519PublicKeyWire(
    envelope.intended_peer_identity_public_key,
  );
  const expectedSender = await importEd25519PublicKeyWire(expectedSenderPublicKeyWire);
  const expectedIntendedPeer = await importEd25519PublicKeyWire(expectedIntendedPeerPublicKeyWire);
  const canonicalSenderWire = await exportEd25519PublicKeyWire(senderPublicKey);
  const canonicalPeerWire = await exportEd25519PublicKeyWire(intendedPeerPublicKey);
  if (canonicalSenderWire !== (await exportEd25519PublicKeyWire(expectedSender))) {
    throw new SignedRtcWireError(
      "sender_pin_mismatch",
      "sender identity public key does not match the expected pin",
    );
  }
  if (canonicalPeerWire !== (await exportEd25519PublicKeyWire(expectedIntendedPeer))) {
    throw new SignedRtcWireError(
      "peer_pin_mismatch",
      "intended peer identity public key does not match the expected pin",
    );
  }
  const transcript: SignedSignalTranscript = {
    signalKind: parseSignalType(envelope.type),
    protocolVersion: envelope.protocol_version,
    sessionId: envelope.session_id,
    scopeType: envelope.scope_type,
    scopeId: envelope.scope_id,
    senderRole: envelope.sender_role,
    intendedPeerPublicKey: decodeBase64Url(canonicalPeerWire, ED25519_PUBLIC_KEY_BYTES),
    sdp: envelope.sdp,
  };
  validateTuple(envelope.protocol, transcript);
  if (!(await verifySignedSignalTranscript(senderPublicKey, transcript, envelope.signature))) {
    throw new SignedRtcWireError("signature_mismatch", "invalid signed RTC envelope signature");
  }
  return {
    protocol: envelope.protocol,
    senderPublicKey,
    senderPublicKeyWire: canonicalSenderWire,
    transcript,
  };
}

function parseEnvelope(value: unknown): SignedRtcEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SignedRtcWireError("invalid_shape", "signed RTC envelope must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...envelopeFields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new SignedRtcWireError("invalid_shape", "signed RTC envelope fields are not exact");
  }
  for (const field of envelopeFields) {
    if (field === "protocol_version") continue;
    if (typeof record[field] !== "string") {
      throw new SignedRtcWireError("invalid_shape", `${field} must be a string`);
    }
  }
  if (
    !Number.isSafeInteger(record.protocol_version) ||
    (record.protocol_version as number) < 1 ||
    (record.protocol_version as number) > 0xffff_ffff
  ) {
    throw new SignedRtcWireError(
      "invalid_shape",
      "protocol_version must be an integer in 1..=2^32-1",
    );
  }
  if (record.signature_algorithm !== SIGNED_RTC_SIGNATURE_ALGORITHM) {
    throw new SignedRtcWireError("unsupported_algorithm", "unsupported signature algorithm");
  }
  if (record.type !== "rtc.offer" && record.type !== "rtc.answer") {
    throw new SignedRtcWireError("invalid_enum", "invalid type");
  }
  if (record.scope_type !== "agent" && record.scope_type !== "host") {
    throw new SignedRtcWireError("invalid_enum", "invalid scope_type");
  }
  if (record.sender_role !== "browser" && record.sender_role !== "daemon") {
    throw new SignedRtcWireError("invalid_enum", "invalid sender_role");
  }
  if (record.protocol !== "spawn.pty" && record.protocol !== "spawn.host.ctl") {
    throw new SignedRtcWireError("invalid_enum", "invalid protocol");
  }
  return record as unknown as SignedRtcEnvelope;
}

function validateTuple(protocol: RtcSignalProtocol, transcript: SignedSignalTranscript): void {
  if (protocol !== "spawn.pty" && protocol !== "spawn.host.ctl") {
    throw new SignedRtcWireError("invalid_enum", "invalid protocol");
  }
  const protocolMatchesScope =
    (protocol === "spawn.pty" && transcript.scopeType === "agent") ||
    (protocol === "spawn.host.ctl" && transcript.scopeType === "host");
  if (!protocolMatchesScope) {
    throw new SignedRtcWireError("inconsistent_tuple", "protocol does not match scope_type");
  }
  const exactVersion = protocol === "spawn.pty" ? 2 : 1;
  if (transcript.protocolVersion !== exactVersion) {
    throw new SignedRtcWireError(
      "inconsistent_tuple",
      "protocol_version does not match the current protocol",
    );
  }
  if (
    !(
      (transcript.signalKind === "offer" && transcript.senderRole === "browser") ||
      (transcript.signalKind === "answer" && transcript.senderRole === "daemon")
    )
  ) {
    throw new SignedRtcWireError(
      "inconsistent_tuple",
      "rtc.offer must be browser-signed and rtc.answer must be daemon-signed",
    );
  }
}

function signalType(kind: SignalKind): "rtc.offer" | "rtc.answer" {
  if (kind === "offer") return "rtc.offer";
  if (kind === "answer") return "rtc.answer";
  throw new SignedRtcWireError("invalid_enum", "invalid signalKind");
}

function parseSignalType(type: "rtc.offer" | "rtc.answer"): SignalKind {
  return type === "rtc.offer" ? "offer" : "answer";
}

function encodeKey(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new SignedSignalError("invalid_length", "intendedPeerPublicKey must contain 32 bytes");
  }
  return encodeBase64Url(value);
}

function copyTranscript(value: SignedSignalTranscript): SignedSignalTranscript {
  return {
    signalKind: value.signalKind,
    protocolVersion: value.protocolVersion,
    sessionId: value.sessionId,
    scopeType: value.scopeType,
    scopeId: value.scopeId,
    senderRole: value.senderRole,
    intendedPeerPublicKey: value.intendedPeerPublicKey.slice(),
    sdp: value.sdp,
  };
}

/** JSON.parse discards duplicate names. Reject them before parsing so two
 * consumers cannot authenticate different interpretations of one envelope. */
function rejectDuplicateTopLevelKeys(wire: string): void {
  const seen = new Set<string>();
  let depth = 0;
  let index = 0;
  while (index < wire.length) {
    const character = wire[index];
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < wire.length) {
        const current = wire[index++];
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === '"') {
          break;
        }
      }
      let next = index;
      while (/\s/u.test(wire[next] ?? "")) next += 1;
      if (depth === 1 && wire[next] === ":") {
        let key: unknown;
        try {
          key = JSON.parse(wire.slice(start, index));
        } catch {
          throw new SignedRtcWireError("invalid_json", "invalid signed RTC envelope JSON");
        }
        if (typeof key !== "string" || seen.has(key)) {
          throw new SignedRtcWireError("invalid_shape", "duplicate signed RTC envelope field");
        }
        seen.add(key);
      }
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    index += 1;
  }
}
