/**
 * The operator's trust bundle: the host keys this account has verified, sealed
 * so only the operator can open it.
 *
 * This is what lets a brand-new device learn real host keys without a terminal
 * ceremony and without trusting the server. The server stores nothing but
 * ciphertext; the key comes from a WebAuthn PRF secret (or, on platforms
 * without PRF, an endorsement from an already-trusted device — see
 * docs/TRUST.md "how a new device bootstraps trust").
 *
 * The security property that matters: a server that substitutes a host key it
 * controls cannot produce a bundle that opens. It never holds the key, and the
 * account and version are bound as AEAD associated data, so a bundle cannot be
 * replayed into another account or reinterpreted under a later format.
 */

import { ed25519PublicKeyFingerprint, encodeBase64Url } from "./signed-signal";

/** Domain separation: this secret must never collide with another PRF use. */
const TRUST_BUNDLE_INFO = "SPAWN-TRUST-BUNDLE-KEY-V1";
/** Bound as associated data so a sealed bundle cannot be reinterpreted. */
const TRUST_BUNDLE_AAD_MAGIC = "SPAWN-TRUST-BUNDLE-AAD-V1";
const TRUST_BUNDLE_VERSION = 1;

const PRF_OUTPUT_BYTES = 32;
const IV_BYTES = 12;
const PUBLIC_KEY_WIRE_LENGTH = 43;
const MAX_HOSTS = 256;

export type TrustBundleErrorCode =
  | "invalid_account"
  | "invalid_prf_secret"
  | "invalid_bundle"
  | "invalid_host_entry"
  | "too_many_hosts"
  | "unsupported_version"
  | "decrypt_failed"
  | "crypto_unavailable";

export class TrustBundleError extends Error {
  constructor(
    readonly code: TrustBundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TrustBundleError";
  }
}

/** One host key the operator has verified out of band. */
export interface TrustBundleHost {
  /** Canonical base64url Ed25519 host public key. */
  readonly hostPublicKey: string;
  /** `SHA256:...`, always re-derived locally rather than trusted as given. */
  readonly hostFingerprint: string;
  /** Host IDs seen for this key. Advisory only; the key is the identity. */
  readonly hostIds: readonly string[];
}

export interface TrustBundle {
  readonly version: typeof TRUST_BUNDLE_VERSION;
  readonly accountId: string;
  readonly hosts: readonly TrustBundleHost[];
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new TrustBundleError(
      "crypto_unavailable",
      "WebCrypto is unavailable; a trust bundle cannot be opened in this context",
    );
  }
  return subtle;
}

/**
 * Canonical base64url decode of a variable-length value.
 *
 * `decodeBase64Url` in signed-signal.ts requires an exact byte length, which
 * every fixed-width wire value there has; a sealed bundle does not. Canonicality
 * is still enforced by re-encoding, so a padded or otherwise non-canonical
 * spelling of the same bytes is rejected rather than silently accepted.
 */
function decodeVariableBase64Url(value: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 === 1) {
    throw new TrustBundleError("invalid_bundle", "invalid canonical base64url");
  }
  if (value.includes("=") || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TrustBundleError("invalid_bundle", "invalid canonical base64url");
  }
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new TrustBundleError("invalid_bundle", "invalid canonical base64url");
  }
  if (encodeBase64Url(decoded) !== value) {
    throw new TrustBundleError("invalid_bundle", "invalid canonical base64url");
  }
  return decoded;
}

/** WebCrypto wants a plain ArrayBuffer; typed-array generics do not satisfy it. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(view);
  return buffer;
}

function requireAccountId(accountId: string): string {
  if (!CANONICAL_UUID.test(accountId)) {
    throw new TrustBundleError("invalid_account", "account ID is not a canonical UUID");
  }
  return accountId;
}

/**
 * Derive the bundle key from a WebAuthn PRF output.
 *
 * HKDF rather than using the PRF output directly: the account is mixed in as
 * salt so one passkey used across accounts yields distinct keys, and the info
 * string keeps this key disjoint from any other use of the same PRF secret.
 */
export async function deriveTrustBundleKey(
  prfOutput: BufferSource,
  accountId: string,
): Promise<CryptoKey> {
  const subtle = requireSubtle();
  requireAccountId(accountId);
  const secret = new Uint8Array(
    prfOutput instanceof ArrayBuffer ? prfOutput : (prfOutput as ArrayBufferView).buffer,
  );
  if (secret.byteLength < PRF_OUTPUT_BYTES) {
    throw new TrustBundleError(
      "invalid_prf_secret",
      `PRF secret must be at least ${PRF_OUTPUT_BYTES} bytes`,
    );
  }
  const material = await subtle.importKey("raw", toArrayBuffer(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(accountId),
      info: new TextEncoder().encode(TRUST_BUNDLE_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function associatedData(accountId: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const magic = encoder.encode(TRUST_BUNDLE_AAD_MAGIC);
  const account = encoder.encode(accountId);
  const out = new Uint8Array(magic.length + 1 + account.length);
  out.set(magic, 0);
  out[magic.length] = TRUST_BUNDLE_VERSION;
  out.set(account, magic.length + 1);
  return toArrayBuffer(out);
}

/**
 * Validate one host entry, re-deriving its fingerprint locally.
 *
 * A fingerprint that arrived alongside the key is never taken on faith: if the
 * two disagree the entry is rejected, so a mismatched pair can never be shown
 * to the operator as if it were consistent.
 */
async function canonicalHost(host: TrustBundleHost): Promise<TrustBundleHost> {
  if (
    typeof host?.hostPublicKey !== "string" ||
    host.hostPublicKey.length !== PUBLIC_KEY_WIRE_LENGTH
  ) {
    throw new TrustBundleError("invalid_host_entry", "host public key is not canonical base64url");
  }
  let derived: string;
  try {
    // Validates the key itself: a non-canonical encoding or an invalid curve
    // point cannot yield a fingerprint.
    derived = await ed25519PublicKeyFingerprint(host.hostPublicKey);
  } catch {
    throw new TrustBundleError("invalid_host_entry", "host public key is not a valid Ed25519 key");
  }
  if (host.hostFingerprint !== derived) {
    throw new TrustBundleError(
      "invalid_host_entry",
      "host fingerprint does not match its public key",
    );
  }
  const hostIds = Array.isArray(host.hostIds) ? host.hostIds : [];
  for (const id of hostIds) {
    if (typeof id !== "string" || !CANONICAL_UUID.test(id)) {
      throw new TrustBundleError("invalid_host_entry", "host ID is not a canonical UUID");
    }
  }
  return {
    hostPublicKey: host.hostPublicKey,
    hostFingerprint: derived,
    hostIds: [...new Set(hostIds)].sort(),
  };
}

/** Deterministic plaintext, so an unchanged bundle re-seals identically. */
async function canonicalBundle(
  accountId: string,
  hosts: readonly TrustBundleHost[],
): Promise<TrustBundle> {
  if (hosts.length > MAX_HOSTS) {
    throw new TrustBundleError("too_many_hosts", `a trust bundle holds at most ${MAX_HOSTS} hosts`);
  }
  const canonical = await Promise.all(hosts.map(canonicalHost));
  const seen = new Set<string>();
  for (const host of canonical) {
    if (seen.has(host.hostPublicKey)) {
      throw new TrustBundleError("invalid_host_entry", "trust bundle has a duplicate host key");
    }
    seen.add(host.hostPublicKey);
  }
  canonical.sort((left, right) => (left.hostPublicKey < right.hostPublicKey ? -1 : 1));
  return { version: TRUST_BUNDLE_VERSION, accountId, hosts: canonical };
}

/** Seal a bundle for storage on the server, which only ever sees ciphertext. */
export async function sealTrustBundle(
  key: CryptoKey,
  accountId: string,
  hosts: readonly TrustBundleHost[],
): Promise<string> {
  const subtle = requireSubtle();
  requireAccountId(accountId);
  const bundle = await canonicalBundle(accountId, hosts);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: associatedData(accountId) },
      key,
      toArrayBuffer(plaintext),
    ),
  );
  const wire = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  wire.set(iv, 0);
  wire.set(ciphertext, IV_BYTES);
  return encodeBase64Url(wire);
}

/**
 * Open a sealed bundle.
 *
 * Every field is revalidated after decryption. Authenticated decryption proves
 * the bytes came from a holder of the key, not that their contents are
 * well-formed, and this bundle becomes trust anchors — so it is re-checked with
 * the same strictness as anything arriving over the wire.
 */
export async function openTrustBundle(
  key: CryptoKey,
  accountId: string,
  wire: string,
): Promise<TrustBundle> {
  const subtle = requireSubtle();
  requireAccountId(accountId);

  const sealed = decodeVariableBase64Url(wire);
  if (sealed.byteLength <= IV_BYTES) {
    throw new TrustBundleError("invalid_bundle", "sealed trust bundle is truncated");
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(sealed.slice(0, IV_BYTES)),
        additionalData: associatedData(accountId),
      },
      key,
      toArrayBuffer(sealed.slice(IV_BYTES)),
    );
  } catch {
    // Wrong passkey, wrong account, tampering, or a different format version:
    // all indistinguishable here by design, and all equally fatal.
    throw new TrustBundleError("decrypt_failed", "trust bundle did not authenticate");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new TrustBundleError("invalid_bundle", "trust bundle is not valid JSON");
  }
  const candidate = parsed as Partial<TrustBundle>;
  if (candidate?.version !== TRUST_BUNDLE_VERSION) {
    throw new TrustBundleError("unsupported_version", "trust bundle version is unsupported");
  }
  if (candidate.accountId !== accountId) {
    // Should be unreachable: the account is bound as AEAD associated data, so a
    // bundle for another account cannot decrypt. Checked anyway — a silent
    // cross-account trust import is exactly the failure worth being paranoid about.
    throw new TrustBundleError("invalid_bundle", "trust bundle belongs to another account");
  }
  if (!Array.isArray(candidate.hosts)) {
    throw new TrustBundleError("invalid_bundle", "trust bundle has no host list");
  }
  return canonicalBundle(accountId, candidate.hosts);
}
