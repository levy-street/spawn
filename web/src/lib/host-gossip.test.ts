import { describe, expect, test } from "bun:test";
import { planBroadcastPublishes, shouldEstablishAccountRoot } from "./host-gossip";

const OWN = "A".repeat(43);
const OTHER = "B".repeat(43);
const KEY_1 = "C".repeat(43);
const KEY_2 = "D".repeat(43);

describe("planBroadcastPublishes", () => {
  test("publishes only ACTIVE pins lacking this device's own row", () => {
    const targets = planBroadcastPublishes({
      ownPublicKey: OWN,
      pins: [
        { hostPublicKey: KEY_1, hostIds: ["0b6e6c64-0000-4000-8000-000000000001"] },
        { hostPublicKey: KEY_2, hostIds: [] },
      ],
      hostList: [
        { id: "0b6e6c64-0000-4000-8000-000000000001", name: "macbook", host_public_key: KEY_1 },
        { id: "0b6e6c64-0000-4000-8000-000000000002", name: "minivac", host_public_key: KEY_2 },
      ],
      rows: [
        // Our row for KEY_1 already exists; someone ELSE's row for KEY_2 does
        // not count as ours.
        { publisher_public_key: OWN, host_public_key: KEY_1 },
        { publisher_public_key: OTHER, host_public_key: KEY_2 },
      ],
    });
    expect(targets).toEqual([
      {
        hostId: "0b6e6c64-0000-4000-8000-000000000002",
        hostName: "minivac",
        hostPublicKey: KEY_2,
      },
    ]);
  });

  test("a pin bound to no host id yet is skipped (a later sweep retries)", () => {
    const targets = planBroadcastPublishes({
      ownPublicKey: OWN,
      pins: [{ hostPublicKey: KEY_1, hostIds: [] }],
      hostList: [],
      rows: [],
    });
    expect(targets).toEqual([]);
  });
});

describe("shouldEstablishAccountRoot (passkey-free establishment gate)", () => {
  const liveRoot = { is_root: true, revoked_at: null };
  const revokedRoot = { is_root: true, revoked_at: "2026-08-24T00:00:00Z" };
  const plainDevice = { is_root: false, revoked_at: null };
  // The eligible baseline: no bundle, this device live, then vary one field.
  const eligible = {
    holdsFirsthandRoot: false,
    bundleAbsent: true,
    selfIsLive: true,
    deviceRows: [plainDevice],
    activePinCount: 1,
  };

  test("mints when no root exists anywhere and this device is pinned", () => {
    expect(shouldEstablishAccountRoot(eligible)).toBe(true);
  });

  test("idempotent: a LIVE is_root row means consume, never mint a rival", () => {
    expect(shouldEstablishAccountRoot({ ...eligible, deviceRows: [plainDevice, liveRoot] })).toBe(
      false,
    );
  });

  test("a device that already knows a root firsthand never re-mints", () => {
    expect(shouldEstablishAccountRoot({ ...eligible, holdsFirsthandRoot: true })).toBe(false);
  });

  test("an unpinned device is not an established member and does not mint", () => {
    expect(shouldEstablishAccountRoot({ ...eligible, activePinCount: 0 })).toBe(false);
  });

  test("a merely REVOKED is_root row does not block a fresh mint", () => {
    expect(
      shouldEstablishAccountRoot({ ...eligible, deviceRows: [plainDevice, revokedRoot] }),
    ).toBe(true);
  });

  test("a passkey bundle owns the root: never mint a rival (also fails closed on fetch error)", () => {
    expect(shouldEstablishAccountRoot({ ...eligible, bundleAbsent: false })).toBe(false);
  });

  test("a revoked or absent device never mints a root nobody can heal", () => {
    expect(shouldEstablishAccountRoot({ ...eligible, selfIsLive: false })).toBe(false);
  });
});
