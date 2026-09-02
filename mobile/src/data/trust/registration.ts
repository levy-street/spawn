import { ApiError } from "@/data/api/client";
import { registerBrowserDevice, revokeBrowserDevice } from "@/data/api/endpoints/devices";
import type {
  BrowserDeviceOut,
  BrowserDeviceRegisterRequest,
  BrowserDeviceRevokeRequest,
} from "@/data/api/schemas/devices";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import {
  DeviceIdentityError,
  deviceIdentity,
  setDeviceIdentityAccount,
} from "@/lib/crypto/identity";

export type BrowserDeviceRecord = BrowserDeviceOut;

/**
 * Why the server refused to register this phone's key. Newer servers say it
 * outright in a top-level `code`; the ones deployed before that field existed
 * only say it in the 409/422 detail text, which `deviceRegistrationRefusalCode`
 * reads the same way the web app does.
 */
export type DeviceRegistrationRefusalCode =
  | "device_key_revoked"
  | "device_key_owned_by_other_account"
  | "root_designation_mismatch"
  | "root_already_exists"
  | "registration_proof_invalid";

export type RegisteredPhone = BrowserDeviceRecord & {
  /** Local-only context; never sent to or accepted from the server. */
  readonly identityRecovery?: "device_key_revoked";
};

export interface DeviceRegistrationApi {
  registerBrowserDevice(input: BrowserDeviceRegisterRequest): Promise<BrowserDeviceRecord>;
  revokeBrowserDevice(
    deviceId: string,
    input: BrowserDeviceRevokeRequest,
  ): Promise<BrowserDeviceRecord>;
}

const endpointApi: DeviceRegistrationApi = { registerBrowserDevice, revokeBrowserDevice };

export class DeviceRegistrationError extends Error {
  constructor(
    readonly code: "REGISTRATION_REJECTED" | "REGISTRATION_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "DeviceRegistrationError";
  }
}

const REGISTRATION_REFUSAL_CODES = new Set<DeviceRegistrationRefusalCode>([
  "device_key_revoked",
  "device_key_owned_by_other_account",
  "root_designation_mismatch",
  "root_already_exists",
  "registration_proof_invalid",
]);

function refusalDetail(error: ApiError): string {
  const candidates = [
    error.message,
    typeof error.detail === "string" ? error.detail : "",
    ...(typeof error.detail === "object" && error.detail !== null
      ? Object.values(error.detail).filter((value): value is string => typeof value === "string")
      : []),
  ];
  return candidates.join(" ").toLowerCase();
}

/**
 * Read the refusal discriminator, with a narrow compatibility bridge for
 * servers deployed before the top-level `code` field existed.
 */
export function deviceRegistrationRefusalCode(
  error: unknown,
): DeviceRegistrationRefusalCode | null {
  if (!(error instanceof ApiError)) return null;
  if (REGISTRATION_REFUSAL_CODES.has(error.code as DeviceRegistrationRefusalCode)) {
    return error.code as DeviceRegistrationRefusalCode;
  }

  const detail = refusalDetail(error);
  if (error.status === 409) {
    if (detail.includes("revoked") && detail.includes("key")) return "device_key_revoked";
    if (
      detail.includes("public key is unavailable") ||
      detail.includes("another account") ||
      detail.includes("other account")
    ) {
      return "device_key_owned_by_other_account";
    }
    if (detail.includes("root designation")) return "root_designation_mismatch";
    if (detail.includes("root") && detail.includes("already")) return "root_already_exists";
  }
  if (error.status === 422) return "registration_proof_invalid";
  return null;
}

function validateLabel(label: string | null): void {
  if (label !== null && (label.length < 1 || label.length > 64)) {
    throw new DeviceRegistrationError(
      "REGISTRATION_REJECTED",
      "Device label must contain 1 through 64 characters",
    );
  }
}

async function registerCurrentIdentity(input: {
  accountId: string;
  label: string | null;
  api?: DeviceRegistrationApi;
}): Promise<BrowserDeviceRecord> {
  const identity = await deviceIdentity.ensure();
  const publicKey = encodeBase64Url(identity.publicKey);
  const signature = await deviceIdentity.signRegistration({
    accountId: input.accountId,
    browserPublicKey: publicKey,
    // A phone is an ordinary device, never the account root; the claim is
    // bound inside the signed V2 transcript, so it cannot be flipped later.
    isRoot: false,
  });
  let registered: BrowserDeviceRecord;
  try {
    registered = await (input.api ?? endpointApi).registerBrowserDevice({
      label: input.label,
      key_algorithm: "ed25519",
      public_key: publicKey,
      signature: encodeBase64Url(signature),
    });
  } finally {
    signature.fill(0);
  }
  if (
    registered.key_algorithm !== "ed25519" ||
    registered.public_key !== publicKey ||
    registered.revoked_at !== null
  ) {
    throw new DeviceRegistrationError(
      "REGISTRATION_MISMATCH",
      "Registered device does not match the local identity",
    );
  }
  return registered;
}

export async function ensureDeviceRegistered(input: {
  accountId: string;
  label: string | null;
  api?: DeviceRegistrationApi;
}): Promise<RegisteredPhone> {
  validateLabel(input.label);
  setDeviceIdentityAccount(input.accountId);
  try {
    return await registerCurrentIdentity(input);
  } catch (error) {
    // A revoked key is a permanent tombstone (R10): nothing this phone does
    // can ever register it again, and the keychain keeps it across sign-outs
    // and reinstalls, so without this the app is stuck on a Try again that can
    // never succeed. Healing is safe without asking — a fresh key grants
    // nothing on its own; it is an ordinary unapproved device until a trusted
    // one endorses it — so delete only this account's phone identity, mint a
    // new key, and let the ordinary approval machinery take over.
    if (deviceRegistrationRefusalCode(error) !== "device_key_revoked") throw error;
    await deviceIdentity.reset();
    setDeviceIdentityAccount(input.accountId);
    const registered = await registerCurrentIdentity(input);
    return { ...registered, identityRecovery: "device_key_revoked" };
  }
}

/**
 * Why registration failed, said in a way the reader can do something about.
 *
 * The screens used to print whatever `Error.message` they were handed, which
 * is internal vocabulary — "Device identity record is not an object" — and
 * always paired with a Try again that some of those causes will never answer.
 * The web app says the same things about a browser (see
 * `describeBrowserDeviceRegistrationFailure`); the cause is kept apart from
 * the remedy so each surface can put its own consequence between them.
 */
export interface DeviceRegistrationFailure {
  readonly kind:
    | DeviceRegistrationRefusalCode
    | "identity_storage_unavailable"
    | "identity_corrupt"
    | "identity_absent"
    | "registration_mismatch"
    | "session_expired"
    | "network_unavailable"
    | "server_unavailable"
    | "registration_rejected";
  /** Short heading for a surface that has room for one. */
  readonly title: string;
  /** What went wrong, as a complete sentence. */
  readonly reason: string;
  /** What would change it, where anything the reader controls would. */
  readonly remedy: string | null;
  /** Whether registering again could succeed without the reader doing anything. */
  readonly canRetry: boolean;
  /** Whether replacing only this phone's saved identity can resolve the cause. */
  readonly canStartFresh: boolean;
  /** Whether leaving this account is a meaningful alternative. */
  readonly canSignOut: boolean;
}

export function describeDeviceRegistrationFailure(error: unknown): DeviceRegistrationFailure {
  if (error instanceof DeviceIdentityError) {
    switch (error.code) {
      case "IDENTITY_STORAGE_UNAVAILABLE":
        return {
          kind: "identity_storage_unavailable",
          title: "Identity storage is unavailable",
          reason: "This phone could not save SPAWN D's identity key.",
          remedy: null,
          canRetry: true,
          canStartFresh: false,
          canSignOut: false,
        };
      case "IDENTITY_CORRUPT":
        return {
          kind: "identity_corrupt",
          title: "This phone's saved identity is unreadable",
          reason: "The key this phone saved for SPAWN D is unreadable, so it can't be used again.",
          remedy: "Start fresh to replace it.",
          canRetry: false,
          canStartFresh: true,
          canSignOut: false,
        };
      case "IDENTITY_ABSENT":
        return {
          kind: "identity_absent",
          title: "This phone's identity is not ready",
          reason: "SPAWN D's identity is not ready on this phone yet.",
          remedy: null,
          canRetry: true,
          canStartFresh: false,
          canSignOut: false,
        };
    }
  }
  const refusal = deviceRegistrationRefusalCode(error);
  switch (refusal) {
    case "device_key_revoked":
      // Reached only when the automatic heal above itself failed; the reader
      // can still force the same replacement by hand.
      return {
        kind: refusal,
        title: "This phone's old identity was retired",
        reason:
          "A phone removed from this account can never return with the same key — that's what makes removal final.",
        remedy: "Start fresh to give this phone a new identity, then approve it again.",
        canRetry: false,
        canStartFresh: true,
        canSignOut: false,
      };
    case "device_key_owned_by_other_account":
      return {
        kind: refusal,
        title: "This identity belongs to another account",
        reason: "This phone's saved SPAWN D identity is already attached to another account.",
        remedy: "Sign out to use that account, or start fresh on this phone for this one.",
        canRetry: false,
        canStartFresh: true,
        canSignOut: true,
      };
    case "root_designation_mismatch":
      return {
        kind: refusal,
        title: "This identity has a different account role",
        reason: "The server already knows this key with a different root designation.",
        remedy: "Start fresh to register this phone with a new identity.",
        canRetry: false,
        canStartFresh: true,
        canSignOut: false,
      };
    case "root_already_exists":
      return {
        kind: refusal,
        title: "This account already has a root identity",
        reason: "The server would not register this phone as another root identity.",
        remedy: "Start fresh to register this phone as an ordinary device.",
        canRetry: false,
        canStartFresh: true,
        canSignOut: false,
      };
    case "registration_proof_invalid":
      return {
        kind: refusal,
        title: "This phone could not prove its identity",
        reason: "The server could not verify that this phone owns its saved identity key.",
        remedy: "Start fresh to replace the key and try approval again.",
        canRetry: false,
        canStartFresh: true,
        canSignOut: false,
      };
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        kind: "session_expired",
        title: "Your session expired",
        reason: "Your SPAWN D session expired.",
        remedy: "Sign in again to continue.",
        canRetry: false,
        canStartFresh: false,
        canSignOut: true,
      };
    }
    if (error.status === 0 || error.code === "network_error" || error.code === "timeout") {
      return {
        kind: "network_unavailable",
        title: "Can't reach the server",
        reason: "SPAWN D couldn't reach the server.",
        remedy: "Check your connection and try again.",
        canRetry: true,
        canStartFresh: false,
        canSignOut: false,
      };
    }
    if (error.status >= 500 || error.code === "schema_mismatch") {
      return {
        kind: "server_unavailable",
        title: "The server couldn't register this phone",
        reason: "The server couldn't register this phone right now.",
        remedy: "Try again in a moment.",
        canRetry: true,
        canStartFresh: false,
        canSignOut: false,
      };
    }
    return {
      kind: "registration_rejected",
      title: "This phone could not be registered",
      reason: "The server refused this phone's identity.",
      remedy: null,
      canRetry: error.status !== 409,
      canStartFresh: error.status === 409 || error.status === 422,
      canSignOut: false,
    };
  }
  if (error instanceof DeviceRegistrationError) {
    return error.code === "REGISTRATION_MISMATCH"
      ? {
          kind: "registration_mismatch",
          title: "The server returned a different identity",
          reason: "The server answered with a different key than this phone sent.",
          remedy: null,
          canRetry: false,
          canStartFresh: true,
          canSignOut: false,
        }
      : {
          kind: "registration_rejected",
          title: "This phone could not be registered",
          reason: "This phone's identity could not be registered.",
          remedy: null,
          canRetry: true,
          canStartFresh: false,
          canSignOut: false,
        };
  }
  return {
    kind: "registration_rejected",
    title: "This phone could not be registered",
    reason: "This phone's identity could not be registered.",
    remedy: null,
    canRetry: true,
    canStartFresh: false,
    canSignOut: false,
  };
}

/** The failure as one line, for a surface with nowhere to put a second one. */
export function deviceRegistrationFailureLine(error: unknown): string {
  const failure = describeDeviceRegistrationFailure(error);
  return failure.remedy === null ? failure.reason : `${failure.reason} ${failure.remedy}`;
}

/** Replace only the active account's phone identity; server/account data stays intact. */
export async function startFreshDeviceIdentity(accountId: string): Promise<void> {
  setDeviceIdentityAccount(accountId);
  await deviceIdentity.reset();
  // Keep account-bound callers usable until the registration query mints the
  // replacement. AuthGate's binding intentionally survives this local reset.
  setDeviceIdentityAccount(accountId);
}

export async function revokeThisDevice(input: {
  deviceId: string;
  api?: DeviceRegistrationApi;
}): Promise<void> {
  const publicKeyBytes = await deviceIdentity.publicKey();
  if (publicKeyBytes === null) {
    throw new DeviceRegistrationError("REGISTRATION_REJECTED", "Device identity is unavailable");
  }
  const publicKey = encodeBase64Url(publicKeyBytes);
  let revoked: BrowserDeviceRecord;
  try {
    revoked = await (input.api ?? endpointApi).revokeBrowserDevice(input.deviceId, {
      expected_public_key: publicKey,
    });
  } catch {
    throw new DeviceRegistrationError("REGISTRATION_REJECTED", "Device revocation was rejected");
  }
  if (
    revoked.id !== input.deviceId ||
    revoked.public_key !== publicKey ||
    revoked.revoked_at === null
  ) {
    throw new DeviceRegistrationError(
      "REGISTRATION_MISMATCH",
      "Revocation response does not match this device",
    );
  }
  await deviceIdentity.reset();
}
