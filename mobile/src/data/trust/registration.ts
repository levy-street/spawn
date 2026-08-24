import { registerBrowserDevice, revokeBrowserDevice } from "@/data/api/endpoints/devices";
import type {
  BrowserDeviceOut,
  BrowserDeviceRegisterRequest,
  BrowserDeviceRevokeRequest,
} from "@/data/api/schemas/devices";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deviceIdentity, setDeviceIdentityAccount } from "@/lib/crypto/identity";

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
