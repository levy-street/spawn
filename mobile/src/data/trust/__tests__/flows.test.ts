import * as SecureStore from "expo-secure-store";

import {
  acceptVerifiedEndorsement,
  passkeyPrfCapability,
  verifyEndorsementIntroduction,
} from "@/data/trust/endorsement";
import {
  createHostPinStore,
  formatHostFingerprint,
  type HostPin,
  type HostPinPersistence,
} from "@/data/trust/host-pins";
import { ensureDeviceRegistered } from "@/data/trust/registration";
import { decodeHex, encodeBase64Url } from "@/lib/crypto/bytes";
import { clearDeviceIdentityAccount } from "@/lib/crypto/identity";
import { signBrowserEndorsementV1 } from "@/lib/crypto/transcripts";

jest.mock("expo-crypto", () => ({
  getRandomValues: jest.fn((bytes: Uint8Array) => {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
    return bytes;
  }),
}));

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "11111111-2222-4333-8444-555555555555";
const DEVICE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORIGIN = "https://spawn.example";
const HOST_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const RFC_SEED = decodeHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const RFC_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

class MemoryPersistence implements HostPinPersistence {
  pins: HostPin[] = [];
  async load(): Promise<readonly unknown[]> {
    return this.pins;
  }
  async save(pin: HostPin): Promise<void> {
    this.pins = [pin];
  }
  async deleteAccount(): Promise<void> {
    this.pins = [];
  }
}

describe("trust registration and endorsement flows", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    clearDeviceIdentityAccount();
    jest
      .mocked(SecureStore.getItemAsync)
      .mockImplementation(async (key) => values.get(key) ?? null);
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      values.set(key, value);
    });
  });

  test("registers possession and requires the exact returned key", async () => {
    const registerBrowserDevice = jest.fn(async (request) => ({
      id: DEVICE_ID,
      key_algorithm: "ed25519" as const,
      public_key: request.public_key,
      fingerprint: formatHostFingerprint(request.public_key),
      label: request.label,
      created_at: "2026-08-22T00:00:00Z",
      revoked_at: null,
    }));
    const result = await ensureDeviceRegistered({
      accountId: ACCOUNT_ID,
      label: "spawn on iPhone",
      api: {
        registerBrowserDevice,
        revokeBrowserDevice: jest.fn(),
      },
    });
    expect(result.id).toBe(DEVICE_ID);
    expect(registerBrowserDevice).toHaveBeenCalledWith(
      expect.objectContaining({ key_algorithm: "ed25519", signature: expect.any(String) }),
    );
  });

  test("verifies an introduction before accepting its host pin", async () => {
    const input = {
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostId: HOST_ID,
      hostPublicKey: HOST_KEY,
      endorserDeviceId: "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
      endorserPublicKey: RFC_KEY,
      endorsedDeviceId: DEVICE_ID,
      endorsedPublicKey: HOST_KEY,
    };
    const signature = signBrowserEndorsementV1(RFC_SEED, {
      accountId: input.accountId,
      hostPublicKey: input.hostPublicKey,
      endorserPublicKey: input.endorserPublicKey,
      endorsedPublicKey: input.endorsedPublicKey,
      endorsedDeviceId: input.endorsedDeviceId,
    });
    const verified = verifyEndorsementIntroduction(
      { ...input, signature: encodeBase64Url(signature) },
      input.endorsedPublicKey,
    );
    const store = createHostPinStore(new MemoryPersistence());
    await expect(
      acceptVerifiedEndorsement({
        endorsement: verified,
        expectedEndorserFingerprint: verified.endorserFingerprint,
        pinStore: store,
      }),
    ).resolves.toMatchObject({ hostPublicKey: HOST_KEY, state: "active" });
  });

  test("reports passkey PRF as explicitly unavailable in Expo Go", () => {
    expect(passkeyPrfCapability.available).toBe(false);
    expect(passkeyPrfCapability.reason).toMatch(/Expo Go/);
  });
});
