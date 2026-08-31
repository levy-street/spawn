import { SETTINGS_PANELS } from "@/components/settings/settings-inventory";
import { SubscriptionPanel } from "@/components/settings/subscription-panel";
import type { UserBilling } from "@/data/api/schemas/auth";
import { renderWithProviders } from "../../../../tests/render";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  router: { push: mockPush },
  useRouter: () => ({ back: jest.fn(), replace: jest.fn(), push: mockPush }),
}));

/** Read through a `mock`-prefixed holder: a jest factory may not close over
 *  anything else, and the plan block changes from test to test. */
const mockPlan: { current: UserBilling | null } = { current: null };

jest.mock("@/data/queries/settings", () => ({
  useMeSettingsQuery: () => ({
    data: {
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "owner@example.com",
        created_at: "2026-01-01T00:00:00Z",
        email_verified_at: "2026-01-01T00:00:00Z",
        is_admin: false,
        billing: mockPlan.current,
      },
    },
    isPending: false,
  }),
}));

const coven: UserBilling = {
  enabled: true,
  tier: "coven",
  tier_name: "Coven",
  host_limit: 3,
  host_count: 3,
  over_limit: false,
  status: "active",
  current_period_end: "2026-09-24T00:00:00Z",
  cancel_at_period_end: false,
};

afterEach(() => {
  mockPlan.current = null;
});

describe("Settings → Subscription", () => {
  test("states the plan, its capacity and when it renews", async () => {
    mockPlan.current = coven;
    const screen = await renderWithProviders(<SubscriptionPanel />);

    expect(screen.getByText("Plan")).toBeOnTheScreen();
    expect(screen.getByText("Coven · 3 of 3 hosts in use")).toBeOnTheScreen();
    expect(screen.getByText(/^Renews /)).toBeOnTheScreen();
  });

  // The compliance bright line, asserted where the panel is drawn rather than
  // only over the source: no price, no purchase control, no venue named, and no
  // verb aimed at the reader. docs/BILLING.md §6.4.
  test("shows no price and offers no purchase", async () => {
    mockPlan.current = coven;
    const screen = await renderWithProviders(<SubscriptionPanel />);

    expect(screen.queryByText(/[$£€]\s?\d/)).toBeNull();
    expect(screen.queryByText(/upgrade/i)).toBeNull();
    expect(screen.queryByText(/spawnd\.dev/)).toBeNull();
    // The header's back chevron is the only control on the panel: nothing here
    // is pressable, because there is nothing here to buy.
    expect(screen.getAllByRole("button").map((node) => node.props["accessibilityLabel"])).toEqual([
      "Go back",
    ]);
  });

  // Passive, no venue, no verb: an explanation for the absence of a button,
  // not an inducement to press one. "Manage your plan on the web" is the
  // phrasing that fails Apple's stated test — do not restore it.
  test("explains the absence of a control without instructing anyone", async () => {
    mockPlan.current = coven;
    const screen = await renderWithProviders(<SubscriptionPanel />);

    expect(screen.getByText("Billing is managed on the web.")).toBeOnTheScreen();
    expect(screen.queryByText(/Manage your plan/i)).toBeNull();
    expect(screen.queryByText(/Go to /i)).toBeNull();
  });

  test("says a subscription set to stop ends, rather than renews", async () => {
    mockPlan.current = { ...coven, cancel_at_period_end: true };
    const screen = await renderWithProviders(<SubscriptionPanel />);

    expect(screen.getByText(/^Ends /)).toBeOnTheScreen();
    expect(screen.queryByText(/^Renews /)).toBeNull();
  });

  test("an unlimited plan states usage without a denominator", async () => {
    mockPlan.current = {
      ...coven,
      tier: "pandemonium",
      tier_name: "Pandemonium",
      host_limit: null,
    };
    const screen = await renderWithProviders(<SubscriptionPanel />);

    expect(screen.getByText("Pandemonium · 3 hosts in use")).toBeOnTheScreen();
  });

  // Reached only by a deep link on a deployment with billing off — the row that
  // leads here is not drawn at all in that state.
  test("a deployment without billing has no plan to describe", async () => {
    mockPlan.current = null;
    const screen = await renderWithProviders(<SubscriptionPanel />);

    expect(screen.getByText("This server has no subscriptions.")).toBeOnTheScreen();
    expect(screen.queryByText(/hosts in use/)).toBeNull();
  });

  test("the registry entry names the controls this panel actually carries", () => {
    const panel = SETTINGS_PANELS.find((entry) => entry.key === "subscription");
    expect(panel?.route).toBe("/settings/subscription");
    expect(panel?.controls).toEqual(["Plan"]);
  });
});
