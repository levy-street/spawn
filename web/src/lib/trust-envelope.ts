/**
 * Envelope encryption for the trust bundle, so more than one passkey can open
 * it.
 *
 * The bundle is sealed once under a random data key. That data key is then
 * wrapped separately for each enrolled passkey, under a key the passkey's PRF
 * secret derives. Any enrolled passkey unwraps the data key and opens the same
 * bundle; enrolling another adds a wrap rather than resealing everything.
 *
 * This is what makes a backup passkey possible. Before it, one passkey held the
 * only copy of the operator's trust, and losing it lost the bundle. See
 * docs/TRUST.md "how a new device bootstraps trust".
 *
 * The server still only ever holds ciphertext: the sealed bundle, and a set of
 * wraps each of which is the data key encrypted under a secret the server never
 * sees. A server that tampers with a wrap can only make one passkey fail to
 * unlock — it cannot read the data key or forge a bundle.
 */

import type { AccountRootMaterial } from "./account-root";
import { encodeBase64Url } from "./signed-signal";
import {
  canonicalBundle,
  decodeVariableBase64Url,
  MAX_RETIRED_ROOTS,
  requireRevision,
  TRUST_IV_BYTES,
  type TrustBundle,
  TrustBundleError,
  type TrustBundleHost,
  toArrayBuffer,
} from "./trust-bundle";

const ENVELOPE_VERSION = 2;
const DATA_KEY_BYTES = 32;
const PRF_OUTPUT_BYTES = 32;
/** Domain separation for the per-passkey wrapping key. */
const WRAP_KEY_INFO = "SPAWN-TRUST-BUNDLE-WRAP-V1";
const BUNDLE_AAD_MAGIC = "SPAWN-TRUST-ENVELOPE-BUNDLE-V1";
const WRAP_AAD_MAGIC = "SPAWN-TRUST-ENVELOPE-WRAP-V1";
const MAX_WRAPS = 32;

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface WrapEntry {
  readonly credentialId: string;
  /** base64url of iv || AES-GCM(dataKey) under this passkey's wrapping key. */
  readonly wrapped: string;
}

interface EnvelopeWire {
  readonly version: typeof ENVELOPE_VERSION;
  readonly accountId: string;
  /** base64url of iv || AES-GCM(bundle JSON) under the data key. */
  readonly sealed: string;
  readonly wraps: readonly WrapEntry[];
}

/** One passkey's inputs: which credential, and the PRF secret it produced. */
export interface PasskeyWrapInput {
  readonly credentialId: string;
  readonly prfSecret: Uint8Array;
}

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new TrustBundleError(
      "crypto_unavailable",
      "WebCrypto is unavailable; a trust envelope cannot be opened in this context",
    );
  }
  return subtle;
}

function requireAccountId(accountId: string): void {
  if (!CANONICAL_UUID.test(accountId)) {
    throw new TrustBundleError("invalid_account", "account ID is not a canonical UUID");
  }
}

function aad(magic: string, ...parts: string[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const pieces = [encoder.encode(magic), Uint8Array.of(ENVELOPE_VERSION)];
  // The NUL separator is load-bearing: every sealed envelope authenticates
  // against these exact bytes, so changing it orphans existing envelopes.
  for (const part of parts) pieces.push(encoder.encode("\u0000"), encoder.encode(part));
  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return toArrayBuffer(out);
}

/** Derive the AES-GCM key that wraps the data key for one passkey. */
async function wrappingKey(prfSecret: Uint8Array, accountId: string): Promise<CryptoKey> {
  const subtle = requireSubtle();
  if (prfSecret.byteLength < PRF_OUTPUT_BYTES) {
    throw new TrustBundleError("invalid_prf_secret", "PRF secret is shorter than required");
  }
  const material = await subtle.importKey("raw", toArrayBuffer(prfSecret), "HKDF", false, [
    "deriveKey",
  ]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(accountId),
      info: new TextEncoder().encode(WRAP_KEY_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function importDataKey(bytes: Uint8Array): Promise<CryptoKey> {
  return requireSubtle().importKey("raw", toArrayBuffer(bytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function sealBytes(
  key: CryptoKey,
  additionalData: ArrayBuffer,
  plaintext: Uint8Array,
): Promise<string> {
  const subtle = requireSubtle();
  const iv = crypto.getRandomValues(new Uint8Array(TRUST_IV_BYTES));
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData },
      key,
      toArrayBuffer(plaintext),
    ),
  );
  const wire = new Uint8Array(TRUST_IV_BYTES + ciphertext.byteLength);
  wire.set(iv, 0);
  wire.set(ciphertext, TRUST_IV_BYTES);
  return encodeBase64Url(wire);
}

async function openBytes(
  key: CryptoKey,
  additionalData: ArrayBuffer,
  wire: string,
): Promise<Uint8Array> {
  const sealed = decodeVariableBase64Url(wire);
  if (sealed.byteLength <= TRUST_IV_BYTES) {
    throw new TrustBundleError("invalid_bundle", "sealed value is truncated");
  }
  const plaintext = await requireSubtle().decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(sealed.slice(0, TRUST_IV_BYTES)), additionalData },
    key,
    toArrayBuffer(sealed.slice(TRUST_IV_BYTES)),
  );
  return new Uint8Array(plaintext);
}

async function wrapDataKey(
  dataKey: Uint8Array,
  accountId: string,
  passkey: PasskeyWrapInput,
): Promise<WrapEntry> {
  const key = await wrappingKey(passkey.prfSecret, accountId);
  return {
    credentialId: passkey.credentialId,
    wrapped: await sealBytes(key, aad(WRAP_AAD_MAGIC, accountId, passkey.credentialId), dataKey),
  };
}

/** Seal a bundle and wrap its data key for one or more passkeys. */
export async function sealTrustEnvelope(
  accountId: string,
  hosts: readonly TrustBundleHost[],
  passkeys: readonly PasskeyWrapInput[],
  revision: number,
  root: AccountRootMaterial | null = null,
  retiredRoots: readonly AccountRootMaterial[] = [],
): Promise<string> {
  requireAccountId(accountId);
  if (passkeys.length === 0) {
    throw new TrustBundleError("invalid_bundle", "an envelope needs at least one passkey wrap");
  }
  const bundle = await canonicalBundle(accountId, hosts, revision, root, retiredRoots);
  const dataKey = crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
  const sealed = await sealBytes(
    await importDataKey(dataKey),
    aad(BUNDLE_AAD_MAGIC, accountId),
    new TextEncoder().encode(JSON.stringify(bundle)),
  );
  const wraps = await Promise.all(
    passkeys.map((passkey) => wrapDataKey(dataKey, accountId, passkey)),
  );
  const envelope: EnvelopeWire = { version: ENVELOPE_VERSION, accountId, sealed, wraps };
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
}

function parseEnvelope(accountId: string, wire: string): EnvelopeWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeVariableBase64Url(wire)));
  } catch {
    throw new TrustBundleError("invalid_bundle", "trust envelope is not valid JSON");
  }
  const candidate = parsed as Partial<EnvelopeWire>;
  if (candidate?.version !== ENVELOPE_VERSION) {
    throw new TrustBundleError("unsupported_version", "trust envelope version is unsupported");
  }
  if (candidate.accountId !== accountId) {
    throw new TrustBundleError("invalid_bundle", "trust envelope belongs to another account");
  }
  if (typeof candidate.sealed !== "string" || !Array.isArray(candidate.wraps)) {
    throw new TrustBundleError("invalid_bundle", "trust envelope is malformed");
  }
  return candidate as EnvelopeWire;
}

/** Credential IDs a device could try, so it knows which passkey to ask for. */
export function envelopeWrapCredentialIds(accountId: string, wire: string): string[] {
  return parseEnvelope(accountId, wire).wraps.map((wrap) => wrap.credentialId);
}

async function recoverDataKey(
  envelope: EnvelopeWire,
  accountId: string,
  passkey: PasskeyWrapInput,
): Promise<Uint8Array> {
  const wrap = envelope.wraps.find((entry) => entry.credentialId === passkey.credentialId);
  if (wrap === undefined) {
    throw new TrustBundleError(
      "decrypt_failed",
      "this passkey is not enrolled for the trust bundle",
    );
  }
  const key = await wrappingKey(passkey.prfSecret, accountId);
  let dataKey: Uint8Array;
  try {
    dataKey = await openBytes(
      key,
      aad(WRAP_AAD_MAGIC, accountId, passkey.credentialId),
      wrap.wrapped,
    );
  } catch {
    throw new TrustBundleError("decrypt_failed", "this passkey did not unwrap the trust bundle");
  }
  if (dataKey.byteLength !== DATA_KEY_BYTES) {
    throw new TrustBundleError("invalid_bundle", "unwrapped data key has the wrong length");
  }
  return dataKey;
}

/** Decrypt a sealed bundle under a recovered data key and revalidate it. */
async function openSealedBundle(
  dataKey: Uint8Array,
  accountId: string,
  sealed: string,
): Promise<TrustBundle> {
  let plaintext: Uint8Array;
  try {
    plaintext = await openBytes(
      await importDataKey(dataKey),
      aad(BUNDLE_AAD_MAGIC, accountId),
      sealed,
    );
  } catch {
    throw new TrustBundleError("decrypt_failed", "trust bundle did not authenticate");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new TrustBundleError("invalid_bundle", "trust bundle is not valid JSON");
  }
  const candidate = parsed as Partial<TrustBundle>;
  if (!Array.isArray(candidate?.hosts)) {
    throw new TrustBundleError("invalid_bundle", "trust bundle has no host list");
  }
  // Re-canonicalize: authenticated decryption proves who wrote the bytes, not
  // that they are well-formed, and these become trust anchors. The revision is
  // authenticated with the rest of the plaintext; legacy bundles without one
  // open as 0. The caller enforces monotonicity against a local floor.
  const revision = candidate.revision === undefined ? 0 : requireRevision(candidate.revision);
  return canonicalBundle(
    accountId,
    candidate.hosts,
    revision,
    candidate.root ?? null,
    candidate.retiredRoots ?? [],
  );
}

/** Open the envelope with one enrolled passkey and return the trust bundle. */
export async function openTrustEnvelope(
  accountId: string,
  wire: string,
  passkey: PasskeyWrapInput,
): Promise<TrustBundle> {
  requireAccountId(accountId);
  const envelope = parseEnvelope(accountId, wire);
  const dataKey = await recoverDataKey(envelope, accountId, passkey);
  return openSealedBundle(dataKey, accountId, envelope.sealed);
}

/**
 * Retrofit an account root into a pre-root bundle (mesh stage 5c).
 *
 * Reseals the bundle's content — same hosts, plus the root, at an advanced
 * revision — under the SAME data key, so every enrolled passkey's wrap keeps
 * working without gathering the other passkeys' PRF secrets. Refuses to touch a
 * bundle that already holds a root: an existing `sk_R` is the account's anchor
 * and is never silently replaced.
 *
 * With `replace` (root ROTATION), the outgoing root is RETIRED into the
 * bundle rather than destroyed (hardening B2): rotation was triggered by a
 * server-claimed revocation, and however well corroborated, a server claim
 * must never be able to erase the operator's only copy of firsthand key
 * material. The retired archive is bounded; at the cap rotation refuses
 * loudly instead of silently evicting older material.
 */
export async function setEnvelopeRoot(
  accountId: string,
  wire: string,
  unlockWith: PasskeyWrapInput,
  root: AccountRootMaterial,
  revision: number,
  replace = false,
): Promise<string> {
  requireAccountId(accountId);
  const envelope = parseEnvelope(accountId, wire);
  const dataKey = await recoverDataKey(envelope, accountId, unlockWith);
  const bundle = await openSealedBundle(dataKey, accountId, envelope.sealed);
  if (bundle.root !== null && !replace) {
    throw new TrustBundleError("invalid_bundle", "the trust bundle already holds an account root");
  }
  if (revision <= bundle.revision) {
    throw new TrustBundleError(
      "invalid_bundle",
      "a root retrofit must advance the bundle revision",
    );
  }
  const retiredRoots =
    replace && bundle.root !== null ? [...bundle.retiredRoots, bundle.root] : bundle.retiredRoots;
  if (retiredRoots.length > MAX_RETIRED_ROOTS) {
    throw new TrustBundleError(
      "invalid_bundle",
      `rotation would exceed the ${MAX_RETIRED_ROOTS} retained retired roots; ` +
        "refusing rather than destroying retired root material",
    );
  }
  const amended = await canonicalBundle(accountId, bundle.hosts, revision, root, retiredRoots);
  const sealed = await sealBytes(
    await importDataKey(dataKey),
    aad(BUNDLE_AAD_MAGIC, accountId),
    new TextEncoder().encode(JSON.stringify(amended)),
  );
  const next: EnvelopeWire = { ...envelope, sealed };
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(next)));
}

/**
 * Merge additional verified hosts into the sealed bundle — the reseal half of
 * "the bundle tracks the fleet" (review P-C1).
 *
 * Reseals the bundle's content — the union of its hosts and `hosts`, same
 * root and retired-root archive, at an advanced revision — under the SAME
 * data key, so every enrolled passkey's wrap keeps working without gathering
 * the other passkeys' PRF secrets (exactly the `setEnvelopeRoot` discipline).
 * `hosts` must be firsthand-verified by the caller (this device's own active
 * pin store): what goes in here is what every future passkey unlock will pin.
 *
 * Returns null when the union adds nothing — the caller skips the write.
 */
export async function mergeEnvelopeHosts(
  accountId: string,
  wire: string,
  unlockWith: PasskeyWrapInput,
  hosts: readonly TrustBundleHost[],
  revision: number,
): Promise<{ readonly sealed: string; readonly addedHostKeys: readonly string[] } | null> {
  requireAccountId(accountId);
  const envelope = parseEnvelope(accountId, wire);
  const dataKey = await recoverDataKey(envelope, accountId, unlockWith);
  const bundle = await openSealedBundle(dataKey, accountId, envelope.sealed);
  const byKey = new Map(bundle.hosts.map((host) => [host.hostPublicKey, host]));
  const addedHostKeys: string[] = [];
  for (const host of hosts) {
    const existing = byKey.get(host.hostPublicKey);
    if (existing === undefined) {
      byKey.set(host.hostPublicKey, host);
      addedHostKeys.push(host.hostPublicKey);
      continue;
    }
    // Same key, possibly new host-id bindings (an id learned since the seal
    // keeps the signed-RTC downgrade check working right after an import).
    const hostIds = [...new Set([...existing.hostIds, ...host.hostIds])].sort();
    if (hostIds.length !== existing.hostIds.length) {
      byKey.set(host.hostPublicKey, { ...existing, hostIds });
      addedHostKeys.push(host.hostPublicKey);
    }
  }
  if (addedHostKeys.length === 0) return null;
  if (revision <= bundle.revision) {
    throw new TrustBundleError("invalid_bundle", "a host merge must advance the bundle revision");
  }
  const amended = await canonicalBundle(
    accountId,
    [...byKey.values()],
    revision,
    bundle.root,
    bundle.retiredRoots,
  );
  const sealed = await sealBytes(
    await importDataKey(dataKey),
    aad(BUNDLE_AAD_MAGIC, accountId),
    new TextEncoder().encode(JSON.stringify(amended)),
  );
  const next: EnvelopeWire = { ...envelope, sealed };
  return {
    sealed: encodeBase64Url(new TextEncoder().encode(JSON.stringify(next))),
    addedHostKeys,
  };
}

/**
 * Enroll another passkey by adding a wrap of the same data key.
 *
 * Requires a passkey that can already unlock, and the new passkey's PRF secret,
 * so the enrolling device must be able to exercise both. That is the single
 * limit of this approach: a passkey that exists only on a device with no
 * unlocking passkey cannot be added here -- that device uses endorsement for
 * host trust instead.
 */
export async function enrollPasskeyInEnvelope(
  accountId: string,
  wire: string,
  unlockWith: PasskeyWrapInput,
  newPasskey: PasskeyWrapInput,
): Promise<string> {
  requireAccountId(accountId);
  if (newPasskey.credentialId === unlockWith.credentialId) {
    // Without this, "enrolling" the unlocking credential with a different secret
    // replaces its only wrap under a key nothing can reproduce, permanently
    // bricking the bundle. Mirrors the self-revoke guard below.
    throw new TrustBundleError("invalid_bundle", "a passkey cannot enroll over itself");
  }
  const envelope = parseEnvelope(accountId, wire);
  if (envelope.wraps.length >= MAX_WRAPS) {
    throw new TrustBundleError("too_many_hosts", `an envelope holds at most ${MAX_WRAPS} passkeys`);
  }
  const dataKey = await recoverDataKey(envelope, accountId, unlockWith);
  // Prove the sealed bundle actually opens under the recovered key before
  // republishing it, so a server-corrupted `sealed` is caught here rather than
  // being re-committed with a cheerful "backup enrolled" message.
  await openSealedBundle(dataKey, accountId, envelope.sealed);
  const wraps = envelope.wraps.filter((wrap) => wrap.credentialId !== newPasskey.credentialId);
  wraps.push(await wrapDataKey(dataKey, accountId, newPasskey));
  const next: EnvelopeWire = { ...envelope, wraps };
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(next)));
}

/**
 * Revoke a passkey by resealing the bundle under a fresh data key for exactly
 * the kept passkeys, at a higher revision.
 *
 * Filtering the wrap out is not enough: the server keeps every prior envelope,
 * so a dropped wrap can be spliced back from an old copy. Instead we mint a new
 * data key (which the revoked wrap can no longer derive) and bump the revision
 * (so any replay of the old envelope falls below the device's rollback floor).
 *
 * `keep` must carry the PRF secret of every passkey that should retain access —
 * a passkey the caller cannot exercise here cannot be re-wrapped and would lose
 * access, so the caller is responsible for supplying all survivors. `revision`
 * must exceed the current bundle's.
 */
export async function revokePasskeyFromEnvelope(
  accountId: string,
  wire: string,
  keep: readonly PasskeyWrapInput[],
  revokedCredentialId: string,
  revision: number,
): Promise<string> {
  requireAccountId(accountId);
  if (keep.length === 0) {
    throw new TrustBundleError("invalid_bundle", "revocation must keep at least one passkey");
  }
  if (keep.some((passkey) => passkey.credentialId === revokedCredentialId)) {
    throw new TrustBundleError("invalid_bundle", "a passkey cannot be both kept and revoked");
  }
  const envelope = parseEnvelope(accountId, wire);
  if (!envelope.wraps.some((wrap) => wrap.credentialId === revokedCredentialId)) {
    throw new TrustBundleError("invalid_bundle", "no such passkey is enrolled");
  }
  // Resealing keeps wraps only for `keep`, so any enrolled passkey that is
  // neither kept nor the one being revoked would be silently and permanently
  // dropped. Refuse here rather than trusting the caller (or a server-supplied
  // passkey list) to have enumerated every survivor — a hostile server that
  // hides a third passkey must not be able to induce its eviction.
  const keptIds = new Set(keep.map((passkey) => passkey.credentialId));
  const orphaned = envelope.wraps.find(
    (wrap) => wrap.credentialId !== revokedCredentialId && !keptIds.has(wrap.credentialId),
  );
  if (orphaned !== undefined) {
    throw new TrustBundleError(
      "invalid_bundle",
      "revocation would drop an enrolled passkey that is neither kept nor revoked",
    );
  }
  // Recover through a kept passkey (which proves it can currently open), then
  // reseal for the kept set under a fresh key and a bumped revision.
  const dataKey = await recoverDataKey(envelope, accountId, keep[0]);
  const bundle = await openSealedBundle(dataKey, accountId, envelope.sealed);
  if (revision <= bundle.revision) {
    throw new TrustBundleError("invalid_bundle", "revocation must advance the bundle revision");
  }
  // Reseal with the root AND retired-root archive the bundle already carried —
  // dropping either here would silently destroy the account's only copy of
  // firsthand root material.
  return sealTrustEnvelope(
    accountId,
    bundle.hosts,
    keep,
    revision,
    bundle.root,
    bundle.retiredRoots,
  );
}
