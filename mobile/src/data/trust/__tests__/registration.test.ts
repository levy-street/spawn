import * as SecureStore from "expo-secure-store";

import { ApiError } from "@/data/api/client";
import type { BrowserDeviceRegisterRequest } from "@/data/api/schemas/devices";
import {
  describeDeviceRegistrationFailure,
  deviceRegistrationRefusalCode,
  ensureDeviceRegistered,
} from "@/data/trust/registration";
import { clearDeviceIdentityAccount } from "@/lib/crypto/identity";

let mockRandomOffset = 0;
jest.mock("expo-crypto", () => ({
  getRandomValues: jest.fn((bytes: Uint8Array) => {
    mockRandomOffset += 1;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index + mockRandomOffset;
    }
    return bytes;
  }),
}));

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const DEVICE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("device registration recovery", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    mockRandomOffset = 0;
    values.clear();
    clearDeviceIdentityAccount();
    jest
      .mocked(SecureStore.getItemAsync)
      .mockImplementation(async (key) => values.get(key) ?? null);
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      values.set(key, value);
    });
    jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      values.delete(key);
    });
  });

  test("rotates a tombstoned key once and resumes with the fresh registered identity", async () => {
    const publicKeys: string[] = [];
    const registerBrowserDevice = jest.fn(async (request: BrowserDeviceRegisterRequest) => {
      publicKeys.push(request.public_key);
      if (publicKeys.length === 1) {
        throw new ApiError(
          409,
          "device_key_revoked",
          "revoked browser public keys cannot be registered again",
        );
      }
      return {
        id: DEVICE_ID,
        key_algorithm: "ed25519" as const,
        public_key: request.public_key,
        label: request.label ?? null,
        created_at: "2026-08-22T00:00:00Z",
        revoked_at: null,
      };
    });

    const result = await ensureDeviceRegistered({
      accountId: ACCOUNT_ID,
      label: "SPAWN D on iPhone",
      api: { registerBrowserDevice, revokeBrowserDevice: jest.fn() },
    });

    expect(registerBrowserDevice).toHaveBeenCalledTimes(2);
    expect(publicKeys[1]).not.toBe(publicKeys[0]);
    expect(result).toMatchObject({
      id: DEVICE_ID,
      identityRecovery: "device_key_revoked",
      public_key: publicKeys[1],
    });
  });

  test("preserves non-revocation ApiErrors for the session and refusal paths", async () => {
    const refusal = new ApiError(
      409,
      "device_key_owned_by_other_account",
      "browser public key is unavailable",
    );
    await expect(
      ensureDeviceRegistered({
        accountId: ACCOUNT_ID,
        label: "SPAWN D on iPhone",
        api: {
          registerBrowserDevice: jest.fn(async () => {
            throw refusal;
          }),
          revokeBrowserDevice: jest.fn(),
        },
      }),
    ).rejects.toBe(refusal);
  });
});

describe("registration failure fidelity", () => {
  test.each([
    "device_key_revoked",
    "device_key_owned_by_other_account",
    "root_designation_mismatch",
    "root_already_exists",
    "registration_proof_invalid",
  ] as const)("keeps the %s contract state distinct", (code) => {
    expect(describeDeviceRegistrationFailure(new ApiError(409, code, code)).kind).toBe(code);
  });

  test("prefers contract codes and maps old-server refusal text", () => {
    const coded = new ApiError(409, "root_already_exists", "root already exists");
    const legacy = new ApiError(
      409,
      "http_409",
      "revoked browser public keys cannot be registered again",
      "revoked browser public keys cannot be registered again",
    );

    expect(deviceRegistrationRefusalCode(coded)).toBe("root_already_exists");
    expect(deviceRegistrationRefusalCode(legacy)).toBe("device_key_revoked");
    expect(describeDeviceRegistrationFailure(coded)).toMatchObject({
      kind: "root_already_exists",
      canRetry: false,
      canStartFresh: true,
    });
  });

  test("keeps network and expired-session failures out of identity-refusal copy", () => {
    const network = describeDeviceRegistrationFailure(
      new ApiError(0, "network_error", "Network request failed"),
    );
    const expired = describeDeviceRegistrationFailure(
      new ApiError(401, "http_401", "Unauthorized"),
    );

    expect(network).toMatchObject({
      kind: "network_unavailable",
      title: "Can't reach the server",
      canRetry: true,
    });
    expect(`${network.reason} ${network.remedy}`).not.toMatch(/refused/i);
    expect(expired).toMatchObject({
      kind: "session_expired",
      canRetry: false,
      canStartFresh: false,
    });
  });
});
