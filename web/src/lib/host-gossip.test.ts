import { describe, expect, test } from "bun:test";
import { planBroadcastPublishes } from "./host-gossip";

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
