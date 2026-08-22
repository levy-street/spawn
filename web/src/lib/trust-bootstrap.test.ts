import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  approveBrowserHostPin,
  listActiveBrowserHostPins,
  loadBrowserHostPin,
  loadBrowserHostPinByHostId,
  resolveActiveBrowserHostPin,
  revokeBrowserHostPin,
} from "./browser-host-pins";
import { ed25519PublicKeyFingerprint } from "./signed-signal";
import {
  enrollBackupPasskey,
  importTrustBundle,
  revokeBackupPasskey,
  sealCurrentTrust,
} from "./trust-bootstrap";
import { openTrustEnvelope, type PasskeyWrapInput } from "./trust-envelope";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "00000000-0000-4000-8000-000000000003";
const ORIGIN = "https://spawn.example";
const HOST_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const OTHER_HOST_KEY = "11qYAYdk9Jt0uvL7Tp_5eQK8heP0LOEYVVt4dSK3M3A";

/** A separate IDBFactory is a separate device: its own origin-scoped store. */
function device() {
  return { indexedDBFactory: new IDBFactory() };
}

function key(seed: number): PasskeyWrapInput {
  return { credentialId: `passkey-${seed}`, prfSecret: new Uint8Array(32).fill(seed) };
}

async function pin(storage: { indexedDBFactory: IDBFactory }, hostKey: string) {
  await approveBrowserHostPin(
    {
      accountId: ACCOUNT,
      origin: ORIGIN,
      hostPublicKey: hostKey,
      hostFingerprint: await ed25519PublicKeyFingerprint(hostKey),
    },
    storage,
  );
}

/** Seal at server revision 0 (fresh account); freshness is covered separately. */
function sealTrust(passkey: PasskeyWrapInput, scope: Parameters<typeof sealCurrentTrust>[1]) {
  return sealCurrentTrust(passkey, scope, 0);
}

describe("trust bootstrap", () => {
  test("a new device inherits the hosts the first device verified", async () => {
    // The property the whole passkey path exists for.
    const first = device();
    await pin(first, HOST_KEY);
    await pin(first, OTHER_HOST_KEY);

    const bundleKey = key(1);
    const { sealed, hostCount } = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: first,
    });
    expect(hostCount).toBe(2);

    const second = device();
    const imported = await importTrustBundle(bundleKey, sealed, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: second,
    });
    expect(imported.added).toHaveLength(2);
    expect(imported.alreadyTrusted).toHaveLength(0);

    const pins = await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, second);
    expect(new Set(pins.map((p) => p.hostPublicKey))).toEqual(new Set([HOST_KEY, OTHER_HOST_KEY]));
  });

  test("a revoked host is not resurrected on the new device", async () => {
    // Carrying tombstones across would restore trust the operator withdrew.
    const first = device();
    await pin(first, HOST_KEY);
    await pin(first, OTHER_HOST_KEY);

    // Revocation needs an existing hostId binding, which resolving creates.
    await resolveActiveBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        hostId: HOST_ID,
        claimedHostPublicKey: HOST_KEY,
      },
      first,
    );
    await revokeBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        targetHostId: HOST_ID,
        claimedHostId: HOST_ID,
        claimedHostPublicKey: HOST_KEY,
      },
      first,
    );

    // The revoked host must be gone from the source device...
    const active = await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, first);
    expect(active.map((p) => p.hostPublicKey)).toEqual([OTHER_HOST_KEY]);

    const { sealed, hostCount } = await sealTrust(key(2), {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: first,
    });
    expect(hostCount).toBe(1);

    const second = device();
    const imported = await importTrustBundle(key(2), sealed, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: second,
    });

    // ...and must never appear on the device that inherits the bundle.
    expect(imported.added).toEqual([OTHER_HOST_KEY]);
    const carried = await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, second);
    expect(carried.map((p) => p.hostPublicKey)).toEqual([OTHER_HOST_KEY]);
    expect(
      await loadBrowserHostPin(
        {
          accountId: ACCOUNT,
          origin: ORIGIN,
          hostPublicKey: HOST_KEY,
          hostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
        },
        second,
      ),
    ).toBeNull();
  });

  test("importing twice is idempotent", async () => {
    const first = device();
    await pin(first, HOST_KEY);
    const bundleKey = key(3);
    const { sealed } = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: first,
    });

    const second = device();
    const scope = { accountId: ACCOUNT, origin: ORIGIN, pinStorage: second };
    const once = await importTrustBundle(bundleKey, sealed, scope);
    const twice = await importTrustBundle(bundleKey, sealed, scope);

    expect(once.added).toEqual([HOST_KEY]);
    expect(twice.added).toHaveLength(0);
    expect(twice.alreadyTrusted).toEqual([HOST_KEY]);
    expect(
      await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, second),
    ).toHaveLength(1);
  });

  test("a bundle sealed under another secret cannot import anything", async () => {
    const first = device();
    await pin(first, HOST_KEY);
    const { sealed } = await sealTrust(key(4), {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: first,
    });

    const second = device();
    const scope = { accountId: ACCOUNT, origin: ORIGIN, pinStorage: second };
    await expect(importTrustBundle(key(5), sealed, scope)).rejects.toThrow();
    // Nothing was pinned by the failed import.
    expect(
      await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, second),
    ).toHaveLength(0);
  });

  test("imported pins are usable by the gate, with locally re-derived fingerprints", async () => {
    const first = device();
    await pin(first, HOST_KEY);
    const bundleKey = key(6);
    const { sealed } = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: first,
    });

    const second = device();
    await importTrustBundle(bundleKey, sealed, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: second,
    });

    const loaded = await loadBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        hostPublicKey: HOST_KEY,
        hostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
      },
      second,
    );
    expect(loaded).not.toBeNull();
    expect(loaded?.state).toBe("active");
    expect(loaded?.hostFingerprint).toBe(await ed25519PublicKeyFingerprint(HOST_KEY));
  });

  test("sealing an empty device produces an openable empty bundle", async () => {
    // A device with nothing verified must still be able to publish, or the
    // first seal would need special-casing at every call site.
    const bundleKey = key(7);
    const { sealed, hostCount } = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: device(),
    });
    expect(hostCount).toBe(0);
    const imported = await importTrustBundle(bundleKey, sealed, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: device(),
    });
    expect(imported.added).toHaveLength(0);
  });

  test("an imported pin carries its Host IDs, so the downgrade gate sees it immediately", async () => {
    // Regression: pins used to import with empty hostIds, so the signed-RTC
    // downgrade check (loadBrowserHostPinByHostId) could not recognise an
    // imported host until a first successful signed resolve. A hostile server
    // could exploit that window to hold the device on the raw, unsigned path by
    // simply never presenting the key for that hostId.
    const first = device();
    await pin(first, HOST_KEY);
    // Binding a hostId on the source device is what carries it into the bundle.
    await resolveActiveBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        hostId: HOST_ID,
        claimedHostPublicKey: HOST_KEY,
      },
      first,
    );

    const bundleKey = key(8);
    const { sealed } = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: first,
    });

    const second = device();
    await importTrustBundle(bundleKey, sealed, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: second,
    });

    // The new device recognises the host by ID with no prior signed resolve.
    const bound = await loadBrowserHostPinByHostId(
      { accountId: ACCOUNT, origin: ORIGIN, hostId: HOST_ID },
      second,
    );
    expect(bound).not.toBeNull();
    expect(bound?.hostPublicKey).toBe(HOST_KEY);
    expect(bound?.hostIds).toContain(HOST_ID);
  });

  test("a rolled-back bundle is refused on import once a newer one has been seen", async () => {
    // The untrusted-server replay attack: serving an older authentic bundle to
    // resurrect withdrawn hosts. A device that has seen a newer revision refuses.
    const source = device();
    await pin(source, HOST_KEY);
    const bundleKey = key(9);
    const scope = { accountId: ACCOUNT, origin: ORIGIN, pinStorage: source };
    const old = await sealCurrentTrust(bundleKey, scope, 0);
    expect(old.revision).toBe(1);
    await pin(source, OTHER_HOST_KEY);
    // The server now reports revision 1, so the next seal binds revision 2.
    const fresh = await sealCurrentTrust(bundleKey, scope, 1);
    expect(fresh.revision).toBe(2);

    const target = device();
    const targetScope = { accountId: ACCOUNT, origin: ORIGIN, pinStorage: target };
    await importTrustBundle(bundleKey, fresh.sealed, targetScope);
    // Replaying the older bundle is refused as a rollback.
    await expect(importTrustBundle(bundleKey, old.sealed, targetScope)).rejects.toThrow();
  });

  test("revoking a passkey reseals and blocks the revoked key end to end", async () => {
    const dev = device();
    await pin(dev, HOST_KEY);
    const scope = { accountId: ACCOUNT, origin: ORIGIN, pinStorage: dev };
    const primary = key(10);
    const backup = key(11);
    const { sealed, revision } = await sealCurrentTrust(primary, scope, 0);
    const withBackup = await enrollBackupPasskey(scope, sealed, primary, backup);
    // Both passkeys open it before revocation.
    expect((await openTrustEnvelope(ACCOUNT, withBackup, primary)).revision).toBe(revision);
    expect((await openTrustEnvelope(ACCOUNT, withBackup, backup)).revision).toBe(revision);

    const revoked = await revokeBackupPasskey(
      scope,
      withBackup,
      revision,
      primary,
      backup.credentialId,
    );
    expect(revoked.revision).toBeGreaterThan(revision);
    // The kept passkey still opens the resealed bundle; the revoked one cannot.
    expect((await openTrustEnvelope(ACCOUNT, revoked.sealed, primary)).revision).toBe(
      revoked.revision,
    );
    await expect(openTrustEnvelope(ACCOUNT, revoked.sealed, backup)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Reseal-on-unlock (review P-C1a): the bundle tracks the fleet
// ---------------------------------------------------------------------------

import { resealBundleWithLocalPins } from "./trust-bootstrap";
import { mergeEnvelopeHosts } from "./trust-envelope";

describe("resealBundleWithLocalPins", () => {
  test("merges hosts possessed after the seal into the bundle at a bumped revision", async () => {
    const minter = device();
    await pin(minter, HOST_KEY);
    const bundleKey = key(31);
    const { sealed, revision } = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: minter,
    });

    // The same device later possesses a second host — the exact C1-A ordering
    // gap: nothing ever resealed, so the passkey never learned it.
    await pin(minter, OTHER_HOST_KEY);
    const reseal = await resealBundleWithLocalPins(
      { accountId: ACCOUNT, origin: ORIGIN, pinStorage: minter },
      sealed,
      bundleKey,
      revision,
    );
    expect(reseal).not.toBeNull();
    expect(reseal!.addedHostKeys).toEqual([OTHER_HOST_KEY]);
    expect(reseal!.revision).toBeGreaterThan(revision);

    const bundle = await openTrustEnvelope(ACCOUNT, reseal!.sealed, bundleKey);
    expect(new Set(bundle.hosts.map((h) => h.hostPublicKey))).toEqual(
      new Set([HOST_KEY, OTHER_HOST_KEY]),
    );
  });

  test("returns null when the bundle already covers every local pin", async () => {
    const minter = device();
    await pin(minter, HOST_KEY);
    const bundleKey = key(32);
    const { sealed, revision } = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: minter,
    });
    expect(
      await resealBundleWithLocalPins(
        { accountId: ACCOUNT, origin: ORIGIN, pinStorage: minter },
        sealed,
        bundleKey,
        revision,
      ),
    ).toBeNull();
  });

  test("UNION, never replacement: a locally-revoked host stays sealed for the others", async () => {
    // Device 1 seals two hosts. Device 2 imports, locally revokes one (its own
    // withdrawal), pins a third, and reseals: the merge must keep the host
    // device 2 dropped — local tombstones are this-device-only.
    const first = device();
    await pin(first, HOST_KEY);
    await pin(first, OTHER_HOST_KEY);
    const bundleKey = key(33);
    const { sealed, revision } = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: first,
    });

    const second = device();
    await importTrustBundle(bundleKey, sealed, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: second,
    });
    await resolveActiveBrowserHostPin(
      { accountId: ACCOUNT, origin: ORIGIN, hostId: HOST_ID, claimedHostPublicKey: HOST_KEY },
      second,
    );
    await revokeBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        targetHostId: HOST_ID,
        claimedHostId: HOST_ID,
        claimedHostPublicKey: HOST_KEY,
      },
      second,
    );
    const THIRD_HOST_KEY = "9wLNcag6789rk5UUFLPS3mIhplKKC8zVUEWdIYkAcNQ";
    await pin(second, THIRD_HOST_KEY);

    const reseal = await resealBundleWithLocalPins(
      { accountId: ACCOUNT, origin: ORIGIN, pinStorage: second },
      sealed,
      bundleKey,
      revision,
    );
    expect(reseal!.addedHostKeys).toEqual([THIRD_HOST_KEY]);
    const bundle = await openTrustEnvelope(ACCOUNT, reseal!.sealed, bundleKey);
    expect(new Set(bundle.hosts.map((h) => h.hostPublicKey))).toEqual(
      new Set([HOST_KEY, OTHER_HOST_KEY, THIRD_HOST_KEY]),
    );
  });

  test("a CAS loser converges by resealing on top of the winner's bundle", async () => {
    // Two devices race their merges from the same base revision. The server's
    // CAS lets exactly one in; the loser SKIPS (nothing lost) and its next
    // unlock reseals against the winner's bundle — ending with the union.
    const first = device();
    await pin(first, HOST_KEY);
    const bundleKey = key(34);
    const base = await sealTrust(bundleKey, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: first,
    });

    const deviceA = device();
    await importTrustBundle(bundleKey, base.sealed, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: deviceA,
    });
    await pin(deviceA, OTHER_HOST_KEY);
    const winner = await resealBundleWithLocalPins(
      { accountId: ACCOUNT, origin: ORIGIN, pinStorage: deviceA },
      base.sealed,
      bundleKey,
      base.revision,
    );
    expect(winner!.addedHostKeys).toEqual([OTHER_HOST_KEY]);

    const deviceB = device();
    await importTrustBundle(bundleKey, base.sealed, {
      accountId: ACCOUNT,
      origin: ORIGIN,
      pinStorage: deviceB,
    });
    const THIRD_HOST_KEY = "9wLNcag6789rk5UUFLPS3mIhplKKC8zVUEWdIYkAcNQ";
    await pin(deviceB, THIRD_HOST_KEY);
    // B's write of its own merge would 409 server-side (same expected
    // revision as the winner's) — the loser path. Next unlock: B reseals
    // from the WINNER's stored bundle and revision.
    const retry = await resealBundleWithLocalPins(
      { accountId: ACCOUNT, origin: ORIGIN, pinStorage: deviceB },
      winner!.sealed,
      bundleKey,
      winner!.revision,
    );
    expect(retry!.addedHostKeys).toEqual([THIRD_HOST_KEY]);
    expect(retry!.revision).toBeGreaterThan(winner!.revision);
    const bundle = await openTrustEnvelope(ACCOUNT, retry!.sealed, bundleKey);
    expect(new Set(bundle.hosts.map((h) => h.hostPublicKey))).toEqual(
      new Set([HOST_KEY, OTHER_HOST_KEY, THIRD_HOST_KEY]),
    );
  });
});

describe("mergeEnvelopeHosts", () => {
  test("reseals under the same data key: every enrolled passkey still opens, root survives", async () => {
    const minter = device();
    await pin(minter, HOST_KEY);
    const primary = key(35);
    const backup = key(36);
    const root = {
      publicKeyWire: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
      seedWire: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const { sealed, revision } = await sealCurrentTrust(
      primary,
      { accountId: ACCOUNT, origin: ORIGIN, pinStorage: minter },
      0,
      root,
    );
    const withBackup = await enrollBackupPasskey(
      { accountId: ACCOUNT, origin: ORIGIN, pinStorage: minter },
      sealed,
      primary,
      backup,
    );

    const merged = await mergeEnvelopeHosts(
      ACCOUNT,
      withBackup,
      primary,
      [
        {
          hostPublicKey: OTHER_HOST_KEY,
          hostFingerprint: await ed25519PublicKeyFingerprint(OTHER_HOST_KEY),
          hostIds: [],
        },
      ],
      revision + 1,
    );
    expect(merged!.addedHostKeys).toEqual([OTHER_HOST_KEY]);
    // BOTH passkeys open the merged envelope (same data key, wraps intact)…
    for (const opener of [primary, backup]) {
      const bundle = await openTrustEnvelope(ACCOUNT, merged!.sealed, opener);
      expect(bundle.hosts).toHaveLength(2);
      // …and the sealed root is carried, never dropped by the merge.
      expect(bundle.root?.publicKeyWire).toBe(root.publicKeyWire);
    }
  });
});
