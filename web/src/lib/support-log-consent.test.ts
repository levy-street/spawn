import { expect, spyOn, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import vectors from "../../../proto/support-log-consent-v1-vectors.json";
import fixture from "../../../proto/support-log-copy.json";
import { adoptBrowserDeviceIdentity, signSupportLogConsent } from "./browser-device-identity";
import { checkedConsentTime, encodeSupportLogConsent } from "./support-log-consent";
import copy from "./support-log-copy.json";

test("Account uses the shared diagnostic log copy", () => expect(copy).toEqual(fixture));

for (const { consent, transcript_hex, signing_seed_hex } of vectors.positive) {
  test(`bounded browser proof matches the sharing=${consent.enabled} vector and binds every byte`, async () => {
    const clock = spyOn(Date, "now").mockReturnValue(consent.issued_at_ms);
    try {
      const bytes = encodeSupportLogConsent(consent);
      expect(Buffer.from(bytes).toString("hex")).toBe(transcript_hex);
      const { identity } = await adoptBrowserDeviceIdentity(
        consent.account_id,
        {
          seed: new Uint8Array(Buffer.from(signing_seed_hex, "hex")),
          publicKeyWire: consent.signer_public_key,
        },
        { indexedDBFactory: new IDBFactory() },
      );
      expect(await signSupportLogConsent(identity, consent)).toBe(consent.signature);
      const signature = new Uint8Array(Buffer.from(consent.signature, "base64url"));
      const verify = () => crypto.subtle.verify("Ed25519", identity.publicKey, signature, bytes);
      expect(await verify()).toBe(true);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] ^= 1;
        expect(await verify()).toBe(false);
        bytes[i] ^= 1;
      }
      for (const delta of [-86_400_000, 86_400_000]) {
        expect(checkedConsentTime(consent.issued_at_ms + delta, consent.account_id)).toBe(
          consent.issued_at_ms + delta,
        );
      }
      for (const time of [
        consent.issued_at_ms - 86_400_001,
        consent.issued_at_ms + 86_400_001,
        Number.MAX_SAFE_INTEGER + 1,
        consent.issued_at_ms + 0.5,
      ]) {
        await expect(
          signSupportLogConsent(identity, { ...consent, issued_at_ms: time }),
        ).rejects.toThrow();
      }
    } finally {
      clock.mockRestore();
    }
  });
}
