import {
  createHostPinStore,
  formatHostFingerprint,
  type HostPin,
  type HostPinPersistence,
  hostPinRecordCounts,
} from "@/data/trust/host-pins";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deriveEd25519PublicKey } from "@/lib/crypto/ed25519";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "11111111-2222-4333-8444-555555555555";
const ORIGIN = "https://spawn.example";
const HOST_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const OTHER_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

class MemoryPersistence implements HostPinPersistence {
  pins: HostPin[] = [];
  unreadable = false;

  async load(accountId: string, serverOrigin: string): Promise<readonly unknown[]> {
    if (this.unreadable) throw new Error("unreadable");
    return this.pins.filter(
      (pin) => pin.accountId === accountId && pin.serverOrigin === serverOrigin,
    );
  }

  async save(pin: HostPin): Promise<void> {
    if (this.unreadable) throw new Error("unreadable");
    this.pins = this.pins.filter(
      (candidate) =>
        candidate.accountId !== pin.accountId ||
        candidate.serverOrigin !== pin.serverOrigin ||
        candidate.hostPublicKey !== pin.hostPublicKey,
    );
    this.pins.push(pin);
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.pins = this.pins.filter((pin) => pin.accountId !== accountId || pin.state === "revoked");
  }
}

function generatedPin(index: number, state: "active" | "revoked"): HostPin {
  const seed = new Uint8Array(32);
  seed[31] = index;
  const hostPublicKey = encodeBase64Url(deriveEd25519PublicKey(seed));
  return {
    accountId: ACCOUNT_ID,
    serverOrigin: ORIGIN,
    hostPublicKey,
    hostFingerprint: formatHostFingerprint(hostPublicKey),
    hostIds: [],
    state,
    createdAtMs: 1,
    approvedAtMs: 1,
    revokedAtMs: state === "revoked" ? 2 : null,
  };
}

describe("host pin trust decisions", () => {
  let persistence: MemoryPersistence;

  beforeEach(() => {
    persistence = new MemoryPersistence();
  });

  test("matches an exact account/origin/key pin", async () => {
    const store = createHostPinStore(persistence);
    await store.approveExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: HOST_KEY,
      hostId: HOST_ID,
      approvedAtMs: 10,
    });
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        hostId: HOST_ID,
        presentedHostPublicKey: HOST_KEY,
        phoneIdentityAvailable: true,
      }),
    ).resolves.toMatchObject({ status: "match" });
  });

  test("distinguishes mismatch, missing, revoked, and missing identities", async () => {
    const store = createHostPinStore(persistence);
    await store.approveExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: HOST_KEY,
      hostId: HOST_ID,
    });
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        hostId: HOST_ID,
        presentedHostPublicKey: OTHER_KEY,
        phoneIdentityAvailable: true,
      }),
    ).resolves.toMatchObject({ status: "mismatch" });
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        presentedHostPublicKey: OTHER_KEY,
        phoneIdentityAvailable: true,
      }),
    ).resolves.toMatchObject({ status: "missing" });

    await store.revokeExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: HOST_KEY,
    });
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        hostId: HOST_ID,
        presentedHostPublicKey: HOST_KEY,
        phoneIdentityAvailable: true,
      }),
    ).resolves.toMatchObject({ status: "revoked" });
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        presentedHostPublicKey: HOST_KEY,
        phoneIdentityAvailable: false,
      }),
    ).resolves.toEqual({ status: "identity-missing" });
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        presentedHostPublicKey: null,
        phoneIdentityAvailable: true,
      }),
    ).resolves.toEqual({ status: "host-identity-withheld" });
  });

  test("rejects a key trusted for another host when the requested alias conflicts", async () => {
    const store = createHostPinStore(persistence);
    await store.approveExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: HOST_KEY,
      hostId: HOST_ID,
    });
    await store.approveExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: OTHER_KEY,
    });
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        hostId: HOST_ID,
        presentedHostPublicKey: OTHER_KEY,
        phoneIdentityAvailable: true,
      }),
    ).resolves.toMatchObject({ status: "mismatch" });
  });

  test("fails closed when durable storage is unreadable", async () => {
    persistence.unreadable = true;
    const store = createHostPinStore(persistence);
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        presentedHostPublicKey: HOST_KEY,
        phoneIdentityAvailable: true,
      }),
    ).resolves.toMatchObject({ status: "storage-unavailable" });
  });

  test("fails closed when a durable pin is corrupt", async () => {
    persistence.pins = [
      {
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        hostPublicKey: HOST_KEY,
        hostFingerprint: "SHA256:corrupt",
        hostIds: [],
        state: "active",
        createdAtMs: 1,
        approvedAtMs: 1,
        revokedAtMs: null,
      },
    ];
    const store = createHostPinStore(persistence);
    await expect(
      store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        presentedHostPublicKey: HOST_KEY,
        phoneIdentityAvailable: true,
      }),
    ).resolves.toMatchObject({ status: "storage-unavailable" });
  });

  test("isolates pins by account and exact origin", async () => {
    const store = createHostPinStore(persistence);
    await store.approveExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: HOST_KEY,
    });
    await expect(store.list(ACCOUNT_ID, "https://other.example")).resolves.toHaveLength(0);
    await expect(store.list("00000000-0000-4000-8000-000000000002", ORIGIN)).resolves.toHaveLength(
      0,
    );
  });

  test("keeps tombstones through account cleanup", async () => {
    const store = createHostPinStore(persistence);
    await store.approveExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: HOST_KEY,
    });
    await store.approveExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: OTHER_KEY,
    });
    await store.revokeExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey: HOST_KEY,
    });

    await store.clearAccount(ACCOUNT_ID);

    await expect(store.list(ACCOUNT_ID, ORIGIN)).resolves.toMatchObject([
      { hostPublicKey: HOST_KEY, state: "revoked" },
    ]);
  });

  test("counts active records separately so 256 tombstones do not consume the cap", async () => {
    const store = createHostPinStore(persistence);
    persistence.pins = Array.from({ length: 256 }, (_, index) => generatedPin(index, "revoked"));
    expect(hostPinRecordCounts(persistence.pins)).toEqual({ active: 0, tombstones: 256 });
    await expect(
      store.approveExact({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        hostPublicKey: OTHER_KEY,
      }),
    ).resolves.toMatchObject({ state: "active" });

    persistence.pins = Array.from({ length: 256 }, (_, index) => generatedPin(index, "active"));
    await expect(
      store.approveExact({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        hostPublicKey: OTHER_KEY,
      }),
    ).rejects.toMatchObject({ code: "PIN_LIMIT" });
  });
});
