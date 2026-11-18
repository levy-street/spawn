import { expect, spyOn, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import vectors from "../../../proto/support-log-consent-v1-vectors.json";
import fixture from "../../../proto/support-log-copy.json";
import copy from "./support-log-copy.json";

test("Account uses the shared diagnostic log copy", () => expect(copy).toEqual(fixture));

for (const { consent, transcript_hex, signing_seed_hex } of vectors.positive) {
  test(`bounded browser proof matches the sharing=${consent.enabled} vector and binds every byte`, async () => {
    // Both vectors use the same account and time. Each needs a fresh app instance.
    delete require.cache[require.resolve("./support-log-consent")];
    delete require.cache[require.resolve("./browser-device-identity")];
    const { adoptBrowserDeviceIdentity, signSupportLogConsent } =
      require("./browser-device-identity") as typeof import("./browser-device-identity");
    const { checkedConsentTime, encodeSupportLogConsent } =
      require("./support-log-consent") as typeof import("./support-log-consent");
    const { signal } = new AbortController();
    const clock = spyOn(Date, "now").mockReturnValue(consent.issued_at_ms);
    try {
      for (const delta of [-86_400_000, 86_400_000]) {
        expect(checkedConsentTime(consent.issued_at_ms + delta, consent.account_id)).toBe(
          consent.issued_at_ms + delta,
        );
      }
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
      if (!consent.enabled) {
        const cryptoSign = spyOn(crypto.subtle, "sign").mockRejectedValueOnce(
          new Error("Sign failed"),
        );
        try {
          await expect(signSupportLogConsent(identity, consent, signal)).rejects.toThrow(
            "Sign failed",
          );
        } finally {
          cryptoSign.mockRestore();
        }
      } else {
        const closing = new AbortController();
        const pending = signSupportLogConsent(identity, consent, closing.signal);
        closing.abort();
        await expect(pending).rejects.toThrow("Panel closed");
      }
      expect(await signSupportLogConsent(identity, consent, signal)).toBe(consent.signature);
      const signature = new Uint8Array(Buffer.from(consent.signature, "base64url"));
      const verify = () => crypto.subtle.verify("Ed25519", identity.publicKey, signature, bytes);
      expect(await verify()).toBe(true);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] ^= 1;
        expect(await verify()).toBe(false);
        bytes[i] ^= 1;
      }
      for (const time of [
        consent.issued_at_ms,
        consent.issued_at_ms - 1,
        consent.issued_at_ms - 86_400_001,
        consent.issued_at_ms + 86_400_001,
        Number.MAX_SAFE_INTEGER + 1,
        consent.issued_at_ms + 0.5,
      ]) {
        await expect(
          signSupportLogConsent(identity, { ...consent, issued_at_ms: time }, signal),
        ).rejects.toThrow();
      }
      const overlapping = await Promise.allSettled(
        [2, 2, 1].map((delta) =>
          signSupportLogConsent(
            identity,
            {
              ...consent,
              issued_at_ms: consent.issued_at_ms + delta,
            },
            signal,
          ),
        ),
      );
      expect(overlapping.map((result) => result.status)).toEqual([
        "fulfilled",
        "rejected",
        "rejected",
      ]);
    } finally {
      clock.mockRestore();
    }
  });
}
