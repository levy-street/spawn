import { offlineHost, onlineHost } from "@/components/hosts/__tests__/fixtures";
import { type RemoveHostDependencies, removeHostWithTrust } from "@/data/queries/hosts";

function dependencies(calls: string[], hasPin = true): RemoveHostDependencies {
  return {
    accountId: jest.fn(async () => "66666666-6666-4666-8666-666666666666"),
    serverOrigin: jest.fn(async () => "https://spawn.example"),
    hasLocalPin: jest.fn(async () => hasPin),
    revokeLocalPin: jest.fn(async () => {
      calls.push("revoke");
    }),
    removeRemote: jest.fn(async () => {
      calls.push("remove");
    }),
  };
}

describe("host removal trust sequencing", () => {
  test("tombstones the exact local trust record before server removal", async () => {
    const calls: string[] = [];
    await removeHostWithTrust(onlineHost, dependencies(calls));
    expect(calls).toEqual(["revoke", "remove"]);
  });

  test("deletes a legacy host without inventing a pin", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    await removeHostWithTrust(
      { ...offlineHost, host_public_key: null, host_key_fingerprint: null },
      deps,
    );
    expect(deps.hasLocalPin).not.toHaveBeenCalled();
    expect(calls).toEqual(["remove"]);
  });

  test("keeps server removal available when no local pin exists", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, false);
    await removeHostWithTrust(onlineHost, deps);
    expect(deps.revokeLocalPin).not.toHaveBeenCalled();
    expect(calls).toEqual(["remove"]);
  });
});
