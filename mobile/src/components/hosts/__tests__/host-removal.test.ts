import { offlineHost, onlineHost, windowsHost } from "@/components/hosts/__tests__/fixtures";
import { type RemoveHostDependencies, removeHostWithTrust } from "@/data/queries/hosts";
import {
  createHostPinStore,
  type HostPin,
  type HostPinPersistence,
  type HostPinStore,
} from "@/data/trust/host-pins";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deriveEd25519PublicKey } from "@/lib/crypto/ed25519";

type LocalPin = Pick<HostPin, "hostIds" | "hostPublicKey" | "state">;

const SERVED_KEY = onlineHost.host_public_key as string;
const APPROVED_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
const ORIGIN = "https://spawn.example";

function dependencies(calls: string[], pins: readonly LocalPin[]): RemoveHostDependencies {
  return {
    accountId: jest.fn(async () => ACCOUNT_ID),
    serverOrigin: jest.fn(async () => ORIGIN),
    localPins: jest.fn(async () => pins),
    revokeLocalPin: jest.fn(async ({ hostPublicKey }) => {
      calls.push(`revoke ${hostPublicKey}`);
    }),
    removeRemote: jest.fn(async () => {
      calls.push("remove");
    }),
  };
}

describe("host removal trust sequencing", () => {
  test("tombstones the exact local trust record before server removal", async () => {
    const calls: string[] = [];
    await removeHostWithTrust(
      onlineHost,
      dependencies(calls, [
        { hostIds: [onlineHost.id], hostPublicKey: SERVED_KEY, state: "active" },
      ]),
    );
    expect(calls).toEqual([`revoke ${SERVED_KEY}`, "remove"]);
  });

  test("withdraws the identity this device approved, not the one the server now presents", async () => {
    // The identity-conflict exit: the host was reinstalled (or is being
    // impersonated) and presents a new key. The approval that dies is the one
    // this device made for this host, or it would outlive the removal.
    const calls: string[] = [];
    await removeHostWithTrust(
      onlineHost,
      dependencies(calls, [
        { hostIds: [onlineHost.id], hostPublicKey: APPROVED_KEY, state: "active" },
      ]),
    );
    expect(calls).toEqual([`revoke ${APPROVED_KEY}`, "remove"]);
  });

  test("matches an approval made before the host had an ID by its key", async () => {
    const calls: string[] = [];
    await removeHostWithTrust(
      onlineHost,
      dependencies(calls, [{ hostIds: [], hostPublicKey: SERVED_KEY, state: "active" }]),
    );
    expect(calls).toEqual([`revoke ${SERVED_KEY}`, "remove"]);
  });

  test("withdraws the presented key even when it was approved under the host's former ID", async () => {
    // Removed elsewhere and possessed again with the same stable key, the host
    // came back as a new server row. This device still connects to it through
    // the approval it made for the old row, so that is the approval that dies.
    const calls: string[] = [];
    await removeHostWithTrust(
      onlineHost,
      dependencies(calls, [
        { hostIds: [offlineHost.id], hostPublicKey: SERVED_KEY, state: "active" },
      ]),
    );
    expect(calls).toEqual([`revoke ${SERVED_KEY}`, "remove"]);
  });

  test("leaves another host's approval alone", async () => {
    const calls: string[] = [];
    await removeHostWithTrust(
      onlineHost,
      dependencies(calls, [
        { hostIds: [offlineHost.id], hostPublicKey: APPROVED_KEY, state: "active" },
      ]),
    );
    expect(calls).toEqual(["remove"]);
  });

  test("in a conflict, withdraws only the approval made for this host", async () => {
    // The key the server now claims for this host belongs to another host this
    // device approved. That approval never let this device reach the removed
    // host — the conflict blocks it — so the removal does not take it too.
    const calls: string[] = [];
    await removeHostWithTrust(
      onlineHost,
      dependencies(calls, [
        { hostIds: [onlineHost.id], hostPublicKey: APPROVED_KEY, state: "active" },
        { hostIds: [offlineHost.id], hostPublicKey: SERVED_KEY, state: "active" },
      ]),
    );
    expect(calls).toEqual([`revoke ${APPROVED_KEY}`, "remove"]);
  });

  test("leaves a tombstone from an earlier attempt as it is and retries the deletion", async () => {
    const calls: string[] = [];
    await removeHostWithTrust(
      onlineHost,
      dependencies(calls, [
        { hostIds: [onlineHost.id], hostPublicKey: SERVED_KEY, state: "revoked" },
      ]),
    );
    expect(calls).toEqual(["remove"]);
  });

  test("withdraws the approval bound to a host whose key the server withholds", async () => {
    const calls: string[] = [];
    await removeHostWithTrust(
      { ...onlineHost, host_public_key: null },
      dependencies(calls, [
        { hostIds: [onlineHost.id], hostPublicKey: SERVED_KEY, state: "active" },
      ]),
    );
    expect(calls).toEqual([`revoke ${SERVED_KEY}`, "remove"]);
  });

  test("deletes a legacy host without inventing a pin", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, [{ hostIds: [], hostPublicKey: SERVED_KEY, state: "active" }]);
    await removeHostWithTrust({ ...offlineHost, host_public_key: null }, deps);
    expect(deps.revokeLocalPin).not.toHaveBeenCalled();
    expect(calls).toEqual(["remove"]);
  });

  test("keeps server removal available when no local pin exists", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, []);
    await removeHostWithTrust(onlineHost, deps);
    expect(deps.revokeLocalPin).not.toHaveBeenCalled();
    expect(calls).toEqual(["remove"]);
  });

  test("never asks the server to delete a host whose local trust could not be withdrawn", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, [
      { hostIds: [onlineHost.id], hostPublicKey: SERVED_KEY, state: "active" },
    ]);
    deps.revokeLocalPin = jest.fn(async () => {
      throw new Error("Trust storage is unavailable");
    });
    await expect(removeHostWithTrust(onlineHost, deps)).rejects.toThrow(
      "Trust storage is unavailable",
    );
    expect(calls).toEqual([]);
  });
});

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

function keyFromSeed(byte: number): string {
  const seed = new Uint8Array(32);
  seed[31] = byte;
  return encodeBase64Url(deriveEd25519PublicKey(seed));
}

/**
 * The pin store a phone actually keeps, and the question every connection asks
 * it (`verifyDaemonHost`): does this host, presenting this key, resolve to an
 * approval this device still holds?
 */
describe("host removal against this device's pin store", () => {
  let store: HostPinStore;

  beforeEach(() => {
    store = createHostPinStore(new MemoryPersistence());
  });

  const approve = (hostPublicKey: string, hostId?: string) =>
    store.approveExact({
      accountId: ACCOUNT_ID,
      serverOrigin: ORIGIN,
      hostPublicKey,
      ...(hostId === undefined ? {} : { hostId }),
    });

  const connect = async (hostId: string, presentedHostPublicKey: string) =>
    (
      await store.resolve({
        accountId: ACCOUNT_ID,
        serverOrigin: ORIGIN,
        hostId,
        presentedHostPublicKey,
        phoneIdentityAvailable: true,
      })
    ).status;

  const remove = (host: typeof onlineHost) =>
    removeHostWithTrust(host, {
      accountId: async () => ACCOUNT_ID,
      serverOrigin: async () => ORIGIN,
      localPins: (input) => store.list(input.accountId, input.serverOrigin),
      revokeLocalPin: (input) => store.revokeExact(input),
      removeRemote: async () => undefined,
    });

  test("a pin bound to the host's former ID stops authorising it", async () => {
    await approve(SERVED_KEY, offlineHost.id);
    expect(await connect(onlineHost.id, SERVED_KEY)).toBe("match");

    await remove(onlineHost);

    expect(await connect(onlineHost.id, SERVED_KEY)).toBe("revoked");
    // Possessed yet again, the same machine comes back as a fresh row; coming
    // back takes a fresh ceremony, not the approval just withdrawn.
    expect(await connect(windowsHost.id, SERVED_KEY)).toBe("revoked");
  });

  test("a pin with no host IDs stops authorising the host", async () => {
    await approve(SERVED_KEY);
    expect(await connect(onlineHost.id, SERVED_KEY)).toBe("match");

    await remove(onlineHost);

    expect(await connect(onlineHost.id, SERVED_KEY)).toBe("revoked");
  });

  test("a pin bound only to other hosts survives", async () => {
    const otherKey = keyFromSeed(9);
    await approve(SERVED_KEY, onlineHost.id);
    await approve(otherKey, offlineHost.id);

    await remove(onlineHost);

    expect(await connect(onlineHost.id, SERVED_KEY)).toBe("revoked");
    expect(await connect(offlineHost.id, otherKey)).toBe("match");
  });

  test("in a conflict, the approval made for the host dies and another host's key survives", async () => {
    const approvedKey = keyFromSeed(7);
    await approve(approvedKey, onlineHost.id);
    await approve(SERVED_KEY, windowsHost.id);
    // The server presents another host's key for this one: blocked, not a match.
    expect(await connect(onlineHost.id, SERVED_KEY)).toBe("mismatch");

    await remove(onlineHost);

    const pins = await store.list(ACCOUNT_ID, ORIGIN);
    expect(pins.find((pin) => pin.hostPublicKey === approvedKey)?.state).toBe("revoked");
    expect(await connect(windowsHost.id, SERVED_KEY)).toBe("match");
    // Still blocked: the removed host never inherits the other host's approval.
    expect(await connect(onlineHost.id, SERVED_KEY)).toBe("mismatch");
  });

  test("a host whose key the server withholds loses the approval bound to it", async () => {
    await approve(SERVED_KEY, onlineHost.id);

    await remove({ ...onlineHost, host_public_key: null });

    expect(await connect(onlineHost.id, SERVED_KEY)).toBe("revoked");
  });
});
