/**
 * Committed-ephemeral Short Authentication String (SAS) — the 6-digit number a
 * human compares across two screens during pairing.
 *
 * This is the construction docs/TRUST_DEVICE_MESH.md Appendix A requires: a code
 * a substituting/grinding server CANNOT forge (Bluetooth "Numeric Comparison" /
 * MANA-III). Each side contributes a fresh 32-byte nonce; the committer hashes
 * its nonce before the peer reveals theirs, so a relaying MITM cannot adapt its
 * contribution after seeing the target — the two displayed SAS collide only with
 * probability ~1e-6 per one-shot ceremony.
 *
 * Contrast `verification-code.ts` (a function of the long-lived host key alone):
 * a server grinds a matching key in ~1e6 work. That is convenience; THIS is the
 * security check. Must stay byte-identical to the daemon's `sas` module — the
 * shared test vectors below are asserted in both and must never drift:
 *   commit([0x01×32],[0x03×32]) = 914ede51…9958a044
 *   sas([0x01×32],[0x02×32],[0x03×32],[0x04×32]) = "449 728"
 *   sas([0..32],[32..64],[0xaa×32],[0xbb×32])    = "108 396"
 */

const COMMIT_DOMAIN = new TextEncoder().encode("SPAWN-SAS-COMMIT-V1");
const SAS_DOMAIN = new TextEncoder().encode("SPAWN-SAS-V1");

/** Ed25519 public keys and our SAS nonces are 32 bytes. */
export const FIELD_BYTES = 32;

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Uint8Array is a BufferSource at runtime; the cast placates lib.dom's
  // ArrayBufferLike generic without copying.
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** `Cd = SHA256(COMMIT_DOMAIN ‖ hostKey ‖ hostNonce)` (defense-in-depth: the
 * committed nonce is bound to the host key the committer claims). */
export async function commit(hostKey: Uint8Array, hostNonce: Uint8Array): Promise<Uint8Array> {
  return sha256(concat([COMMIT_DOMAIN, hostKey, hostNonce]));
}

/** Whether `commitment` opens to `(hostKey, hostNonce)`. */
export async function verifyCommit(
  commitment: Uint8Array,
  hostKey: Uint8Array,
  hostNonce: Uint8Array,
): Promise<boolean> {
  const expected = await commit(hostKey, hostNonce);
  if (expected.length !== commitment.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ commitment[i];
  return diff === 0;
}

/** The 6-digit SAS both endpoints display, from the keys/nonces each side sees.
 * Formatted `"NNN NNN"`. */
export async function sas(
  hostKey: Uint8Array,
  browserKey: Uint8Array,
  hostNonce: Uint8Array,
  browserNonce: Uint8Array,
): Promise<string> {
  const digest = await sha256(concat([SAS_DOMAIN, hostKey, browserKey, hostNonce, browserNonce]));
  const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const code = n % 1_000_000;
  const s = code.toString().padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** base64url (no padding) helpers for the 32-byte SAS wire values. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array {
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
