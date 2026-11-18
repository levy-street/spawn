import copy from "@/components/settings/support-log-copy.json";
import { secureStorage } from "@/lib/secure-storage";
import vectors from "../../../../../proto/support-log-consent-v1-vectors.json";
import fixture from "../../../../../proto/support-log-copy.json";
import { decodeBase64Url, decodeHex, encodeBase64Url, encodeHex } from "../bytes";
import { verifyPureEd25519Strict } from "../ed25519";
import { clearDeviceIdentityAccount, deviceIdentity, setDeviceIdentityAccount } from "../identity";
import { checkedConsentTime, encodeSupportLogConsent } from "../support-log-consent";

test("Account uses the shared diagnostic log copy", () => expect(copy).toEqual(fixture));

afterEach(() => {
  clearDeviceIdentityAccount();
  jest.restoreAllMocks();
});

for (const { consent, transcript_hex, signing_seed_hex } of vectors.positive) {
  test(`bounded phone proof matches the sharing=${consent.enabled} vector and binds every byte`, async () => {
    jest.spyOn(Date, "now").mockReturnValue(consent.issued_at_ms);
    setDeviceIdentityAccount(consent.account_id);
    jest.spyOn(secureStorage, "get").mockResolvedValue(
      JSON.stringify({
        version: 1,
        accountId: consent.account_id,
        secretKey: encodeBase64Url(decodeHex(signing_seed_hex)),
        publicKey: consent.signer_public_key,
      }),
    );
    const bytes = encodeSupportLogConsent(consent);
    expect(encodeHex(bytes)).toBe(transcript_hex);
    const signature = await deviceIdentity.signSupportLogConsent(consent);
    expect(encodeBase64Url(signature)).toBe(consent.signature);
    const pub = decodeBase64Url(consent.signer_public_key);
    expect(verifyPureEd25519Strict(pub, bytes, signature)).toBe(true);
    for (const [i, value] of bytes.entries()) {
      bytes[i] = value ^ 1;
      expect(verifyPureEd25519Strict(pub, bytes, signature)).toBe(false);
      bytes[i] = value;
    }
    for (const delta of [-86_400_000, 86_400_000]) {
      expect(checkedConsentTime(consent.issued_at_ms + delta)).toBe(consent.issued_at_ms + delta);
    }
    for (const time of [
      consent.issued_at_ms - 86_400_001,
      consent.issued_at_ms + 86_400_001,
      Number.MAX_SAFE_INTEGER + 1,
      consent.issued_at_ms + 0.5,
    ]) {
      await expect(
        deviceIdentity.signSupportLogConsent({ ...consent, issued_at_ms: time }),
      ).rejects.toThrow();
    }
  });
}
