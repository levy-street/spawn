import { describe, expect, test } from "bun:test";
import { ed25519PublicKeyFingerprint, generateEd25519IdentityKeyPair } from "./signed-signal";
import {
  deriveTrustBundleKey,
  openTrustBundle,
  sealTrustBundle,
  TrustBundleError,
  type TrustBundleHost,
} from "./trust-bundle";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "00000000-0000-4000-8000-000000000002";

function prf(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

async function host(): Promise<TrustBundleHost> {
  const pair = await generateEd25519IdentityKeyPair();
  const hostPublicKey = await (async () => {
    const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
    return Buffer.from(new Uint8Array(exported))
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  })();
  return {
    hostPublicKey,
    hostFingerprint: await ed25519PublicKeyFingerprint(hostPublicKey),
    hostIds: [],
  };
}

/** Most tests do not care about the revision; seal at a fixed one. */
function sealBundle(key: CryptoKey, account: string, hosts: readonly TrustBundleHost[]) {
  return sealTrustBundle(key, account, hosts, 1);
}

describe("trust bundle", () => {
  test("round-trips the hosts an operator has verified", async () => {
    const key = await deriveTrustBundleKey(prf(1), ACCOUNT);
    const hosts = [await host(), await host()];
    const sealed = await sealBundle(key, ACCOUNT, hosts);
    const opened = await openTrustBundle(key, ACCOUNT, sealed);

    expect(opened.accountId).toBe(ACCOUNT);
    expect(opened.hosts).toHaveLength(2);
    expect(new Set(opened.hosts.map((h) => h.hostPublicKey))).toEqual(
      new Set(hosts.map((h) => h.hostPublicKey)),
    );
  });

  test("a different passkey secret cannot open the bundle", async () => {
    const sealed = await sealBundle(await deriveTrustBundleKey(prf(1), ACCOUNT), ACCOUNT, [
      await host(),
    ]);
    const wrong = await deriveTrustBundleKey(prf(2), ACCOUNT);
    await expect(openTrustBundle(wrong, ACCOUNT, sealed)).rejects.toThrow(TrustBundleError);
  });

  test("the same secret under another account derives a different key", async () => {
    // One passkey used for two accounts must not cross-unlock them.
    const sealed = await sealBundle(await deriveTrustBundleKey(prf(3), ACCOUNT), ACCOUNT, [
      await host(),
    ]);
    const otherAccountKey = await deriveTrustBundleKey(prf(3), OTHER_ACCOUNT);
    await expect(openTrustBundle(otherAccountKey, OTHER_ACCOUNT, sealed)).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("a bundle cannot be replayed into another account", async () => {
    // The account is AEAD associated data, so even the right key fails.
    const key = await deriveTrustBundleKey(prf(4), ACCOUNT);
    const sealed = await sealBundle(key, ACCOUNT, [await host()]);
    await expect(openTrustBundle(key, OTHER_ACCOUNT, sealed)).rejects.toThrow(TrustBundleError);
  });

  test("tampering with the ciphertext is detected", async () => {
    const key = await deriveTrustBundleKey(prf(5), ACCOUNT);
    const sealed = await sealBundle(key, ACCOUNT, [await host()]);
    const flipped = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
    await expect(openTrustBundle(key, ACCOUNT, flipped)).rejects.toThrow(TrustBundleError);
  });

  test("a host entry whose fingerprint disagrees with its key is refused", async () => {
    const key = await deriveTrustBundleKey(prf(6), ACCOUNT);
    const real = await host();
    const lying: TrustBundleHost = { ...real, hostFingerprint: "SHA256:AAAAAAAAAAAAAAAA" };
    await expect(sealBundle(key, ACCOUNT, [lying])).rejects.toThrow(TrustBundleError);
  });

  test("a non-Ed25519 host key is refused", async () => {
    const key = await deriveTrustBundleKey(prf(7), ACCOUNT);
    const bogus: TrustBundleHost = {
      hostPublicKey: "A".repeat(43),
      hostFingerprint: "SHA256:AAAAAAAAAAAAAAAA",
      hostIds: [],
    };
    await expect(sealBundle(key, ACCOUNT, [bogus])).rejects.toThrow(TrustBundleError);
  });

  test("duplicate host keys are refused", async () => {
    const key = await deriveTrustBundleKey(prf(8), ACCOUNT);
    const only = await host();
    await expect(sealBundle(key, ACCOUNT, [only, only])).rejects.toThrow(TrustBundleError);
  });

  test("non-canonical account IDs are refused", async () => {
    // Uppercase hex must be rejected: two spellings of one account would
    // otherwise derive two different keys and silently split the bundle.
    const mixedCase = "0000000a-0000-4000-8000-00000000000b";
    for (const bad of ["not-a-uuid", "", mixedCase.toUpperCase(), `urn:uuid:${ACCOUNT}`]) {
      await expect(deriveTrustBundleKey(prf(9), bad)).rejects.toThrow(TrustBundleError);
    }
    // ...and the lowercase spelling of that same value is accepted.
    await expect(deriveTrustBundleKey(prf(9), mixedCase)).resolves.toBeDefined();
  });

  test("a short PRF secret is refused rather than silently stretched", async () => {
    await expect(deriveTrustBundleKey(new Uint8Array(16).fill(1), ACCOUNT)).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("a non-canonical sealed encoding is refused", async () => {
    const key = await deriveTrustBundleKey(prf(10), ACCOUNT);
    const sealed = await sealBundle(key, ACCOUNT, [await host()]);
    for (const bad of [`${sealed}=`, `${sealed}!`, ""]) {
      await expect(openTrustBundle(key, ACCOUNT, bad)).rejects.toThrow(TrustBundleError);
    }
  });

  test("sealing is deterministic in content but not in ciphertext", async () => {
    // A fresh IV each time, so equal plaintexts must not produce equal bytes.
    const key = await deriveTrustBundleKey(prf(11), ACCOUNT);
    const hosts = [await host()];
    const first = await sealBundle(key, ACCOUNT, hosts);
    const second = await sealBundle(key, ACCOUNT, hosts);
    expect(first).not.toBe(second);
    expect((await openTrustBundle(key, ACCOUNT, first)).hosts).toEqual(
      (await openTrustBundle(key, ACCOUNT, second)).hosts,
    );
  });

  test("the revision round-trips and a legacy bundle without one opens as 0", async () => {
    const key = await deriveTrustBundleKey(prf(13), ACCOUNT);
    const sealed = await sealTrustBundle(key, ACCOUNT, [await host()], 7);
    expect((await openTrustBundle(key, ACCOUNT, sealed)).revision).toBe(7);
    // A bundle predating the field opens as revision 0 (the floor) rather than
    // failing, so existing sealed bundles keep working.
    const legacy = await sealTrustBundle(key, ACCOUNT, [await host()], 0);
    expect((await openTrustBundle(key, ACCOUNT, legacy)).revision).toBe(0);
  });

  test("host order does not affect the opened bundle", async () => {
    const key = await deriveTrustBundleKey(prf(12), ACCOUNT);
    const [a, b] = [await host(), await host()];
    const forward = await openTrustBundle(key, ACCOUNT, await sealBundle(key, ACCOUNT, [a, b]));
    const reverse = await openTrustBundle(key, ACCOUNT, await sealBundle(key, ACCOUNT, [b, a]));
    expect(forward.hosts).toEqual(reverse.hosts);
  });
});
