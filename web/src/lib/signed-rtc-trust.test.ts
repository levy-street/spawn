import { beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { loadOrCreateBrowserDeviceIdentity } from "./browser-device-identity";
import {
  approveBrowserHostPin,
  resolveActiveBrowserHostPin,
  revokeBrowserHostPin,
} from "./browser-host-pins";
import { resolveSignedRtcTrust } from "./signed-rtc-trust";
import { ed25519PublicKeyFingerprint } from "./signed-signal";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "00000000-0000-4000-8000-000000000003";
const ORIGIN = "https://spawn.example";
const HOST_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const OTHER_HOST_KEY = "11qYAYdk9Jt0uvL7Tp_5eQK8heP0LOEYVVt4dSK3M3A";

let hostFactory: IDBFactory;
let deviceFactory: IDBFactory;
let HOST_FP: string;
let OTHER_FP: string;

const hostPinStorage = () => ({ indexedDBFactory: hostFactory, now: () => 1_000 }) as const;
const deviceIdentityStorage = () => ({ indexedDBFactory: deviceFactory }) as const;

async function seedPin(key = HOST_KEY, fingerprint = HOST_FP): Promise<void> {
  await approveBrowserHostPin(
    { accountId: ACCOUNT, origin: ORIGIN, hostPublicKey: key, hostFingerprint: fingerprint },
    hostPinStorage(),
  );
}

/** Bind HOST_ID to a locally-approved key by performing one honest resolve. */
async function bindHostId(key = HOST_KEY, fingerprint = HOST_FP): Promise<void> {
  await resolveActiveBrowserHostPin(
    {
      accountId: ACCOUNT,
      origin: ORIGIN,
      hostId: HOST_ID,
      claimedHostPublicKey: key,
      claimedHostFingerprint: fingerprint,
    },
    hostPinStorage(),
  );
}

async function seedDeviceIdentity(): Promise<void> {
  await loadOrCreateBrowserDeviceIdentity(ACCOUNT, deviceIdentityStorage());
}

function resolve(overrides: Partial<Parameters<typeof resolveSignedRtcTrust>[0]> = {}) {
  return resolveSignedRtcTrust({
    accountId: ACCOUNT,
    hostId: HOST_ID,
    origin: ORIGIN,
    claimedHostPublicKey: HOST_KEY,
    claimedHostFingerprint: HOST_FP,
    isActive: () => true,
    hostPinStorage: hostPinStorage(),
    deviceIdentityStorage: deviceIdentityStorage(),
    ...overrides,
  });
}

beforeEach(async () => {
  hostFactory = new IDBFactory();
  deviceFactory = new IDBFactory();
  HOST_FP = await ed25519PublicKeyFingerprint(HOST_KEY);
  OTHER_FP = await ed25519PublicKeyFingerprint(OTHER_HOST_KEY);
});

describe("resolveSignedRtcTrust gate", () => {
  test("pinned host + matching claimed key => signed (mandatory)", async () => {
    await seedPin();
    await seedDeviceIdentity();
    const decision = await resolve();
    expect(decision.mode).toBe("signed");
    if (decision.mode !== "signed") throw new Error("unreachable");
    expect(decision.hostVerified).toBe(true);
    expect(decision.capability.hostPublicKeyWire).toBe(HOST_KEY);
    expect(typeof decision.capability.signOffer).toBe("function");
  });

  test("never-approved keyed host with an identity => signed TOFU on the claimed key", async () => {
    // The daemon can authenticate this browser (mandatory under enforcement)
    // even though the host is first-contact; the claimed key anchors answer
    // verification, which the raw path never had. No pin is created.
    await seedDeviceIdentity();
    const decision = await resolve();
    expect(decision.mode).toBe("signed");
    if (decision.mode !== "signed") throw new Error("unreachable");
    // First contact: signed, but the host is NOT verified — the UI must be
    // able to tell this apart from a pin-anchored session.
    expect(decision.hostVerified).toBe(false);
    expect(decision.capability.hostPublicKeyWire).toBe(HOST_KEY);
    expect(typeof decision.capability.signOffer).toBe("function");
  });

  test("never-approved keyed host without an identity => unpinned (raw TOFU)", async () => {
    const decision = await resolve();
    expect(decision.mode).toBe("unpinned");
  });

  test("signed TOFU never creates or binds a local pin", async () => {
    await seedDeviceIdentity();
    const first = await resolve();
    expect(first.mode).toBe("signed");
    // A later withheld key must still be treated as a never-pinned host (raw
    // or refused elsewhere), not as a downgrade from a pin this path must not
    // have created.
    const withheld = await resolve({
      claimedHostPublicKey: null,
      claimedHostFingerprint: null,
    });
    expect(withheld.mode).toBe("unpinned");
  });

  test("null claimed key on a never-pinned host => unpinned (legacy preserved)", async () => {
    const decision = await resolve({
      claimedHostPublicKey: null,
      claimedHostFingerprint: null,
    });
    expect(decision.mode).toBe("unpinned");
  });

  test("DOWNGRADE: null claimed key on an already-pinned hostId => refuse (withheld)", async () => {
    await seedPin();
    await bindHostId();
    const decision = await resolve({
      claimedHostPublicKey: null,
      claimedHostFingerprint: null,
    });
    expect(decision.mode).toBe("refuse");
    if (decision.mode !== "refuse") throw new Error("unreachable");
    expect(decision.reason).toBe("host_key_withheld");
  });

  test("SUBSTITUTION: foreign key on an already-pinned hostId => refuse (substituted)", async () => {
    await seedPin();
    await bindHostId();
    const decision = await resolve({
      claimedHostPublicKey: OTHER_HOST_KEY,
      claimedHostFingerprint: OTHER_FP,
    });
    expect(decision.mode).toBe("refuse");
    if (decision.mode !== "refuse") throw new Error("unreachable");
    expect(decision.reason).toBe("host_key_substituted");
  });

  test("revoked pin => refuse (revoked), never raw", async () => {
    await seedPin();
    await bindHostId();
    await revokeBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        targetHostId: HOST_ID,
        claimedHostId: HOST_ID,
        claimedHostPublicKey: HOST_KEY,
        claimedHostFingerprint: HOST_FP,
      },
      hostPinStorage(),
    );
    const decision = await resolve();
    expect(decision.mode).toBe("refuse");
    if (decision.mode !== "refuse") throw new Error("unreachable");
    expect(decision.reason).toBe("host_key_revoked");
  });

  test("pinned host but no browser signing identity => refuse (never downgrade)", async () => {
    await seedPin();
    // deliberately do NOT seed a device identity
    const decision = await resolve();
    expect(decision.mode).toBe("refuse");
    if (decision.mode !== "refuse") throw new Error("unreachable");
    expect(decision.reason).toBe("browser_identity_unavailable");
  });

  test("non-secure context (no WebCrypto) => unpinned, never refuse", async () => {
    // A pin can never have been approved in an origin without WebCrypto, so
    // there is nothing to downgrade from; refusing would break all traffic.
    await seedPin();
    await bindHostId();
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: realCrypto.getRandomValues?.bind(realCrypto) },
      configurable: true,
    });
    try {
      const decision = await resolve();
      expect(decision.mode).toBe("unpinned");
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
    }
  });

  test("signed capability.assertActive throws once the trust epoch ends", async () => {
    await seedPin();
    await seedDeviceIdentity();
    let active = true;
    const decision = await resolve({ isActive: () => active });
    expect(decision.mode).toBe("signed");
    if (decision.mode !== "signed") throw new Error("unreachable");
    expect(() => decision.capability.assertActive()).not.toThrow();
    active = false;
    expect(() => decision.capability.assertActive()).toThrow();
  });
});
