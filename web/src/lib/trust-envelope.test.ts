import { describe, expect, test } from "bun:test";
import { ed25519PublicKeyFingerprint, generateEd25519IdentityKeyPair } from "./signed-signal";
import { TrustBundleError, type TrustBundleHost } from "./trust-bundle";
import {
  enrollPasskeyInEnvelope,
  envelopeWrapCredentialIds,
  openTrustEnvelope,
  type PasskeyWrapInput,
  revokePasskeyFromEnvelope,
  sealTrustEnvelope,
} from "./trust-envelope";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "00000000-0000-4000-8000-000000000002";

function passkey(credentialId: string, seed: number): PasskeyWrapInput {
  return { credentialId, prfSecret: new Uint8Array(32).fill(seed) };
}

async function host(): Promise<TrustBundleHost> {
  const pair = await generateEd25519IdentityKeyPair();
  const exported = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const hostPublicKey = Buffer.from(exported)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return {
    hostPublicKey,
    hostFingerprint: await ed25519PublicKeyFingerprint(hostPublicKey),
    hostIds: [],
  };
}

describe("trust envelope", () => {
  test("one passkey seals and opens the bundle", async () => {
    const hosts = [await host(), await host()];
    const wire = await sealTrustEnvelope(ACCOUNT, hosts, [passkey("laptop", 1)]);
    const opened = await openTrustEnvelope(ACCOUNT, wire, passkey("laptop", 1));
    expect(new Set(opened.hosts.map((h) => h.hostPublicKey))).toEqual(
      new Set(hosts.map((h) => h.hostPublicKey)),
    );
  });

  test("a second enrolled passkey opens the same bundle", async () => {
    // The property this whole layer exists for: a backup passkey.
    const hosts = [await host()];
    const sealed = await sealTrustEnvelope(ACCOUNT, hosts, [passkey("laptop", 1)]);
    const twoKeys = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );

    // Either passkey opens it, and to the same hosts.
    const viaLaptop = await openTrustEnvelope(ACCOUNT, twoKeys, passkey("laptop", 1));
    const viaBackup = await openTrustEnvelope(ACCOUNT, twoKeys, passkey("yubikey", 2));
    expect(viaLaptop.hosts).toEqual(viaBackup.hosts);
    expect(new Set(envelopeWrapCredentialIds(ACCOUNT, twoKeys))).toEqual(
      new Set(["laptop", "yubikey"]),
    );
  });

  test("an unenrolled passkey cannot open the envelope", async () => {
    const sealed = await sealTrustEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(openTrustEnvelope(ACCOUNT, sealed, passkey("stranger", 9))).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("the wrong secret for an enrolled credential cannot open it", async () => {
    // Same credential ID, different PRF secret: a server swapping a wrap fails.
    const sealed = await sealTrustEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(
      openTrustEnvelope(ACCOUNT, sealed, {
        credentialId: "laptop",
        prfSecret: new Uint8Array(32).fill(7),
      }),
    ).rejects.toThrow(TrustBundleError);
  });

  test("an envelope cannot be opened under another account", async () => {
    const sealed = await sealTrustEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(openTrustEnvelope(OTHER_ACCOUNT, sealed, passkey("laptop", 1))).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("tampering with the sealed bundle is detected", async () => {
    const sealed = await sealTrustEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    // Flip a byte inside the base64url payload.
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "AB" : "AA"}`;
    await expect(openTrustEnvelope(ACCOUNT, flipped, passkey("laptop", 1))).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("revoking a passkey removes its access while others keep theirs", async () => {
    const sealed = await sealTrustEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    const withBackup = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    const revoked = await revokePasskeyFromEnvelope(
      ACCOUNT,
      withBackup,
      passkey("laptop", 1),
      "yubikey",
    );

    expect(await openTrustEnvelope(ACCOUNT, revoked, passkey("laptop", 1))).toBeDefined();
    await expect(openTrustEnvelope(ACCOUNT, revoked, passkey("yubikey", 2))).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("a passkey cannot revoke itself, which would risk locking everyone out", async () => {
    const sealed = await sealTrustEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(
      revokePasskeyFromEnvelope(ACCOUNT, sealed, passkey("laptop", 1), "laptop"),
    ).rejects.toThrow(TrustBundleError);
  });

  test("enrolling is idempotent on the credential id", async () => {
    const sealed = await sealTrustEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    const once = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    const twice = await enrollPasskeyInEnvelope(
      ACCOUNT,
      once,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    expect(envelopeWrapCredentialIds(ACCOUNT, twice).sort()).toEqual(["laptop", "yubikey"]);
  });

  test("only enrolled credential ids are advertised, not the secrets", async () => {
    const sealed = await sealTrustEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    expect(envelopeWrapCredentialIds(ACCOUNT, sealed)).toEqual(["laptop"]);
    // The wire form must not contain the raw PRF secret anywhere.
    expect(sealed).not.toContain(Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"));
  });

  test("sealing needs at least one passkey", async () => {
    await expect(sealTrustEnvelope(ACCOUNT, [await host()], [])).rejects.toThrow(TrustBundleError);
  });
});
