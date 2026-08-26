import { sha256 } from "@noble/hashes/sha2.js";

import { randomBytes } from "@/lib/crypto/bootstrap";
import {
  concatBytes,
  decodeBase64UrlExact,
  encodeBase64Url,
  encodeUtf8,
  equalBytes,
} from "@/lib/crypto/bytes";

/**
 * Committed-ephemeral Short Authentication String (SAS): the short number a
 * human carries between two screens during the add-device ceremony
 * (docs/TRUST_DEVICE_MESH.md Appendix A, §4 add-device).
 *
 * Each side contributes a fresh 32-byte nonce; the initiator commits to its
 * nonce before the joiner reveals theirs, so a relaying server cannot adapt
 * its contribution after seeing the target. A substitution therefore lands on
 * the right number with probability 10^-digits per one-shot ceremony, and the
 * three-try limit on the entering side keeps that the whole budget.
 *
 * Byte-identical to daemon/src/sas.rs and web/src/lib/sas.ts; the shared
 * vectors are asserted in every runtime and must never drift:
 *   commit([0x01×32],[0x03×32]) = 914ede51…9958a044
 *   sas([0x01×32],[0x02×32],[0x03×32],[0x04×32]) = "449 728"
 *   sas([0..32],[32..64],[0xaa×32],[0xbb×32])    = "108 396"
 * The device↔device ceremony uses the same digest truncated to four digits:
 * 449728 % 10000 = 9728 → "9728".
 */

const COMMIT_DOMAIN = encodeUtf8("SPAWN-SAS-COMMIT-V1");
const SAS_DOMAIN = encodeUtf8("SPAWN-SAS-V1");

/** Ed25519 public keys and SAS nonces are 32 bytes. */
export const SAS_FIELD_BYTES = 32;

/** Four digits for device↔device: each wrong guess is an online, one-shot,
 * committed attempt, so 1-in-10⁴ bounds a substituting server while keeping
 * the entry light. Same value as the web's CEREMONY_SAS_DIGITS. */
export const CEREMONY_SAS_DIGITS = 4;

/** A fresh nonce for one ceremony contribution. */
export function freshSasNonce(): Uint8Array {
  return randomBytes(SAS_FIELD_BYTES);
}

/** `C = SHA256(COMMIT_DOMAIN ‖ key ‖ nonce)`: hides `nonce` until revealed, bound
 * to the key the committer claims. */
export function sasCommit(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  return sha256(concatBytes(COMMIT_DOMAIN, key, nonce));
}

export function verifySasCommit(
  commitment: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
): boolean {
  return equalBytes(sasCommit(key, nonce), commitment);
}

/** The number both sides display: initiator key/nonce in the "host" position,
 * joiner in the "browser" position, exactly as the web maps the roles. */
export function sas(
  initiatorKey: Uint8Array,
  joinerKey: Uint8Array,
  initiatorNonce: Uint8Array,
  joinerNonce: Uint8Array,
  digits = 6,
): string {
  const digest = sha256(
    concatBytes(SAS_DOMAIN, initiatorKey, joinerKey, initiatorNonce, joinerNonce),
  );
  const n =
    (((digest[0] ?? 0) << 24) |
      ((digest[1] ?? 0) << 16) |
      ((digest[2] ?? 0) << 8) |
      (digest[3] ?? 0)) >>>
    0;
  const code = n % 10 ** digits;
  const text = code.toString().padStart(digits, "0");
  // Six digits are grouped ("449 728") — six carried across a room in one run
  // is where people drop one. Four is short enough to hold whole, and the gap
  // inside it only invited typing the space, so it stays a single run.
  if (digits <= 4) return text;
  const half = Math.ceil(digits / 2);
  return `${text.slice(0, half)} ${text.slice(half)}`;
}

function field(value: string, name: string): Uint8Array {
  try {
    return decodeBase64UrlExact(value, SAS_FIELD_BYTES);
  } catch {
    throw new Error(`${name} is not a 32-byte base64url value`);
  }
}

/** The initiator's commitment for the relay, base64url. */
export function commitWire(publicKeyWire: string, nonce: Uint8Array): string {
  return encodeBase64Url(sasCommit(field(publicKeyWire, "public key"), nonce));
}

/** Whether a revealed nonce opens the initiator's commitment. The joiner MUST
 * check this before trusting the number: a relay that reveals a mismatched
 * nonce is a substitution attempt. Malformed wire values never open it. */
export function verifyCommitWire(
  commitmentWire: string,
  publicKeyWire: string,
  nonceWire: string,
): boolean {
  try {
    return verifySasCommit(
      field(commitmentWire, "commitment"),
      field(publicKeyWire, "public key"),
      field(nonceWire, "nonce"),
    );
  } catch {
    return false;
  }
}

/** The device↔device number, "NNNN". */
export function ceremonySas(
  initiatorKeyWire: string,
  joinerKeyWire: string,
  initiatorNonceWire: string,
  joinerNonceWire: string,
): string {
  return sas(
    field(initiatorKeyWire, "initiator key"),
    field(joinerKeyWire, "joiner key"),
    field(initiatorNonceWire, "initiator nonce"),
    field(joinerNonceWire, "joiner nonce"),
    CEREMONY_SAS_DIGITS,
  );
}
