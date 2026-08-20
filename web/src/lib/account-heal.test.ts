import { describe, expect, test } from "bun:test";
import { AccountHealError, planAccountHeal } from "./account-heal";

const ROOT_PK = "R".repeat(43);

function device(id: string, publicKey: string, opts: { revoked?: boolean; isRoot?: boolean } = {}) {
  return {
    id,
    public_key: publicKey,
    revoked_at: opts.revoked ? "2026-08-20T00:00:00Z" : null,
    is_root: opts.isRoot ?? false,
  };
}

const edge = (endorser: string, endorsed: string) => ({
  endorser_device_id: endorser,
  endorsed_device_id: endorsed,
});

describe("planAccountHeal", () => {
  test("plans R→d for live devices lacking one; skips endorsed, revoked, and the root", () => {
    const devices = [
      device("root", ROOT_PK, { isRoot: true }),
      device("laptop", "A".repeat(43)),
      device("phone", "B".repeat(43)),
      device("old", "C".repeat(43), { revoked: true }),
    ];
    const plan = planAccountHeal(ROOT_PK, devices, [edge("root", "laptop")]);
    expect(plan.rootDevice?.id).toBe("root");
    expect(plan.devicesToEndorse.map((d) => d.id)).toEqual(["phone"]);
  });

  test("a server root that differs from the sealed root aborts the heal", () => {
    // The bundle is the authority on pk_R: a substituted is_root row must never
    // be endorsed or anchored.
    const devices = [device("evil", "X".repeat(43), { isRoot: true })];
    expect(() => planAccountHeal(ROOT_PK, devices, [])).toThrow(AccountHealError);
    try {
      planAccountHeal(ROOT_PK, devices, []);
    } catch (error) {
      expect((error as AccountHealError).code).toBe("root_conflict");
    }
  });

  test("a REVOKED conflicting root does not block a fresh one", () => {
    // Root rotation: the old root's tombstone stays; the new root heals.
    const devices = [
      device("old-root", "X".repeat(43), { isRoot: true, revoked: true }),
      device("root", ROOT_PK, { isRoot: true }),
      device("laptop", "A".repeat(43)),
    ];
    const plan = planAccountHeal(ROOT_PK, devices, []);
    expect(plan.rootDevice?.id).toBe("root");
    expect(plan.devicesToEndorse.map((d) => d.id)).toEqual(["laptop"]);
  });

  test("no registered root yields an empty plan, not an error", () => {
    const plan = planAccountHeal(ROOT_PK, [device("laptop", "A".repeat(43))], []);
    expect(plan.rootDevice).toBeNull();
    expect(plan.devicesToEndorse).toEqual([]);
  });

  test("edges from other endorsers do not count as root endorsements", () => {
    const devices = [device("root", ROOT_PK, { isRoot: true }), device("laptop", "A".repeat(43))];
    const plan = planAccountHeal(ROOT_PK, devices, [edge("phone", "laptop")]);
    expect(plan.devicesToEndorse.map((d) => d.id)).toEqual(["laptop"]);
  });
});
