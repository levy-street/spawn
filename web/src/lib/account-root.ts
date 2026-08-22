/**
 * The account ROOT key R = (sk_R, pk_R) — the universal anchor of the device
 * trust mesh (docs/TRUST_DEVICE_MESH.md §3, stage 5).
 *
 * Unlike a browser device identity (whose key is non-extractable and lives in
 * IndexedDB on one device), the root's private seed is *sealed under the
 * passkey* in the trust bundle so any passkey-holder can recover it — that is
 * what makes device-loss recovery and healing possible. `sk_R` therefore has to
 * be exportable (to seal) and importable (to sign after an unlock). It is held
 * in memory only for the length of a heal and should be dropped immediately
 * after (see the zeroize note in the sealing layer).
 *
 * A root endorsement `R→d` is nothing new cryptographically: it is exactly a
 * `SPAWN-ACCT-ENDORSE-V1` endorsement (the stage-1 primitive) with `pk_R` as the
 * endorser. So the daemon validates it with the same `find_valid_chain`, and R
 * behaves as any anchor key in the graph.
 */

import { encodeAcctEndorsementTranscript } from "./acct-endorsement-transcript";
import { encodeBrowserDeviceRegistrationTranscript } from "./browser-device-registration-transcript";
import { ED25519_SIGNATURE_BYTES, encodeBase64Url } from "./signed-signal";

/** A usable account root: its wire public key plus a sign-capable private key. */
export interface AccountRoot {
  readonly publicKeyWire: string;
  /** Ed25519 private key with usage ["sign"]. */
  readonly privateKey: CryptoKey;
}

/** The at-rest material for the root, sealed into the trust bundle. */
export interface AccountRootMaterial {
  readonly publicKeyWire: string;
  /** base64url of the 32-byte Ed25519 seed (JWK `d`). */
  readonly seedWire: string;
}

/** Mint a fresh account root. The returned private key is extractable so its
 * seed can be sealed; callers seal immediately and do not persist it in the
 * clear. */
export async function generateAccountRoot(): Promise<AccountRoot> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKeyWire: encodeBase64Url(raw), privateKey: pair.privateKey };
}

/** Export the root's at-rest material (public key + seed) for sealing. */
export async function exportAccountRootMaterial(root: AccountRoot): Promise<AccountRootMaterial> {
  const jwk = await crypto.subtle.exportKey("jwk", root.privateKey);
  if (typeof jwk.d !== "string") {
    throw new Error("account root private key is not exportable");
  }
  return { publicKeyWire: root.publicKeyWire, seedWire: jwk.d };
}

/** Reconstruct a sign-capable root from sealed material. The imported key is
 * NON-extractable: the seed in `material` is the sole at-rest source of truth,
 * so the reconstructed handle only needs to sign. */
export async function importAccountRoot(material: AccountRootMaterial): Promise<AccountRoot> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "OKP",
      crv: "Ed25519",
      x: material.publicKeyWire,
      d: material.seedWire,
    },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { publicKeyWire: material.publicKeyWire, privateKey };
}

/**
 * Sign the root's own browser-device registration proof. The root registers as
 * a `browser_device` marked `is_root` (mesh 5b) so it reuses the endorsement
 * store and pin delivery; like any device registration, ownership of the key is
 * proven by signing the registration transcript with it.
 */
export async function createRootRegistrationProof(
  root: AccountRoot,
  accountId: string,
): Promise<string> {
  // is_root=true is bound inside the V2 transcript: only the holder of sk_R can
  // produce a proof that registers pk_R AS the root, and the same signature can
  // never be replayed to register it as an ordinary device (or vice versa).
  const transcript = encodeBrowserDeviceRegistrationTranscript(accountId, root.publicKeyWire, true);
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, root.privateKey, owned),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new Error("root registration signer returned an invalid signature length");
  }
  return encodeBase64Url(signature);
}

/**
 * Sign a root endorsement `R→d`: the root vouches for a device's key for the
 * whole account. This is the healing/recovery signature — a passkey-holder,
 * having unsealed `sk_R`, re-roots a device directly at `R` (a length-1 chain).
 * Unlike a device endorsement it needs no per-device human check: it re-roots
 * trust that a device already holds, it does not admit a new key.
 */
export async function createRootEndorsementProof(
  root: AccountRoot,
  accountId: string,
  endorsedPublicKeyWire: string,
  endorsedDeviceId: string,
): Promise<string> {
  const transcript = encodeAcctEndorsementTranscript(
    accountId,
    root.publicKeyWire,
    endorsedPublicKeyWire,
    endorsedDeviceId,
  );
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, root.privateKey, owned),
  );
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new Error("root endorsement signer returned an invalid signature length");
  }
  return encodeBase64Url(signature);
}
