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
import { importTrustBundle, sealCurrentTrust } from "./trust-bootstrap";
import type { PasskeyWrapInput } from "./trust-envelope";

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

describe("trust bootstrap", () => {
  test("a new device inherits the hosts the first device verified", async () => {
    // The property the whole passkey path exists for.
    const first = device();
    await pin(first, HOST_KEY);
    await pin(first, OTHER_HOST_KEY);

    const bundleKey = key(1);
    const { sealed, hostCount } = await sealCurrentTrust(bundleKey, {
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
        claimedHostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
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
        claimedHostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
      },
      first,
    );

    // The revoked host must be gone from the source device...
    const active = await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, first);
    expect(active.map((p) => p.hostPublicKey)).toEqual([OTHER_HOST_KEY]);

    const { sealed, hostCount } = await sealCurrentTrust(key(2), {
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
    const { sealed } = await sealCurrentTrust(bundleKey, {
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
    const { sealed } = await sealCurrentTrust(key(4), {
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
    const { sealed } = await sealCurrentTrust(bundleKey, {
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
    const { sealed, hostCount } = await sealCurrentTrust(bundleKey, {
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
        claimedHostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
      },
      first,
    );

    const bundleKey = key(8);
    const { sealed } = await sealCurrentTrust(bundleKey, {
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
});
