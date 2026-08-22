import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deviceIdentity } from "@/lib/crypto/identity";
import { type SignalTranscript, verifySignedSignalEnvelope } from "@/lib/crypto/signed-signal";
import type { SignalTranscriptRequest, WorkerToNativeMessage } from "@/terminal/transport/bridge";

interface SignalRoute {
  scopeType: "session" | "host";
  scopeId: string;
  protocol: "spawn.pty" | "spawn.host.ctl";
  protocolVersion: 1 | 2;
}

interface SignalFrameRecord extends Record<string, unknown> {
  type?: unknown;
  session_id?: unknown;
  scope_type?: unknown;
  scope_id?: unknown;
  protocol?: unknown;
  protocol_version?: unknown;
  signed_envelope?: unknown;
}

function record(value: unknown): SignalFrameRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SignalFrameRecord)
    : null;
}

export async function browserIdentityWire(): Promise<string> {
  const identity = await deviceIdentity.ensure();
  return encodeBase64Url(identity.publicKey);
}

export async function signWorkerRequest(
  message: Extract<WorkerToNativeMessage, { type: "sign-request" }>,
): Promise<string> {
  const request: SignalTranscriptRequest = message.transcript;
  const transcript: SignalTranscript = {
    signalKind: request.signalKind,
    protocolVersion: request.protocolVersion,
    sessionId: request.sessionId,
    scopeType: request.scopeType,
    scopeId: request.scopeId,
    senderRole: request.senderRole,
    intendedPeerPublicKey: request.intendedPeerIdentityPublicKey,
    sdp: request.sdp,
  };
  return encodeBase64Url(await deviceIdentity.signSignalTranscript(transcript));
}

export function verifyAnswerFrame(
  value: unknown,
  trustedHostKey: string,
  browserKey: string,
  route: SignalRoute,
): unknown {
  const frame = record(value);
  if (frame?.type !== "rtc.answer") return value;
  if (typeof frame.signed_envelope !== "string") {
    throw new Error("RTC answer must contain a signed envelope.");
  }
  const envelope = verifySignedSignalEnvelope(
    JSON.parse(frame.signed_envelope) as unknown,
    trustedHostKey,
  );
  if (
    envelope.type !== "rtc.answer" ||
    envelope.intended_peer_identity_public_key !== browserKey ||
    envelope.session_id !== frame.session_id ||
    envelope.scope_type !== route.scopeType ||
    envelope.scope_id !== route.scopeId ||
    envelope.protocol !== route.protocol ||
    envelope.protocol_version !== route.protocolVersion
  ) {
    throw new Error("Signed RTC answer does not match the active route.");
  }
  return value;
}
