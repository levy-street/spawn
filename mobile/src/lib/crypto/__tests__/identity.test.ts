import * as SecureStore from "expo-secure-store";

import { encodeBase64Url } from "@/lib/crypto/bytes";
import { verifyPureEd25519Strict } from "@/lib/crypto/ed25519";
import * as identityModule from "@/lib/crypto/identity";
import {
  clearDeviceIdentityAccount,
  deviceIdentity,
  setDeviceIdentityAccount,
} from "@/lib/crypto/identity";
import { encodeSignedSignalV2 } from "@/lib/crypto/signed-signal";

jest.mock("expo-crypto", () => ({
  getRandomValues: jest.fn((bytes: Uint8Array) => {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
    return bytes;
  }),
}));

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const PEER_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

describe("deviceIdentity", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    jest.clearAllMocks();
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

  test("generates once, signs a bounded signal, and reloads", async () => {
    setDeviceIdentityAccount(ACCOUNT_ID);
    const first = await deviceIdentity.ensure();
    const second = await deviceIdentity.ensure();
    expect(second.publicKey).toEqual(first.publicKey);
    expect(second.deviceId).toBe(first.deviceId);

    const transcript = {
      signalKind: "offer" as const,
      protocolVersion: 2,
      sessionId: "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1",
      scopeType: "session" as const,
      scopeId: "11111111-2222-4333-8444-555555555555",
      senderRole: "browser" as const,
      intendedPeerPublicKey: PEER_KEY,
      sdp: "v=0\r\n",
    };
    const signature = await deviceIdentity.signSignalTranscript(transcript);
    expect(
      verifyPureEd25519Strict(first.publicKey, encodeSignedSignalV2(transcript), signature),
    ).toBe(true);
    expect(encodeBase64Url(first.publicKey)).toHaveLength(43);
  });

  test("serializes concurrent first use to one durable winner", async () => {
    setDeviceIdentityAccount(ACCOUNT_ID);
    const [left, right] = await Promise.all([deviceIdentity.ensure(), deviceIdentity.ensure()]);
    expect(left.publicKey).toEqual(right.publicKey);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  test("reset clears identity and dependent registration state", async () => {
    setDeviceIdentityAccount(ACCOUNT_ID);
    await deviceIdentity.ensure();
    await deviceIdentity.reset();
    expect(values.size).toBe(0);
    await expect(deviceIdentity.ensure()).rejects.toMatchObject({ code: "IDENTITY_ABSENT" });
  });

  test("fails closed on a corrupt durable record", async () => {
    setDeviceIdentityAccount(ACCOUNT_ID);
    values.set(`spawn.identity.ed25519.v1.${ACCOUNT_ID}`, "{}");
    await expect(deviceIdentity.ensure()).rejects.toMatchObject({ code: "IDENTITY_CORRUPT" });
  });

  test("does not export a seed or generic signer", () => {
    const exports = Object.keys(identityModule);
    expect(exports).not.toContain("exportSeed");
    expect(exports).not.toContain("getSeed");
    expect(exports).not.toContain("sign");
    expect(Object.keys(deviceIdentity)).not.toContain("exportSeed");
    expect(Object.keys(deviceIdentity)).not.toContain("sign");
  });
});
