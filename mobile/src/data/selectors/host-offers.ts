/**
 * What a host offers, as the cockpit lays it out: the one place a capability a
 * host advertises becomes something on its page. The browser derives the same
 * offers from the same names (web/src/lib/host-offers.ts).
 *
 * An area that brings a host feature registers it here — its capability
 * family and where it sits — instead of checking capabilities on its own. A
 * slot lights only when both halves are true: the host's own hello, over this
 * device's encrypted channel to it, names that family — never because of the
 * host's OS, never on the server's word, and never on a name that merely
 * shares a prefix — and this build can draw it (`SHIPPED_HOST_OFFERS`).
 *
 * None is lit by any host today; each is drawn by the milestone that brings
 * its feature.
 */
export type HostOfferSlotId = "desktop" | "conversations" | "claude-accounts" | "boxes";

export interface HostOfferSlot {
  id: HostOfferSlotId;
  /** The capability family whose advertisement lights the slot. */
  capability: string;
  label: string;
  /**
   * "screen": a destination of its own, opened full screen from the host's
   * page (on the phone, never a swipe tab). "panel": a section of Overview.
   */
  placement: "screen" | "panel";
}

export const HOST_OFFER_SLOTS: readonly HostOfferSlot[] = [
  // Remote desktop. `desktop.reveal` and `desktop.open` — showing a file on a
  // Mac's own screen — are older and unrelated, and never light it.
  { id: "desktop", capability: "screen.v1", label: "Desktop", placement: "screen" },
  // The conversations a host holds. `conv.v1` is the family as it first
  // shipped (conv.inspect alone, which Restart uses); the list is the version
  // that adds conv.transfers, so a host that only inspects shows nothing here.
  { id: "conversations", capability: "conv.v2", label: "Conversations", placement: "panel" },
  {
    id: "claude-accounts",
    capability: "agent.accounts.v1",
    label: "Claude accounts",
    placement: "panel",
  },
  { id: "boxes", capability: "box.v1", label: "Boxes", placement: "panel" },
];

/**
 * The slots this build can draw. Empty: the registry ships before any of its
 * tenants, and a slot joins this set in the same change that registers its
 * view in `components/hosts/cockpit/host-offer-slots.tsx` (a test holds the
 * two together).
 */
export const SHIPPED_HOST_OFFERS: ReadonlySet<HostOfferSlotId> = new Set();

export interface HostOffers {
  /** The slots this host lights, in registry order. */
  slots: readonly HostOfferSlot[];
  has(slot: HostOfferSlotId): boolean;
}

/**
 * The offers a set of advertised capabilities lights in a build that can draw
 * `shipped`. Null — a host this device has not heard a hello from — lights
 * nothing. Nothing else about the host (its OS included) is an input.
 */
export function deriveHostOffers(
  capabilities: readonly string[] | null | undefined,
  shipped: ReadonlySet<HostOfferSlotId> = SHIPPED_HOST_OFFERS,
): HostOffers {
  const advertised = new Set(capabilities ?? []);
  const slots = HOST_OFFER_SLOTS.filter(
    (slot) => shipped.has(slot.id) && advertised.has(slot.capability),
  );
  const lit = new Set(slots.map((slot) => slot.id));
  return { slots, has: (slot) => lit.has(slot) };
}
