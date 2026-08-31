import { render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { InstallInstructions } from "@/components/onboarding/install-instructions";
import { TrustFailureState } from "@/components/onboarding/trust-failure-state";
import { ApiError } from "@/data/api/client";
import type { UserBilling } from "@/data/api/schemas/auth";
import { toPairingFailure } from "@/data/queries/pairing";
import { ThemeProvider } from "@/theme";

jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => undefined) }));
jest.mock("@/lib/share", () => ({ presentShareSheet: jest.fn(async () => undefined) }));

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

const full: UserBilling = {
  enabled: true,
  tier: "coven",
  tier_name: "Coven",
  host_limit: 3,
  host_count: 3,
  over_limit: false,
  status: "active",
  current_period_end: null,
  cancel_at_period_end: false,
};

/**
 * The host-limit moment, in the two places it lands.
 *
 * The copy is account state plus an action available inside the app. No price,
 * no venue, no verb pointed off-platform — so it ships worldwide on both
 * platforms and survives whatever happens to guideline 3.1.1(a).
 * docs/BILLING.md §6.3.
 */
describe("the host-limit copy", () => {
  test("pre-empts a wasted install when the plan is already full", async () => {
    const screen = await render(<InstallInstructions billing={full} />, { wrapper });

    expect(screen.getByText("Host limit reached")).toBeOnTheScreen();
    expect(
      screen.getByText("Your plan includes 3 hosts. Disconnect one to connect another."),
    ).toBeOnTheScreen();
    await screen.unmount();
  });

  test("says nothing while there is room", async () => {
    const screen = await render(<InstallInstructions billing={{ ...full, host_count: 1 }} />, {
      wrapper,
    });
    expect(screen.queryByTestId("host-limit-notice")).toBeNull();
    await screen.unmount();
  });

  test("says nothing on an unlimited plan, or with billing off", async () => {
    const unlimited = await render(
      <InstallInstructions billing={{ ...full, host_limit: null }} />,
      {
        wrapper,
      },
    );
    expect(unlimited.queryByTestId("host-limit-notice")).toBeNull();
    await unlimited.unmount();

    const off = await render(<InstallInstructions billing={null} />, { wrapper });
    expect(off.queryByTestId("host-limit-notice")).toBeNull();
    await off.unmount();
  });

  test("names no price and points nowhere off-platform", async () => {
    const screen = await render(<InstallInstructions billing={full} />, { wrapper });

    expect(screen.queryByText(/[$£€]\s?\d/)).toBeNull();
    expect(screen.queryByText(/upgrade/i)).toBeNull();
    expect(screen.queryByText(/\/pricing/)).toBeNull();
    await screen.unmount();
  });

  test("states the same limit after a refusal, built from the server's figure", async () => {
    const screen = await render(
      <TrustFailureState
        failure={{ kind: "host-limit", hostLimit: 3 }}
        onAction={() => undefined}
      />,
      { wrapper },
    );

    expect(screen.getByText("Host limit reached")).toBeOnTheScreen();
    expect(
      screen.getByText("Your plan includes 3 hosts. Disconnect one to connect another."),
    ).toBeOnTheScreen();
    await screen.unmount();
  });

  test("a refusal with no figure still reads as a sentence", async () => {
    const screen = await render(
      <TrustFailureState failure={{ kind: "host-limit" }} onAction={() => undefined} />,
      { wrapper },
    );

    expect(
      screen.getByText("Your plan's host limit is in use. Disconnect one to connect another."),
    ).toBeOnTheScreen();
    await screen.unmount();
  });
});

describe("the 402 is read as figures, never as prose", () => {
  test("the plan refusal carries the limit and no server words", () => {
    const failure = toPairingFailure(
      new ApiError(402, "http_402", "Payment Required", {
        code: "host_limit",
        tier: "coven",
        host_limit: 3,
        host_count: 3,
      }),
    );

    expect(failure).toEqual({ kind: "host-limit", hostLimit: 3 });
    expect(failure.detail).toBeUndefined();
  });

  // The failure screen renders `detail` verbatim, so a server that ever grew a
  // sentence on this path would put copy the app never wrote into a binary that
  // ships through app review. The billing branch must never reach that code.
  test("a server sentence on a billing path is discarded, not rendered", async () => {
    const failure = toPairingFailure(
      new ApiError(402, "host_limit", "Upgrade at spawnd.dev for $5/mo", {
        code: "host_limit",
        host_limit: 3,
      }),
    );
    expect(failure.detail).toBeUndefined();

    const screen = await render(
      <TrustFailureState failure={failure} onAction={() => undefined} />,
      {
        wrapper,
      },
    );
    expect(screen.queryByText(/spawnd\.dev/)).toBeNull();
    expect(screen.queryByText(/Upgrade/)).toBeNull();
    await screen.unmount();
  });

  test("a 402 that is not the plan refusal is left to the ordinary path", () => {
    const failure = toPairingFailure(new ApiError(402, "http_402", "Payment Required", null));
    expect(failure.kind).toBe("pairing-rejected");
  });
});
