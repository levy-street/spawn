import { SLOT_RENDERERS } from "@/components/hosts/cockpit/host-offer-slots";
import { SHIPPED_HOST_OFFERS } from "@/data/selectors/host-offers";

describe("host offer views", () => {
  test("a slot ships exactly when this build registers its view", () => {
    // The registry lights a slot only when it ships, and the page draws a
    // lit slot only through its renderer: the two lists are one decision.
    expect(new Set(Object.keys(SLOT_RENDERERS))).toEqual(new Set(SHIPPED_HOST_OFFERS));
  });
});
