import assert from "node:assert/strict";
import {
  deriveHostOffers,
  HOST_OFFER_SLOTS,
  type HostOfferSlotId,
  NO_HOST_OFFERS,
  SHIPPED_HOST_OFFERS,
} from "./host-offers";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void): void;

const EVERY_SLOT: ReadonlySet<HostOfferSlotId> = new Set(HOST_OFFER_SLOTS.map((slot) => slot.id));
const EVERY_FAMILY = HOST_OFFER_SLOTS.map((slot) => slot.capability);

/** What D1 daemons advertise today, macOS ones included (`host_control.rs`). */
const TODAY_LINUX = [
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.read.range",
  "fs.write.begin",
  "fs.mkdir",
  "fs.rename",
  "fs.delete",
  "host.metrics",
  "agent.transcripts",
  "conv.v1",
];
const TODAY_MAC = [...TODAY_LINUX, "fs.preview", "desktop.reveal", "desktop.open"];

describe("deriveHostOffers", () => {
  test("lights nothing in this build, whatever a host advertises", () => {
    assert.equal(SHIPPED_HOST_OFFERS.size, 0);
    assert.deepEqual(deriveHostOffers(EVERY_FAMILY), NO_HOST_OFFERS);
  });

  test("no host today lights a slot, even with every view shipped", () => {
    for (const capabilities of [TODAY_LINUX, TODAY_MAC, []]) {
      assert.deepEqual(deriveHostOffers(capabilities, EVERY_SLOT), NO_HOST_OFFERS);
    }
  });

  test("a slot needs both its family on the host and a view in this build", () => {
    assert.deepEqual(deriveHostOffers([], EVERY_SLOT), NO_HOST_OFFERS);
    const desktopOnly = deriveHostOffers(["screen.v1"], new Set<HostOfferSlotId>(["boxes"]));
    assert.deepEqual(desktopOnly, NO_HOST_OFFERS);
    const lit = deriveHostOffers(["screen.v1"], new Set<HostOfferSlotId>(["desktop"]));
    assert.deepEqual(
      lit.tabs.map((slot) => slot.id),
      ["desktop"],
    );
    assert.deepEqual(lit.panels, []);
  });

  test("the file-on-screen capabilities never light the Desktop tab", () => {
    const offers = deriveHostOffers(
      new Set(["desktop.reveal", "desktop.open", "desktop.view", "screen.v10"]),
      EVERY_SLOT,
    );
    assert.deepEqual(offers, NO_HOST_OFFERS);
  });

  test("conversations need the family version that lists them, not inspect alone", () => {
    const inspectOnly = deriveHostOffers(["conv.v1"], EVERY_SLOT);
    assert.deepEqual(inspectOnly, NO_HOST_OFFERS);
    const listed = deriveHostOffers(["conv.v1", "conv.v2"], EVERY_SLOT);
    assert.deepEqual(
      listed.panels.map((slot) => slot.id),
      ["conversations"],
    );
  });

  test("Desktop is a tab of its own; the rest are Overview sections, in registry order", () => {
    assert.deepEqual(
      HOST_OFFER_SLOTS.map((slot) => slot.id),
      ["desktop", "conversations", "claude-accounts", "boxes"],
    );
    const offers = deriveHostOffers(
      new Set(["box.v1", "agent.accounts.v1", "screen.v1", "conv.v2"]),
      EVERY_SLOT,
    );
    assert.deepEqual(
      offers.tabs.map((slot) => slot.segment),
      ["desktop"],
    );
    assert.deepEqual(
      offers.panels.map((slot) => slot.label),
      ["Conversations", "Claude accounts", "Boxes"],
    );
  });

  test("each slot waits on one versioned family", () => {
    for (const slot of HOST_OFFER_SLOTS) assert.match(slot.capability, /^[a-z.]+\.v\d+$/u);
  });
});
