/**
 * TEST/INTEROP ONLY. This structural signer adapter is deliberately outside
 * `src/` and must never be imported by production code or a Next.js route.
 * Production signing uses the exact WeakMap-registered epoch capability in
 * `src/lib/signed-signal-wire.ts`.
 */
import {
  ED25519_PUBLIC_KEY_BYTES,
  encodeBase64Url,
  exportEd25519PublicKeyWire,
  importEd25519PublicKeyWire,
  type SignalKind,
  SignedSignalError,
  type SignedSignalTranscript,
  verifySignedSignalTranscript,
} from "../src/lib/signed-signal";
import {
  MAX_SIGNED_RTC_WIRE_CHARS,
  type RtcSignalProtocol,
  SIGNED_RTC_SIGNATURE_ALGORITHM,
  type SignedRtcSignalInput,
  SignedRtcWireError,
} from "../src/lib/signed-signal-wire";

export interface TestOnlySignedRtcIdentitySigner {
  readonly publicKeyWire: string;
  sign(transcript: SignedSignalTranscript): Promise<string>;
}

interface TestOnlySignedRtcEnvelope {
  type: "rtc.offer" | "rtc.answer";
  signature_algorithm: typeof SIGNED_RTC_SIGNATURE_ALGORITHM;
  sender_identity_public_key: string;
  intended_peer_identity_public_key: string;
  protocol: RtcSignalProtocol;
  protocol_version: number;
  session_id: string;
  scope_type: SignedSignalTranscript["scopeType"];
  scope_id: string;
  sender_role: SignedSignalTranscript["senderRole"];
  sdp: string;
  signature: string;
}

/** Produce golden vectors without creating a production-capable raw signer API. */
export async function signRtcSignalWireForTestOnly(
  signer: TestOnlySignedRtcIdentitySigner,
  input: SignedRtcSignalInput,
): Promise<string> {
  const transcript = copyTranscript(input.transcript);
  validateTuple(input.protocol, transcript);
  const senderPublicKey = await importEd25519PublicKeyWire(signer.publicKeyWire);
  const senderPublicKeyWire = await exportEd25519PublicKeyWire(senderPublicKey);
  const intendedPeerWire = encodeKey(transcript.intendedPeerPublicKey);
  await importEd25519PublicKeyWire(intendedPeerWire);
  const signature = await signer.sign(copyTranscript(transcript));
  if (!(await verifySignedSignalTranscript(senderPublicKey, transcript, signature))) {
    throw new SignedRtcWireError(
      "signature_mismatch",
      "test-only signer did not produce a signature for its public key",
    );
  }
  const envelope: TestOnlySignedRtcEnvelope = {
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
  return wire;
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
