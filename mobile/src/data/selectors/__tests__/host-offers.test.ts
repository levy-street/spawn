import {
  deriveHostOffers,
  HOST_OFFER_SLOTS,
  type HostOfferSlotId,
  SHIPPED_HOST_OFFERS,
} from "@/data/selectors/host-offers";

/** A build that could draw every slot, to test what a host's hello lights. */
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

describe("host offers", () => {
  test("no host lights a slot today, a Mac's reveal and open included", () => {
    for (const capabilities of [TODAY_LINUX, TODAY_MAC, [], null, undefined]) {
      expect(deriveHostOffers(capabilities).slots).toEqual([]);
      expect(deriveHostOffers(capabilities, EVERY_SLOT).slots).toEqual([]);
    }
  });

  test("lights only Unfinished moves in this build, on conv.v2 alone", () => {
    expect([...SHIPPED_HOST_OFFERS]).toEqual(["moves"]);
    expect(deriveHostOffers(EVERY_FAMILY).slots.map((slot) => slot.id)).toEqual(["moves"]);
    expect(deriveHostOffers(EVERY_FAMILY).slots.map((slot) => slot.label)).toEqual([
      "Unfinished moves",
    ]);
    expect(deriveHostOffers(EVERY_FAMILY).has("desktop")).toBe(false);
    // The conversation list is reserved, not drawn yet.
    expect(deriveHostOffers(EVERY_FAMILY).has("conversations")).toBe(false);
    // conv.v1 is inspect only: it lists nothing.
    expect(deriveHostOffers(["conv.v1"]).has("moves")).toBe(false);
    expect(deriveHostOffers(["conv.v1", "conv.v2"]).has("moves")).toBe(true);
  });

  test("a slot needs both its family on the host and a view in this build", () => {
    expect(deriveHostOffers([], EVERY_SLOT).slots).toEqual([]);
    expect(deriveHostOffers(["screen.v1"], new Set<HostOfferSlotId>(["boxes"])).slots).toEqual([]);
    const lit = deriveHostOffers(["screen.v1"], new Set<HostOfferSlotId>(["desktop"]));
    expect(lit.slots.map((slot) => slot.id)).toEqual(["desktop"]);
    expect(lit.has("desktop")).toBe(true);
    expect(lit.has("boxes")).toBe(false);
  });

  test("desktop lights on the screen family alone, never on a name that shares its prefix", () => {
    expect(
      deriveHostOffers(["desktop.reveal", "desktop.open", "desktop.view"], EVERY_SLOT).has(
        "desktop",
      ),
    ).toBe(false);
    expect(deriveHostOffers(["screen.v1"], EVERY_SLOT).has("desktop")).toBe(true);
    expect(deriveHostOffers(["screen.v10"], EVERY_SLOT).has("desktop")).toBe(false);
  });

  test("conversations and unfinished moves need conv.v2, not conv.v1 alone", () => {
    for (const slot of ["conversations", "moves"] as const) {
      expect(deriveHostOffers(["conv.v1"], EVERY_SLOT).has(slot)).toBe(false);
      expect(deriveHostOffers(["conv.v1", "conv.v2"], EVERY_SLOT).has(slot)).toBe(true);
    }
  });

  test("each family lights its own slot, in the registry's order", () => {
    const offers = deriveHostOffers(
      ["box.v1", "agent.accounts.v1", "screen.v1", "conv.v2"],
      EVERY_SLOT,
    );
    expect(offers.slots.map((slot) => slot.id)).toEqual([
      "desktop",
      "conversations",
      "moves",
      "claude-accounts",
      "boxes",
    ]);
    expect(offers.slots.find((slot) => slot.id === "desktop")?.placement).toBe("screen");
    expect(
      offers.slots.filter((slot) => slot.placement === "panel").map((slot) => slot.label),
    ).toEqual(["Conversations", "Unfinished moves", "Claude accounts", "Boxes"]);
  });

  test("a Mac's hello lights only what a Linux host's would", () => {
    // The OS is not an input: a slot follows the hello alone.
    expect(deriveHostOffers(TODAY_MAC, EVERY_SLOT).slots).toEqual(
      deriveHostOffers(TODAY_LINUX, EVERY_SLOT).slots,
    );
    expect(deriveHostOffers([...TODAY_MAC, "screen.v1"], EVERY_SLOT).has("desktop")).toBe(true);
  });

  test("every slot is keyed by one versioned capability family", () => {
    for (const slot of HOST_OFFER_SLOTS) expect(slot.capability).toMatch(/^[a-z.]+\.v\d+$/);
  });
});
