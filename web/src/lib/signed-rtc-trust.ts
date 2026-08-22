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
import { decodeEd25519PublicKeyWire } from "./signed-signal";
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
 * One honest explanation per refusal, shared by every surface that shows one
 * (the terminal's connection chip, the host page, the file explorer). The
 * refusal itself never softens — there is no "accept the new identity" path
 * anywhere — but `host_key_substituted` names BOTH possibilities truthfully:
 * the owner's own reinstall/re-key cycle is indistinguishable from a
 * substitution attack by design, so the copy explains the fork instead of
 * accusing, and SIGNED_RTC_REFUSAL_NEXT_STEP carries the one safe exit.
 */
export const SIGNED_RTC_REFUSAL_DETAIL: Record<SignedRtcRefusalReason, string> = {
  host_key_substituted:
    "This host answered with a different identity than the one this device approved. Either the host's software was reinstalled — a reinstall gives it a new identity — or something between you and the host is impersonating it. This device won't connect either way.",
  host_key_revoked:
    "You removed this host's approved identity from this device. Possess it again from its terminal to reconnect.",
  host_key_withheld:
    "The server presented no identity for this host, but this device holds an approved one for it. Connection blocked.",
  browser_identity_unavailable:
    "This browser has no signing identity for your account, so it cannot make a verified connection to this approved host.",
  pin_storage_error:
    "This device's saved host approvals could not be read; connection blocked to stay safe.",
};

/**
 * The safe next step for a refusal that has one. For `host_key_substituted`
 * it is deliberately the full re-verification ceremony — remove, then possess
 * again from the host's own terminal — NEVER an accept-the-new-key shortcut:
 * accepting in place is precisely what an impersonator needs.
 */
export const SIGNED_RTC_REFUSAL_NEXT_STEP: Partial<Record<SignedRtcRefusalReason, string>> = {
  host_key_substituted:
    "If you reinstalled this host yourself, remove it here, then run `spawnd possess` in its terminal — possessing it again is the re-verification.",
  host_key_revoked: "Run `spawnd possess` in the host's terminal to verify it fresh.",
};

/**
 * The trust decision for one live RTC connection generation.
 * - `signed`   — offers are signed with this browser's identity. Either a
 *   local pin matched (host fully verified), or the host is unpinned and the
 *   capability anchors on the server's claimed key ("signed TOFU": the daemon
 *   can authenticate this browser — mandatory under enforcement — while our
 *   verification of the host is first-contact material, exactly as trusting
 *   a raw TOFU connection was, except the answer must now verify at all).
 * - `unpinned` — this host has never been approved AND no signed session is
 *   possible (no claimed key, or no local identity); raw TOFU first-contact
 *   is acceptable (unchanged legacy behavior).
 * - `refuse`   — the host is (or may be) pinned but cannot be verified; the
 *   caller must NOT connect, signed or raw.
 */
export type SignedRtcTrustDecision =
  | {
      readonly mode: "signed";
      readonly capability: SignedRtcTrustCapability;
      /**
       * True when the capability anchors on a locally approved pin — the host
       * is fully verified. False for signed TOFU, where the daemon
       * authenticates this browser but our knowledge of the host key is
       * first-contact material. Surfaced so the UI can tell the two apart.
       */
      readonly hostVerified: boolean;
    }
  | { readonly mode: "unpinned" }
  | { readonly mode: "refuse"; readonly reason: SignedRtcRefusalReason };

export interface ResolveSignedRtcTrustInput {
  readonly accountId: string;
  readonly hostId: string;
  /** Host public key as CLAIMED by the (untrusted) server Host API; may be
   * null. Its fingerprint is always derived locally from this key (mesh B5)
   * — the server serves no fingerprint and none would be accepted here. */
  readonly claimedHostPublicKey: string | null;
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
 * must be signed, may be raw, or must be refused. The server's claimed key is
 * an untrusted input — a pin match is required to trust it, and its absence or
 * divergence for an already-pinned host is a downgrade signal, not a reason to
 * fall back to raw.
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
  return { mode: "signed", capability, hostVerified: true };
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
    case "null_key": {
      // The server's claimed key is not (or not yet) an approved pin. That is a
      // legitimate unpinned/TOFU host UNLESS this hostId is already locally
      // pinned — in which case a null/absent/foreign key is a downgrade attempt
      // and the connection must be refused.
      if (await hostIdIsLocallyPinned(input, origin)) {
        return {
          mode: "refuse",
          reason: error.code === "null_key" ? "host_key_withheld" : "host_key_substituted",
        };
      }
      return await signedTofuOrUnpinned(input);
    }
    default:
      // invalid_account, invalid_host_id, storage_failure, corrupt_record, etc.
      // None can authorize a raw connection to a keyed host: fail closed.
      return { mode: "refuse", reason: "pin_storage_error" };
  }
}

/**
 * A never-pinned host used to mean raw TOFU — which enforcement-enabled
 * daemons refuse, stranding devices that ARE trusted daemon-side (endorsed)
 * but hold no local pin yet. When this browser has a signing identity and the
 * server claims a parseable host key, sign anyway: the daemon authenticates
 * this browser, and the answer must verify against the claimed key (raw
 * checked nothing). The claimed key remains untrusted first-contact material
 * — this path never creates, binds, or reactivates any local pin, and every
 * pinned-host refusal above is unaffected. If the server lied about the key,
 * the real daemon's envelope check fails and no connection forms.
 */
async function signedTofuOrUnpinned(
  input: ResolveSignedRtcTrustInput,
): Promise<SignedRtcTrustDecision> {
  const claimed = input.claimedHostPublicKey;
  if (claimed === null) return { mode: "unpinned" };
  try {
    decodeEd25519PublicKeyWire(claimed);
  } catch {
    return { mode: "unpinned" };
  }
  let identity: BrowserDeviceIdentity | null;
  try {
    identity = await loadBrowserDeviceIdentity(input.accountId, input.deviceIdentityStorage ?? {});
  } catch {
    return { mode: "unpinned" };
  }
  if (identity === null) return { mode: "unpinned" };

  const signer = identity;
  const capability: SignedRtcTrustCapability = {
    browserPublicKeyWire: signer.publicKeyWire,
    hostPublicKeyWire: claimed,
    signOffer: (signalInput) => signRtcSignalWire(signer, signalInput),
    assertActive: () => {
      if (!input.isActive()) {
        throw new Error("signed RTC trust epoch is no longer active");
      }
    },
  };
  return { mode: "signed", capability, hostVerified: false };
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
