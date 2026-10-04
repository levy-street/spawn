import type { ComponentType } from "react";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { HostOfferSlot, HostOfferSlotId, HostOffers } from "@/data/selectors/host-offers";

export interface HostOfferSlotProps {
  host: HostOut;
  slot: HostOfferSlot;
}

/**
 * What each lit slot draws on a host's page, registered by the milestone that
 * brings its feature: the Claude accounts panel, the conversations a host
 * holds, its boxes, and the entry to its desktop — which on a phone opens a
 * full-screen view of its own rather than a swipe tab, since a desktop is
 * dragged across and a swipe would fight it. A slot is registered here in the
 * same change that adds it to `SHIPPED_HOST_OFFERS`, so the registry never
 * lights a slot this build has no view for.
 *
 * Empty for now: no feature behind a slot has shipped, so even a host that
 * advertised one draws nothing here yet.
 */
export const SLOT_RENDERERS: Partial<Record<HostOfferSlotId, ComponentType<HostOfferSlotProps>>> =
  {};

function Slots({
  host,
  offers,
  placement,
}: {
  host: HostOut;
  offers: HostOffers;
  placement: HostOfferSlot["placement"];
}): React.JSX.Element {
  return (
    <>
      {offers.slots
        .filter((slot) => slot.placement === placement)
        .map((slot) => {
          const Slot = SLOT_RENDERERS[slot.id];
          return Slot ? <Slot host={host} key={slot.id} slot={slot} /> : null;
        })}
    </>
  );
}

/** Overview sections other areas register (`placement: "panel"`). */
export function HostOfferPanels(props: { host: HostOut; offers: HostOffers }): React.JSX.Element {
  return <Slots {...props} placement="panel" />;
}

/** Ways into a host's full-screen destinations (`placement: "screen"`). */
export function HostOfferEntries(props: { host: HostOut; offers: HostOffers }): React.JSX.Element {
  return <Slots {...props} placement="screen" />;
}
