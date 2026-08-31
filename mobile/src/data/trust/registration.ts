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

function validateLabel(label: string | null): void {
  if (label !== null && (label.length < 1 || label.length > 64)) {
    throw new DeviceRegistrationError(
      "REGISTRATION_REJECTED",
      "Device label must contain 1 through 64 characters",
    );
  }
}

export async function ensureDeviceRegistered(input: {
  accountId: string;
  label: string | null;
  api?: DeviceRegistrationApi;
}): Promise<BrowserDeviceRecord> {
  validateLabel(input.label);
  setDeviceIdentityAccount(input.accountId);
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
  } catch {
    throw new DeviceRegistrationError("REGISTRATION_REJECTED", "Device registration was rejected");
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
  /** What went wrong, as a complete sentence. */
  readonly reason: string;
  /** What would change it, where anything the reader controls would. */
  readonly remedy: string | null;
  /** Whether registering again could succeed without the reader doing anything. */
  readonly canRetry: boolean;
}

export function describeDeviceRegistrationFailure(error: unknown): DeviceRegistrationFailure {
  if (error instanceof DeviceIdentityError) {
    switch (error.code) {
      case "IDENTITY_STORAGE_UNAVAILABLE":
        return {
          reason: "This device could not save SPAWN D's key.",
          remedy: null,
          canRetry: true,
        };
      case "IDENTITY_CORRUPT":
        return {
          reason: "The key this device saved for SPAWN D is unreadable.",
          remedy: null,
          canRetry: false,
        };
      case "IDENTITY_ABSENT":
        return {
          reason: "SPAWN D's key is not ready on this device yet.",
          remedy: null,
          canRetry: true,
        };
    }
  }
  if (error instanceof DeviceRegistrationError) {
    return error.code === "REGISTRATION_MISMATCH"
      ? {
          reason: "The server answered with a different key than this device sent.",
          remedy: null,
          canRetry: false,
        }
      : { reason: "The server refused this device's identity.", remedy: null, canRetry: true };
  }
  return {
    reason: "This device's identity could not be registered.",
    remedy: null,
    canRetry: true,
  };
}

/** The failure as one line, for a surface with nowhere to put a second one. */
export function deviceRegistrationFailureLine(error: unknown): string {
  const failure = describeDeviceRegistrationFailure(error);
  return failure.remedy === null ? failure.reason : `${failure.reason} ${failure.remedy}`;
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
