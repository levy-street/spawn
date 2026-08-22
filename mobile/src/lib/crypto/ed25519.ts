import * as ed from "@noble/ed25519";

import { ensureCryptoReady } from "@/lib/crypto/bootstrap";

export const ED25519_SEED_BYTES = 32;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

function assertLength(value: Uint8Array, length: number, label: string): void {
  if (value.length !== length) throw new RangeError(`${label} must be exactly ${length} bytes`);
}

export function assertStrictEd25519PublicKey(publicKey: Uint8Array): void {
  ensureCryptoReady();
  assertLength(publicKey, ED25519_PUBLIC_KEY_BYTES, "Ed25519 public key");
  const point = ed.Point.fromBytes(publicKey, false);
  point.assertValidity();
  if (point.isSmallOrder()) throw new Error("Ed25519 public key has small order");
}

export function deriveEd25519PublicKey(seed: Uint8Array): Uint8Array {
  ensureCryptoReady();
  assertLength(seed, ED25519_SEED_BYTES, "Ed25519 seed");
  const publicKey = ed.getPublicKey(seed);
  assertStrictEd25519PublicKey(publicKey);
  return Uint8Array.from(publicKey);
}

export function signPureEd25519(seed: Uint8Array, message: Uint8Array): Uint8Array {
  ensureCryptoReady();
  assertLength(seed, ED25519_SEED_BYTES, "Ed25519 seed");
  return Uint8Array.from(ed.sign(message, seed));
}

export function verifyPureEd25519Strict(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  ensureCryptoReady();
  if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    assertStrictEd25519PublicKey(publicKey);
    return ed.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
