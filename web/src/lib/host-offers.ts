/**
 * What a host's page may offer beyond its four fixed tabs, decided by what
 * that host's daemon advertises — never by its OS, and never by the server.
 *
 * Every later surface of the host page registers here, once: a remote
 * desktop (a tab of its own), and the conversations a host keeps, the moves
 * it holds that did not finish, its Claude accounts and its boxes (sections
 * of Overview).
 * Each waits on one versioned capability family (`screen.v1`, not a list of
 * ops), so a daemon's hello stays a short list however much it learns. A slot
 * is lit only when both halves are true: the host advertises its family, and
 * this build of SPAWN D can draw it (`SHIPPED_HOST_OFFERS`). Until then the
 * page renders nothing for it — no tab, no teaser, no "coming soon".
 *
 * The capabilities come from the device's own connection to the host (its
 * hello, over the encrypted channel), so nothing here is anything the server
 * said. `desktop.reveal` and `desktop.open`, which macOS daemons already
 * advertise, show a file on the host's own screen and never light the Desktop
 * tab. A family name fixes its set of operations, so a slot waits on the
 * version that brings what it draws.
 *
 * The phone keeps the same registry: the same slots, with the same ids and
 * labels, waiting on the same families
 * (`mobile/src/data/selectors/host-offers.ts`).
 *
 * Pure and DOM-free.
 */

export type HostOfferSlotId = "desktop" | "conversations" | "moves" | "claude-accounts" | "boxes";

/**
 * "tab": a destination of its own, entered from the section row (the remote
 * desktop, whose viewer is a full-bleed route). "overview": a section of
 * Overview.
 */
export type HostOfferPlacement = "tab" | "overview";

export interface HostOfferSlot {
  id: HostOfferSlotId;
  placement: HostOfferPlacement;
  /** The capability family the host must advertise. */
  capability: string;
  /** What the tab or section is called. */
  label: string;
  /** The route segment under /hosts/[id] for a tab. */
  segment?: string;
}

/** In registry order — the order their tabs and sections appear in. */
export const HOST_OFFER_SLOTS: readonly HostOfferSlot[] = [
  // Remote desktop. `desktop.reveal` and `desktop.open` — showing a file on a
  // Mac's own screen — are older and unrelated, and never light it.
  {
    id: "desktop",
    placement: "tab",
    capability: "screen.v1",
    label: "Desktop",
    segment: "desktop",
  },
  // The conversations a host holds. `conv.v1` is the family as it first
  // shipped (conv.inspect alone, which Restart uses); the list is the version
  // that adds conv.transfers, so a host that only inspects shows nothing here.
  {
    id: "conversations",
    placement: "overview",
    capability: "conv.v2",
    label: "Conversations",
  },
  // Moves that did not finish, as the host keeps them (`conv.transfers`),
  // each resolvable from here whoever started it. Draws nothing when none.
  {
    id: "moves",
    placement: "overview",
    capability: "conv.v2",
    label: "Unfinished moves",
  },
  {
    id: "claude-accounts",
    placement: "overview",
    capability: "agent.accounts.v1",
    label: "Claude accounts",
  },
  { id: "boxes", placement: "overview", capability: "box.v1", label: "Boxes" },
];

/**
 * The slots this build can draw. A slot joins this set in the same change
 * that adds its view; the registry ships before the rest of its tenants.
 */
export const SHIPPED_HOST_OFFERS: ReadonlySet<HostOfferSlotId> = new Set<HostOfferSlotId>([
  "moves",
]);

export interface HostOffers {
  /** Extra tabs, in order, between Sessions and Access. */
  tabs: HostOfferSlot[];
  /** Extra Overview sections, in order. */
  panels: HostOfferSlot[];
}

export const NO_HOST_OFFERS: HostOffers = { tabs: [], panels: [] };

export function deriveHostOffers(
  capabilities: ReadonlySet<string> | readonly string[],
  shipped: ReadonlySet<HostOfferSlotId> = SHIPPED_HOST_OFFERS,
  slots: readonly HostOfferSlot[] = HOST_OFFER_SLOTS,
): HostOffers {
  const advertised = capabilities instanceof Set ? capabilities : new Set(capabilities);
  const lit = slots.filter((slot) => shipped.has(slot.id) && advertised.has(slot.capability));
  if (lit.length === 0) return NO_HOST_OFFERS;
  return {
    tabs: lit.filter((slot) => slot.placement === "tab"),
    panels: lit.filter((slot) => slot.placement === "overview"),
  };
}
