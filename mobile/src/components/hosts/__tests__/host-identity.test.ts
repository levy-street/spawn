import { onlineHost } from "@/components/hosts/__tests__/fixtures";
import {
  type HostIdentityDependencies,
  hostIdentityConflicts,
  removeHostWithTrust,
} from "@/data/queries/hosts";
import { createHostPinStore, type HostPin, type HostPinPersistence } from "@/data/trust/host-pins";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deriveEd25519PublicKey } from "@/lib/crypto/ed25519";

const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
const ORIGIN = "https://spawn.example";

class MemoryPersistence implements HostPinPersistence {
  pins: HostPin[] = [];

  async load(): Promise<readonly unknown[]> {
    return this.pins;
  }

  async save(pin: HostPin): Promise<void> {
    this.pins = [...this.pins.filter((each) => each.hostPublicKey !== pin.hostPublicKey), pin];
  }

  async deleteAccount(): Promise<void> {
    this.pins = [];
  }
}

function anotherKey(): string {
  const seed = new Uint8Array(32);
  seed[31] = 7;
  return encodeBase64Url(deriveEd25519PublicKey(seed));
}

async function storeApproving(hostPublicKey: string, hostId?: string) {
  const store = createHostPinStore(new MemoryPersistence());
  await approve(store, hostPublicKey, hostId);
  const dependencies: HostIdentityDependencies = {
    openHostPinStore: async () => store,
    serverOrigin: async () => ORIGIN,
  };
  return { dependencies, store };
}

async function approve(
  store: ReturnType<typeof createHostPinStore>,
  hostPublicKey: string,
  hostId?: string,
) {
  await store.approveExact({
    accountId: ACCOUNT_ID,
    serverOrigin: ORIGIN,
    hostPublicKey,
    ...(hostId === undefined ? {} : { hostId }),
  });
}

describe("host identity conflict", () => {
  const lookup = {
    accountId: ACCOUNT_ID,
    hostId: onlineHost.id,
    hostPublicKey: onlineHost.host_public_key as string,
  };

  test("a host presenting the identity this device approved is no conflict", async () => {
    const { dependencies } = await storeApproving(lookup.hostPublicKey, onlineHost.id);
    await expect(hostIdentityConflicts(lookup, dependencies)).resolves.toBe(false);
  });

  test("a host presenting a different identity than the one approved for it is", async () => {
    const { dependencies } = await storeApproving(anotherKey(), onlineHost.id);
    await expect(hostIdentityConflicts(lookup, dependencies)).resolves.toBe(true);
  });

  test("removing a host in conflict withdraws the approval this device made for it", async () => {
    const approvedKey = anotherKey();
    const { store } = await storeApproving(approvedKey, onlineHost.id);
    const removeRemote = jest.fn(async () => undefined);

    await removeHostWithTrust(onlineHost, {
      accountId: async () => ACCOUNT_ID,
      serverOrigin: async () => ORIGIN,
      localPins: (input) => store.list(input.accountId, input.serverOrigin),
      revokeLocalPin: (input) => store.revokeExact(input),
      removeRemote,
    });

    const pins = await store.list(ACCOUNT_ID, ORIGIN);
    expect(pins).toEqual([
      expect.objectContaining({ hostPublicKey: approvedKey, state: "revoked" }),
    ]);
    expect(removeRemote).toHaveBeenCalledWith(onlineHost.id);
  });

  test("a host this device never approved is not a conflict, only unapproved", async () => {
    const { dependencies } = await storeApproving(anotherKey());
    await expect(hostIdentityConflicts(lookup, dependencies)).resolves.toBe(false);
  });
});
