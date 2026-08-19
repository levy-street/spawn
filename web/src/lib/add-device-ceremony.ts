/**
 * Committed-ephemeral SAS helpers for the browser↔browser add-device ceremony
 * (docs/TRUST_DEVICE_MESH.md §4). Thin, wire-aware wrappers over the shipped
 * `sas` primitive that fix the role convention and base64url decoding in one
 * place, so both sides of the ceremony and its tests agree.
 *
 * Role convention: the INITIATOR (the existing device, which commits first) takes
 * the daemon's "host" position; the JOINER (the new device) takes the "browser"
 * position. With that mapping the primitive is reused unchanged — the number both
 * humans compare is `sas(K_initiator, K_joiner, N_initiator, N_joiner)`.
 */

import { b64urlDecode, b64urlEncode, commit, FIELD_BYTES, sas, verifyCommit } from "./sas";

export const SAS_NONCE_BYTES = FIELD_BYTES;

/** A fresh 32-byte ephemeral nonce for one ceremony contribution. */
export function freshSasNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SAS_NONCE_BYTES));
}

/** `Cd = SHA256(tag ‖ publicKey ‖ nonce)` as base64url, hiding `nonce` until the
 * committer chooses to reveal it. */
export async function commitWire(publicKeyWire: string, nonce: Uint8Array): Promise<string> {
  return b64urlEncode(await commit(b64urlDecode(publicKeyWire), nonce));
}

/** Whether a revealed nonce opens the initiator's commitment. The joiner MUST
 * check this before trusting the number — a relay that reveals a mismatched
 * nonce is a substitution attempt. */
export async function verifyCommitWire(
  commitmentWire: string,
  publicKeyWire: string,
  nonceWire: string,
): Promise<boolean> {
  return verifyCommit(
    b64urlDecode(commitmentWire),
    b64urlDecode(publicKeyWire),
    b64urlDecode(nonceWire),
  );
}

/** The 6-digit number both devices display, `"NNN NNN"`. Initiator in the host
 * position, joiner in the browser position. */
export async function ceremonySas(
  initiatorKeyWire: string,
  joinerKeyWire: string,
  initiatorNonceWire: string,
  joinerNonceWire: string,
): Promise<string> {
  return sas(
    b64urlDecode(initiatorKeyWire),
    b64urlDecode(joinerKeyWire),
    b64urlDecode(initiatorNonceWire),
    b64urlDecode(joinerNonceWire),
  );
}
