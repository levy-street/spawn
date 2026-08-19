/**
 * Account-scoped endorsement: one device vouching for another device's key for
 * the whole account, not for a single host.
 *
 * Byte-identical to the daemon (`daemon/src/acct_endorsement.rs`) and server
 * (`spawn_server/acct_endorsement.py`) encoders; the shared vector proves it.
 * This is the successor to `browser-endorsement-transcript.ts`: it drops the
 * host binding so a single endorsement is carried by the device and presented to
 * every host of the account (docs/TRUST_DEVICE_MESH.md §3, property P4). The
 * daemon is the party that matters — it verifies this signature against keys it
 * already trusts, so the server can relay an endorsement but never mint one.
 */

import {
  decodeEd25519PublicKeyWire,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  encodeBase64Url,
} from "./signed-signal";

const textEncoder = new TextEncoder();

export const ACCT_ENDORSEMENT_MAGIC = textEncoder.encode("SPAWN-ACCT-ENDORSE-V1");
export const ACCT_ENDORSEMENT_VERSION = 1;
const UUID_BYTES = 16;

export const ACCT_ENDORSEMENT_TRANSCRIPT_BYTES =
  ACCT_ENDORSEMENT_MAGIC.byteLength + 1 + UUID_BYTES + ED25519_PUBLIC_KEY_BYTES * 2 + UUID_BYTES;

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

export function encodeAcctEndorsementTranscript(
  accountId: string,
  endorserPublicKeyWire: string,
  endorsedPublicKeyWire: string,
  endorsedDeviceId: string,
): Uint8Array {
  const endorserPublicKey = decodeEd25519PublicKeyWire(endorserPublicKeyWire);
  const endorsedPublicKey = decodeEd25519PublicKeyWire(endorsedPublicKeyWire);
  if (encodeBase64Url(endorserPublicKey) === encodeBase64Url(endorsedPublicKey)) {
    // A device admitting itself is exactly the authority endorsement withholds.
    throw new Error("a device may not endorse itself");
  }

  const output = new Uint8Array(ACCT_ENDORSEMENT_TRANSCRIPT_BYTES);
  let offset = 0;
  for (const field of [
    ACCT_ENDORSEMENT_MAGIC,
    Uint8Array.of(ACCT_ENDORSEMENT_VERSION),
    uuidBytes(accountId, "account id"),
    endorserPublicKey,
    endorsedPublicKey,
    uuidBytes(endorsedDeviceId, "endorsed device id"),
  ]) {
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

export function acctEndorsementSignatureToWire(signature: Uint8Array): string {
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new Error("endorsement signature has the wrong length");
  }
  return encodeBase64Url(signature);
}
