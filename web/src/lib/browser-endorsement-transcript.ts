/**
 * One browser device vouching for another, so a daemon can trust a device it
 * has never met without the operator running a terminal ceremony.
 *
 * Byte-identical to the daemon (`daemon/src/browser_endorsement.rs`) and server
 * (`spawn_server/browser_endorsement.py`) encoders; the cross-runtime gate
 * proves it. The daemon is the party that matters: it verifies this signature
 * against the browser keys it already pins, so the server can relay an
 * endorsement but never mint one.
 */

import {
  decodeEd25519PublicKeyWire,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  encodeBase64Url,
} from "./signed-signal";

const textEncoder = new TextEncoder();

export const BROWSER_ENDORSEMENT_MAGIC = textEncoder.encode("SPAWN-BROWSER-ENDORSE-V1");
export const BROWSER_ENDORSEMENT_VERSION = 1;
const UUID_BYTES = 16;

export const BROWSER_ENDORSEMENT_TRANSCRIPT_BYTES =
  BROWSER_ENDORSEMENT_MAGIC.byteLength + 1 + UUID_BYTES + ED25519_PUBLIC_KEY_BYTES * 3 + UUID_BYTES;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function uuidBytes(value: string, field: string): Uint8Array {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  const hex = value.replaceAll("-", "");
  return Uint8Array.from({ length: UUID_BYTES }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export function encodeBrowserEndorsementTranscript(
  userId: string,
  hostPublicKeyWire: string,
  endorserPublicKeyWire: string,
  endorsedPublicKeyWire: string,
  endorsedDeviceId: string,
): Uint8Array {
  const hostPublicKey = decodeEd25519PublicKeyWire(hostPublicKeyWire);
  const endorserPublicKey = decodeEd25519PublicKeyWire(endorserPublicKeyWire);
  const endorsedPublicKey = decodeEd25519PublicKeyWire(endorsedPublicKeyWire);
  if (encodeBase64Url(endorserPublicKey) === encodeBase64Url(endorsedPublicKey)) {
    // A device admitting itself is exactly the authority endorsement withholds.
    throw new Error("a device may not endorse itself");
  }

  const output = new Uint8Array(BROWSER_ENDORSEMENT_TRANSCRIPT_BYTES);
  let offset = 0;
  for (const field of [
    BROWSER_ENDORSEMENT_MAGIC,
    Uint8Array.of(BROWSER_ENDORSEMENT_VERSION),
    uuidBytes(userId, "account id"),
    hostPublicKey,
    endorserPublicKey,
    endorsedPublicKey,
    uuidBytes(endorsedDeviceId, "endorsed device id"),
  ]) {
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

export function endorsementSignatureToWire(signature: Uint8Array): string {
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new Error("endorsement signature has the wrong length");
  }
  return encodeBase64Url(signature);
}
