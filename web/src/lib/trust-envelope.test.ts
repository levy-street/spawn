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

/** Most tests do not care about the revision; seal at a fixed one. */
function sealEnvelope(
  account: string,
  hosts: readonly TrustBundleHost[],
  passkeys: readonly PasskeyWrapInput[],
) {
  return sealTrustEnvelope(account, hosts, passkeys, 1);
}

describe("trust envelope", () => {
  test("one passkey seals and opens the bundle", async () => {
    const hosts = [await host(), await host()];
    const wire = await sealEnvelope(ACCOUNT, hosts, [passkey("laptop", 1)]);
    const opened = await openTrustEnvelope(ACCOUNT, wire, passkey("laptop", 1));
    expect(new Set(opened.hosts.map((h) => h.hostPublicKey))).toEqual(
      new Set(hosts.map((h) => h.hostPublicKey)),
    );
  });

  test("a second enrolled passkey opens the same bundle", async () => {
    // The property this whole layer exists for: a backup passkey.
    const hosts = [await host()];
    const sealed = await sealEnvelope(ACCOUNT, hosts, [passkey("laptop", 1)]);
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
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(openTrustEnvelope(ACCOUNT, sealed, passkey("stranger", 9))).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("the wrong secret for an enrolled credential cannot open it", async () => {
    // Same credential ID, different PRF secret: a server swapping a wrap fails.
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(
      openTrustEnvelope(ACCOUNT, sealed, {
        credentialId: "laptop",
        prfSecret: new Uint8Array(32).fill(7),
      }),
    ).rejects.toThrow(TrustBundleError);
  });

  test("an envelope cannot be opened under another account", async () => {
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(openTrustEnvelope(OTHER_ACCOUNT, sealed, passkey("laptop", 1))).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("tampering with the sealed bundle is detected", async () => {
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    // Flip a byte inside the base64url payload.
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "AB" : "AA"}`;
    await expect(openTrustEnvelope(ACCOUNT, flipped, passkey("laptop", 1))).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("revoking a passkey reseals for the survivors and locks the revoked one out", async () => {
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    const withBackup = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    const revoked = await revokePasskeyFromEnvelope(
      ACCOUNT,
      withBackup,
      [passkey("laptop", 1)],
      "yubikey",
      2,
    );

    // The surviving passkey still opens it, at the bumped revision...
    const opened = await openTrustEnvelope(ACCOUNT, revoked, passkey("laptop", 1));
    expect(opened.revision).toBe(2);
    // ...and the revoked passkey cannot: its wrap is gone and, because the data
    // key is fresh, splicing the old wrap back from the retained envelope is
    // useless too.
    await expect(openTrustEnvelope(ACCOUNT, revoked, passkey("yubikey", 2))).rejects.toThrow(
      TrustBundleError,
    );
    expect(envelopeWrapCredentialIds(ACCOUNT, revoked)).toEqual(["laptop"]);
  });

  test("revocation refuses to keep and revoke the same passkey, or to keep none", async () => {
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(
      revokePasskeyFromEnvelope(ACCOUNT, sealed, [passkey("laptop", 1)], "laptop", 2),
    ).rejects.toThrow(TrustBundleError);
    await expect(revokePasskeyFromEnvelope(ACCOUNT, sealed, [], "laptop", 2)).rejects.toThrow(
      TrustBundleError,
    );
  });

  test("revocation refuses to silently drop a wrap that is neither kept nor revoked", async () => {
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    const withTwo = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    const withThree = await enrollPasskeyInEnvelope(
      ACCOUNT,
      withTwo,
      passkey("laptop", 1),
      passkey("phone", 3),
    );
    // Keeping only laptop would drop the still-enrolled "phone" — refuse, even
    // though a hostile server might have hidden "phone" from the passkey list.
    await expect(
      revokePasskeyFromEnvelope(ACCOUNT, withThree, [passkey("laptop", 1)], "yubikey", 2),
    ).rejects.toThrow(TrustBundleError);
    // Enumerating every survivor succeeds.
    const revoked = await revokePasskeyFromEnvelope(
      ACCOUNT,
      withThree,
      [passkey("laptop", 1), passkey("phone", 3)],
      "yubikey",
      2,
    );
    expect(new Set(envelopeWrapCredentialIds(ACCOUNT, revoked))).toEqual(
      new Set(["laptop", "phone"]),
    );
  });

  test("revocation must advance the revision", async () => {
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    const withBackup = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    // Revision 1 does not exceed the bundle's own revision (1).
    await expect(
      revokePasskeyFromEnvelope(ACCOUNT, withBackup, [passkey("laptop", 1)], "yubikey", 1),
    ).rejects.toThrow(TrustBundleError);
  });

  test("a passkey cannot enroll over itself with a different secret", async () => {
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(
      enrollPasskeyInEnvelope(ACCOUNT, sealed, passkey("laptop", 1), passkey("laptop", 5)),
    ).rejects.toThrow(TrustBundleError);
  });

  test("enrolling is idempotent on the credential id", async () => {
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
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
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    expect(envelopeWrapCredentialIds(ACCOUNT, sealed)).toEqual(["laptop"]);
    // The wire form must not contain the raw PRF secret anywhere.
    expect(sealed).not.toContain(Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"));
  });

  test("sealing needs at least one passkey", async () => {
    await expect(sealEnvelope(ACCOUNT, [await host()], [])).rejects.toThrow(TrustBundleError);
  });
});

describe("account root in the envelope (mesh stage 5)", () => {
  async function rootMaterial() {
    const { exportAccountRootMaterial, generateAccountRoot } = await import("./account-root");
    return exportAccountRootMaterial(await generateAccountRoot());
  }

  test("the root seals in and comes back on open; absent means null", async () => {
    const root = await rootMaterial();
    const withRoot = await sealTrustEnvelope(
      ACCOUNT,
      [await host()],
      [passkey("laptop", 1)],
      1,
      root,
    );
    const opened = await openTrustEnvelope(ACCOUNT, withRoot, passkey("laptop", 1));
    expect(opened.root).toEqual(root);

    const withoutRoot = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    expect((await openTrustEnvelope(ACCOUNT, withoutRoot, passkey("laptop", 1))).root).toBeNull();
  });

  test("revoking a passkey reseals WITH the root — sk_R must survive the rotation", async () => {
    const root = await rootMaterial();
    const sealed = await sealTrustEnvelope(
      ACCOUNT,
      [await host()],
      [passkey("laptop", 1)],
      1,
      root,
    );
    const withBackup = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    const rotated = await revokePasskeyFromEnvelope(
      ACCOUNT,
      withBackup,
      [passkey("laptop", 1)],
      "yubikey",
      2,
    );
    expect((await openTrustEnvelope(ACCOUNT, rotated, passkey("laptop", 1))).root).toEqual(root);
  });

  test("enrolling a backup passkey leaves the sealed root intact", async () => {
    const root = await rootMaterial();
    const sealed = await sealTrustEnvelope(
      ACCOUNT,
      [await host()],
      [passkey("laptop", 1)],
      1,
      root,
    );
    const withBackup = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    expect((await openTrustEnvelope(ACCOUNT, withBackup, passkey("yubikey", 2))).root).toEqual(
      root,
    );
  });
});

describe("root retrofit into a pre-root bundle (mesh stage 5c)", () => {
  async function rootMaterial() {
    const { exportAccountRootMaterial, generateAccountRoot } = await import("./account-root");
    return exportAccountRootMaterial(await generateAccountRoot());
  }

  test("retrofit adds the root and every enrolled passkey still opens", async () => {
    const { setEnvelopeRoot } = await import("./trust-envelope");
    const hosts = [await host()];
    const legacy = await sealEnvelope(ACCOUNT, hosts, [passkey("laptop", 1)]);
    const withBackup = await enrollPasskeyInEnvelope(
      ACCOUNT,
      legacy,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    const root = await rootMaterial();
    const amended = await setEnvelopeRoot(ACCOUNT, withBackup, passkey("laptop", 1), root, 2);
    // Both passkeys open the amended bundle — the data key was reused, so the
    // backup's wrap survived a reseal it never participated in.
    for (const key of [passkey("laptop", 1), passkey("yubikey", 2)]) {
      const opened = await openTrustEnvelope(ACCOUNT, amended, key);
      expect(opened.root).toEqual(root);
      expect(opened.revision).toBe(2);
      expect(opened.hosts.map((h) => h.hostPublicKey)).toEqual(hosts.map((h) => h.hostPublicKey));
    }
  });

  test("retrofit refuses a bundle that already holds a root", async () => {
    const { setEnvelopeRoot } = await import("./trust-envelope");
    const root = await rootMaterial();
    const sealed = await sealTrustEnvelope(
      ACCOUNT,
      [await host()],
      [passkey("laptop", 1)],
      1,
      root,
    );
    await expect(
      setEnvelopeRoot(ACCOUNT, sealed, passkey("laptop", 1), await rootMaterial(), 2),
    ).rejects.toThrow(TrustBundleError);
  });

  test("retrofit must advance the revision", async () => {
    const { setEnvelopeRoot } = await import("./trust-envelope");
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    await expect(
      setEnvelopeRoot(ACCOUNT, sealed, passkey("laptop", 1), await rootMaterial(), 1),
    ).rejects.toThrow(TrustBundleError);
  });
});

describe("root rotation (replace a revoked root)", () => {
  test("replace=true swaps the sealed root; wraps stay intact; default still refuses", async () => {
    const { exportAccountRootMaterial, generateAccountRoot } = await import("./account-root");
    const { setEnvelopeRoot } = await import("./trust-envelope");
    const dead = await exportAccountRootMaterial(await generateAccountRoot());
    const successor = await exportAccountRootMaterial(await generateAccountRoot());
    const sealed = await sealTrustEnvelope(
      ACCOUNT,
      [await host()],
      [passkey("laptop", 1)],
      1,
      dead,
    );
    const withBackup = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );

    await expect(
      setEnvelopeRoot(ACCOUNT, withBackup, passkey("laptop", 1), successor, 2),
    ).rejects.toThrow(TrustBundleError);

    const rotated = await setEnvelopeRoot(
      ACCOUNT,
      withBackup,
      passkey("laptop", 1),
      successor,
      2,
      true,
    );
    for (const key of [passkey("laptop", 1), passkey("yubikey", 2)]) {
      const opened = await openTrustEnvelope(ACCOUNT, rotated, key);
      expect(opened.root).toEqual(successor);
    }
  });
});

describe("retired-root retention through rotation (hardening B2)", () => {
  async function rootMaterial() {
    const { exportAccountRootMaterial, generateAccountRoot } = await import("./account-root");
    return exportAccountRootMaterial(await generateAccountRoot());
  }

  test("rotation retires the old seed instead of destroying it, oldest first", async () => {
    const { setEnvelopeRoot } = await import("./trust-envelope");
    const first = await rootMaterial();
    const second = await rootMaterial();
    const third = await rootMaterial();
    const sealed = await sealTrustEnvelope(
      ACCOUNT,
      [await host()],
      [passkey("laptop", 1)],
      1,
      first,
    );

    const once = await setEnvelopeRoot(ACCOUNT, sealed, passkey("laptop", 1), second, 2, true);
    const openedOnce = await openTrustEnvelope(ACCOUNT, once, passkey("laptop", 1));
    expect(openedOnce.root).toEqual(second);
    expect(openedOnce.retiredRoots).toEqual([first]);

    // A second (e.g. fabricated) rotation still loses nothing: the full
    // lineage of firsthand seeds survives, in order.
    const twice = await setEnvelopeRoot(ACCOUNT, once, passkey("laptop", 1), third, 3, true);
    const openedTwice = await openTrustEnvelope(ACCOUNT, twice, passkey("laptop", 1));
    expect(openedTwice.root).toEqual(third);
    expect(openedTwice.retiredRoots).toEqual([first, second]);
  });

  test("a fresh or retrofitted bundle has an empty archive", async () => {
    const { setEnvelopeRoot } = await import("./trust-envelope");
    const sealed = await sealEnvelope(ACCOUNT, [await host()], [passkey("laptop", 1)]);
    expect((await openTrustEnvelope(ACCOUNT, sealed, passkey("laptop", 1))).retiredRoots).toEqual(
      [],
    );
    const retro = await setEnvelopeRoot(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      await rootMaterial(),
      2,
    );
    expect((await openTrustEnvelope(ACCOUNT, retro, passkey("laptop", 1))).retiredRoots).toEqual(
      [],
    );
  });

  test("passkey revocation reseals WITH the retired archive", async () => {
    const { setEnvelopeRoot } = await import("./trust-envelope");
    const first = await rootMaterial();
    const second = await rootMaterial();
    const sealed = await sealTrustEnvelope(
      ACCOUNT,
      [await host()],
      [passkey("laptop", 1)],
      1,
      first,
    );
    const withBackup = await enrollPasskeyInEnvelope(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      passkey("yubikey", 2),
    );
    const rotated = await setEnvelopeRoot(
      ACCOUNT,
      withBackup,
      passkey("laptop", 1),
      second,
      2,
      true,
    );
    const survivorOnly = await revokePasskeyFromEnvelope(
      ACCOUNT,
      rotated,
      [passkey("laptop", 1)],
      "yubikey",
      3,
    );
    const opened = await openTrustEnvelope(ACCOUNT, survivorOnly, passkey("laptop", 1));
    expect(opened.root).toEqual(second);
    expect(opened.retiredRoots).toEqual([first]);
  });

  test("rotation at the archive cap evicts the OLDEST seed and still succeeds", async () => {
    // Fail-soft at the cap (passkey-lifecycle review): the old behavior THREW
    // here, out of the unlock itself — so from the 9th rotation on, every
    // unlock imported pins and then errored forever: recovery permanently
    // broken. Rotation is the compromise response and must keep working; the
    // price is the single OLDEST retired seed (revoked longest, anchors long
    // severed), while the newest MAX_RETIRED_ROOTS seeds all survive in order.
    const { MAX_RETIRED_ROOTS } = await import("./trust-bundle");
    const { setEnvelopeRoot } = await import("./trust-envelope");
    const lineage = [await rootMaterial()];
    let sealed = await sealTrustEnvelope(
      ACCOUNT,
      [await host()],
      [passkey("laptop", 1)],
      1,
      lineage[0],
    );
    for (let i = 0; i < MAX_RETIRED_ROOTS; i += 1) {
      lineage.push(await rootMaterial());
      sealed = await setEnvelopeRoot(
        ACCOUNT,
        sealed,
        passkey("laptop", 1),
        lineage[lineage.length - 1],
        i + 2,
        true,
      );
    }
    const full = await openTrustEnvelope(ACCOUNT, sealed, passkey("laptop", 1));
    expect(full.retiredRoots).toHaveLength(MAX_RETIRED_ROOTS);

    // One more rotation succeeds; the ORIGINAL (oldest) seed is the one paid.
    const successor = await rootMaterial();
    const rotated = await setEnvelopeRoot(
      ACCOUNT,
      sealed,
      passkey("laptop", 1),
      successor,
      MAX_RETIRED_ROOTS + 2,
      true,
    );
    const opened = await openTrustEnvelope(ACCOUNT, rotated, passkey("laptop", 1));
    expect(opened.root).toEqual(successor);
    expect(opened.retiredRoots).toHaveLength(MAX_RETIRED_ROOTS);
    // Newest-8 retained, in lineage order: the first seed is gone, the
    // previously-live root was retired at the end.
    expect(opened.retiredRoots).toEqual(lineage.slice(1));
  });
});
