import {
  type LocalTrustAccountPersistence,
  removeLocalTrustAccount,
} from "@/data/trust/local-account";

const ACCOUNT_A = "00000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "00000000-0000-4000-8000-000000000002";

class MemoryAccountPersistence implements LocalTrustAccountPersistence {
  activeHostApprovals = [ACCOUNT_A, ACCOUNT_B];
  hostTombstones = [ACCOUNT_A, ACCOUNT_B];
  peerDeviceKeys = [ACCOUNT_A, ACCOUNT_B];
  rootKnowledge = [ACCOUNT_A, ACCOUNT_B];
  revisionFloor = new Map([
    [ACCOUNT_A, 9],
    [ACCOUNT_B, 4],
  ]);

  async deleteActiveHostApprovals(accountId: string): Promise<void> {
    this.activeHostApprovals = this.activeHostApprovals.filter((value) => value !== accountId);
  }

  async deletePeerDeviceKeys(accountId: string): Promise<void> {
    this.peerDeviceKeys = this.peerDeviceKeys.filter((value) => value !== accountId);
  }

  async deleteRootKnowledge(accountId: string): Promise<void> {
    this.rootKnowledge = this.rootKnowledge.filter((value) => value !== accountId);
  }
}

describe("local account trust-store cleanup", () => {
  it("is account-scoped and preserves tombstones plus the trust-revision floor", async () => {
    const persistence = new MemoryAccountPersistence();
    const identities = new Set([ACCOUNT_A, ACCOUNT_B]);

    await removeLocalTrustAccount(ACCOUNT_A, {
      persistence,
      resetIdentity: async (accountId) => {
        identities.delete(accountId);
      },
    });

    expect(persistence.activeHostApprovals).toEqual([ACCOUNT_B]);
    expect(persistence.peerDeviceKeys).toEqual([ACCOUNT_B]);
    expect(persistence.rootKnowledge).toEqual([ACCOUNT_B]);
    expect(identities).toEqual(new Set([ACCOUNT_B]));
    expect(persistence.hostTombstones).toEqual([ACCOUNT_A, ACCOUNT_B]);
    expect(persistence.revisionFloor).toEqual(
      new Map([
        [ACCOUNT_A, 9],
        [ACCOUNT_B, 4],
      ]),
    );
  });
});
