import {
  decodeBase64Url,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  importEd25519PublicKeyWire,
} from "./signed-signal";

const textEncoder = new TextEncoder();

export const HOST_PAIR_APPROVAL_MAGIC = textEncoder.encode("SPAWN-HOST-PAIR-APPROVE-V1");
export const HOST_PAIR_APPROVAL_VERSION = 1;
export const APPROVAL_NONCE_BYTES = 32;
export const HOST_PAIR_APPROVAL_TRANSCRIPT_BYTES =
  HOST_PAIR_APPROVAL_MAGIC.byteLength +
  1 +
  16 +
  APPROVAL_NONCE_BYTES +
  ED25519_PUBLIC_KEY_BYTES * 2;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuidBytes(userId: string): Uint8Array {
  if (!UUID_PATTERN.test(userId)) throw new Error("user id must be a canonical lowercase UUID");
  const hex = userId.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export function encodeHostPairApprovalTranscript(
  userId: string,
  approvalNonceWire: string,
  hostPublicKeyWire: string,
  browserPublicKeyWire: string,
): Uint8Array {
  const nonce = decodeBase64Url(approvalNonceWire, APPROVAL_NONCE_BYTES);
  const hostPublicKey = decodeBase64Url(hostPublicKeyWire, ED25519_PUBLIC_KEY_BYTES);
  const browserPublicKey = decodeBase64Url(browserPublicKeyWire, ED25519_PUBLIC_KEY_BYTES);
  const output = new Uint8Array(HOST_PAIR_APPROVAL_TRANSCRIPT_BYTES);
  let offset = 0;
  for (const field of [
    HOST_PAIR_APPROVAL_MAGIC,
    Uint8Array.of(HOST_PAIR_APPROVAL_VERSION),
    uuidBytes(userId),
    nonce,
    hostPublicKey,
    browserPublicKey,
  ]) {
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(value.byteLength);
  new Uint8Array(output).set(value);
  return output;
}

export async function verifyHostPairApprovalProof(
  userId: string,
  approvalNonceWire: string,
  hostPublicKeyWire: string,
  browserPublicKeyWire: string,
  signatureWire: string,
): Promise<boolean> {
  const key = await importEd25519PublicKeyWire(browserPublicKeyWire);
  const transcript = encodeHostPairApprovalTranscript(
    userId,
    approvalNonceWire,
    hostPublicKeyWire,
    browserPublicKeyWire,
  );
  const signature = decodeBase64Url(signatureWire, ED25519_SIGNATURE_BYTES);
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    ownedBuffer(signature),
    ownedBuffer(transcript),
  );
}
