import {
  type BrowserDeviceIdentity,
  type BrowserDeviceIdentityStorageOptions,
  loadBrowserDeviceIdentity,
} from "./browser-device-identity";
import {
  BrowserHostPinError,
  type BrowserHostPinStorageOptions,
  browserHostPinServerOrigin,
  loadBrowserHostPinByHostId,
  resolveActiveBrowserHostPin,
} from "./browser-host-pins";
import type { SignedRtcTrustCapability } from "./signed-rtc-live";
import { signRtcSignalWire } from "./signed-signal-wire";

/**
 * Why a live signaling connection was refused. Every reason means the local
 * trust state could not authorize a signed session AND the host is (or may be)
 * pinned, so a raw fallback would be a downgrade. The caller must surface the
 * refusal and MUST NOT open a raw connection.
 */
export type SignedRtcRefusalReason =
  /** Server presented a different key than the locally approved pin. */
  | "host_key_substituted"
  /** The matching local pin was explicitly revoked; re-approval is required. */
  | "host_key_revoked"
  /** Host is locally pinned, but the server presented no key at all (null). */
  | "host_key_withheld"
  /** Host is pinned, but this browser holds no signing identity to sign offers. */
  | "browser_identity_unavailable"
  /** The local pin store could not be consulted; fail closed. */
  | "pin_storage_error";

/**
 * The trust decision for one live RTC connection generation.
 * - `signed`   — a local pin matched; signed signaling is mandatory.
 * - `unpinned` — this host has never been approved; raw TOFU first-contact is
 *   acceptable (unchanged legacy behavior).
 * - `refuse`   — the host is (or may be) pinned but cannot be verified; the
 *   caller must NOT connect, signed or raw.
 */
export type SignedRtcTrustDecision =
  | { readonly mode: "signed"; readonly capability: SignedRtcTrustCapability }
  | { readonly mode: "unpinned" }
  | { readonly mode: "refuse"; readonly reason: SignedRtcRefusalReason };

export interface ResolveSignedRtcTrustInput {
  readonly accountId: string;
  readonly hostId: string;
  /** Host public key as CLAIMED by the (untrusted) server Host API; may be null. */
  readonly claimedHostPublicKey: string | null;
  /** Host fingerprint as CLAIMED by the (untrusted) server Host API; may be null. */
  readonly claimedHostFingerprint: string | null;
  /** Defaults to the current server origin used for pin scoping. */
  readonly origin?: string;
  /**
   * Liveness of the browser trust epoch for this connection generation. The
   * returned capability re-asserts it across every async signing/verifying
   * boundary, so it must return false (or throw) the instant the epoch ends
   * (logout, account switch, generation superseded, tab invalidation).
   */
  readonly isActive: () => boolean;
  /** Test-only IndexedDB injection for the host-pin store. */
  readonly hostPinStorage?: BrowserHostPinStorageOptions;
  /** Test-only IndexedDB injection for the device-identity store. */
  readonly deviceIdentityStorage?: BrowserDeviceIdentityStorageOptions;
}

/**
 * Decide, from LOCAL trust state only, whether a live RTC connection to `hostId`
 * must be signed, may be raw, or must be refused. The server's claimed key and
 * fingerprint are treated as untrusted inputs — a pin match is required to trust
 * them, and their absence or divergence for an already-pinned host is a
 * downgrade signal, not a reason to fall back to raw.
 */
export async function resolveSignedRtcTrust(
  input: ResolveSignedRtcTrustInput,
): Promise<SignedRtcTrustDecision> {
  // Without WebCrypto (i.e. a non-secure context) no pin can ever have been
  // approved in THIS origin: the pin store is origin-scoped and approving one
  // requires signing. There is therefore nothing to downgrade from, and a
  // signed session is impossible. Treat it as unpinned rather than refusing
  // every connection — refusing here would break all traffic on such an origin
  // without protecting anything.
  if (typeof globalThis.crypto?.subtle === "undefined") {
    return { mode: "unpinned" };
  }

  const origin = input.origin ?? browserHostPinServerOrigin();

  let resolvedHostPublicKeyWire: string;
  try {
    resolvedHostPublicKeyWire = await resolveActiveBrowserHostPin(
      {
        accountId: input.accountId,
        origin,
        hostId: input.hostId,
        claimedHostPublicKey: input.claimedHostPublicKey,
        claimedHostFingerprint: input.claimedHostFingerprint,
      },
      input.hostPinStorage ?? {},
    );
  } catch (error) {
    return await decideAfterResolveFailure(input, origin, error);
  }

  // A local pin matched the server's claimed key: signed signaling is mandatory
  // for this host from here on.
  let identity: BrowserDeviceIdentity | null;
  try {
    identity = await loadBrowserDeviceIdentity(input.accountId, input.deviceIdentityStorage ?? {});
  } catch {
    return { mode: "refuse", reason: "browser_identity_unavailable" };
  }
  if (identity === null) {
    // A pinned host must never be reached over a raw path, so a missing signing
    // identity is a hard refusal rather than a silent downgrade.
    return { mode: "refuse", reason: "browser_identity_unavailable" };
  }

  const signer = identity;
  const capability: SignedRtcTrustCapability = {
    browserPublicKeyWire: signer.publicKeyWire,
    hostPublicKeyWire: resolvedHostPublicKeyWire,
    signOffer: (signalInput) => signRtcSignalWire(signer, signalInput),
    assertActive: () => {
      if (!input.isActive()) {
        throw new Error("signed RTC trust epoch is no longer active");
      }
    },
  };
  return { mode: "signed", capability };
}

async function decideAfterResolveFailure(
  input: ResolveSignedRtcTrustInput,
  origin: string,
  error: unknown,
): Promise<SignedRtcTrustDecision> {
  if (!(error instanceof BrowserHostPinError)) {
    // Unexpected failure consulting the pin store: fail closed.
    return { mode: "refuse", reason: "pin_storage_error" };
  }

  switch (error.code) {
    case "revoked_pin":
      return { mode: "refuse", reason: "host_key_revoked" };
    case "host_id_key_conflict":
    case "fingerprint_mismatch":
      return { mode: "refuse", reason: "host_key_substituted" };
    case "missing_pin":
    case "null_key":
    case "null_fingerprint": {
      // The server's claimed key is not (or not yet) an approved pin. That is a
      // legitimate unpinned/TOFU host UNLESS this hostId is already locally
      // pinned — in which case a null/absent/foreign key is a downgrade attempt
      // and the connection must be refused.
      if (await hostIdIsLocallyPinned(input, origin)) {
        const withheld = error.code === "null_key" || error.code === "null_fingerprint";
        return {
          mode: "refuse",
          reason: withheld ? "host_key_withheld" : "host_key_substituted",
        };
      }
      return { mode: "unpinned" };
    }
    default:
      // invalid_account, invalid_host_id, storage_failure, corrupt_record, etc.
      // None can authorize a raw connection to a keyed host: fail closed.
      return { mode: "refuse", reason: "pin_storage_error" };
  }
}

async function hostIdIsLocallyPinned(
  input: ResolveSignedRtcTrustInput,
  origin: string,
): Promise<boolean> {
  try {
    const bound = await loadBrowserHostPinByHostId(
      { accountId: input.accountId, origin, hostId: input.hostId },
      input.hostPinStorage ?? {},
    );
    return bound !== null;
  } catch {
    // If binding cannot be determined, fail closed: treat the hostId as pinned
    // so an unverifiable key is refused rather than silently downgraded.
    return true;
  }
}
