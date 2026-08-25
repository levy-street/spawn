import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  loadBrowserDeviceIdentity,
  loadOrCreateBrowserDeviceIdentity,
} from "./browser-device-identity";
import {
  approveBrowserHostPin,
  loadBrowserHostPin,
  revokeBrowserHostPin,
} from "./browser-host-pins";
import { removeAccountFromThisBrowser } from "./local-account-hygiene";
import { listPeerDeviceKeys, rememberPeerDeviceKey } from "./peer-device-keys";
import { loadFirsthandRoot, rememberFirsthandRoot } from "./root-knowledge";
import { ed25519PublicKeyFingerprint } from "./signed-signal";
import { readHighestSeenRevision, recordSeenRevision } from "./trust-revision";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "00000000-0000-4000-8000-000000000002";
const HOST_ID = "00000000-0000-4000-8000-000000000003";
const DEVICE_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_DEVICE_ID = "00000000-0000-4000-8000-000000000005";
const ORIGIN = "https://spawn.example";
const HOST_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const OTHER_HOST_KEY = "11qYAYdk9Jt0uvL7Tp_5eQK8heP0LOEYVVt4dSK3M3A";

describe("removeAccountFromThisBrowser", () => {
  test("wipes one account while preserving other accounts, removal records, and revision floors", async () => {
    const factory = new IDBFactory();
    const storage = { indexedDBFactory: factory, now: () => 1_000 } as const;
    const identityStorage = { indexedDBFactory: factory } as const;
    const revisionStorage = { indexedDBFactory: factory } as const;
    await loadOrCreateBrowserDeviceIdentity(ACCOUNT, identityStorage);
    await loadOrCreateBrowserDeviceIdentity(OTHER_ACCOUNT, identityStorage);

    await approveBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        hostPublicKey: HOST_KEY,
        hostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
        hostIds: [HOST_ID],
      },
      storage,
    );
    await revokeBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        targetHostId: HOST_ID,
        claimedHostId: HOST_ID,
        claimedHostPublicKey: HOST_KEY,
      },
      { ...storage, now: () => 2_000 },
    );
    await approveBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        hostPublicKey: OTHER_HOST_KEY,
        hostFingerprint: await ed25519PublicKeyFingerprint(OTHER_HOST_KEY),
      },
      storage,
    );
    await approveBrowserHostPin(
      {
        accountId: OTHER_ACCOUNT,
        origin: ORIGIN,
        hostPublicKey: HOST_KEY,
        hostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
      },
      storage,
    );

    await rememberPeerDeviceKey(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        publicKey: HOST_KEY,
        deviceId: DEVICE_ID,
        source: "ceremony",
      },
      storage,
    );
    await rememberPeerDeviceKey(
      {
        accountId: OTHER_ACCOUNT,
        origin: ORIGIN,
        publicKey: OTHER_HOST_KEY,
        deviceId: OTHER_DEVICE_ID,
        source: "ceremony",
      },
      storage,
    );
    await rememberFirsthandRoot(
      { accountId: ACCOUNT, origin: ORIGIN, rootPublicKey: HOST_KEY, source: "bundle" },
      storage,
    );
    await rememberFirsthandRoot(
      {
        accountId: OTHER_ACCOUNT,
        origin: ORIGIN,
        rootPublicKey: OTHER_HOST_KEY,
        source: "bundle",
      },
      storage,
    );
    await recordSeenRevision(ACCOUNT, 9, revisionStorage);
    await recordSeenRevision(OTHER_ACCOUNT, 4, revisionStorage);

    await expect(
      removeAccountFromThisBrowser(
        { accountId: ACCOUNT, origin: ORIGIN },
        {
          identity: identityStorage,
          hostPins: storage,
          peerKeys: storage,
          rootKnowledge: storage,
        },
      ),
    ).resolves.toEqual({ hostApprovals: 1, peerDevices: 1, identity: true });

    expect(await loadBrowserDeviceIdentity(ACCOUNT, identityStorage)).toBeNull();
    expect(await loadBrowserDeviceIdentity(OTHER_ACCOUNT, identityStorage)).not.toBeNull();
    expect(
      await loadBrowserHostPin(
        {
          accountId: ACCOUNT,
          origin: ORIGIN,
          hostPublicKey: HOST_KEY,
          hostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
        },
        storage,
      ),
    ).toMatchObject({ state: "revoked" });
    expect(
      await loadBrowserHostPin(
        {
          accountId: ACCOUNT,
          origin: ORIGIN,
          hostPublicKey: OTHER_HOST_KEY,
          hostFingerprint: await ed25519PublicKeyFingerprint(OTHER_HOST_KEY),
        },
        storage,
      ),
    ).toBeNull();
    expect(
      await loadBrowserHostPin(
        {
          accountId: OTHER_ACCOUNT,
          origin: ORIGIN,
          hostPublicKey: HOST_KEY,
          hostFingerprint: await ed25519PublicKeyFingerprint(HOST_KEY),
        },
        storage,
      ),
    ).toMatchObject({ state: "active" });
    expect(await listPeerDeviceKeys({ accountId: ACCOUNT, origin: ORIGIN }, storage)).toEqual([]);
    expect(
      await listPeerDeviceKeys({ accountId: OTHER_ACCOUNT, origin: ORIGIN }, storage),
    ).toHaveLength(1);
    expect(await loadFirsthandRoot({ accountId: ACCOUNT, origin: ORIGIN }, storage)).toBeNull();
    expect(
      await loadFirsthandRoot({ accountId: OTHER_ACCOUNT, origin: ORIGIN }, storage),
    ).not.toBeNull();
    expect(await readHighestSeenRevision(ACCOUNT, revisionStorage)).toBe(9);
    expect(await readHighestSeenRevision(OTHER_ACCOUNT, revisionStorage)).toBe(4);
  });
});
