import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren, ReactElement } from "react";
import { BackHandler } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { OverLimitReconciliation } from "@/components/hosts/over-limit-reconciliation";
import type { UserBilling } from "@/data/api/schemas/auth";
import type { HostOut } from "@/data/api/schemas/hosts";
import { ThemeProvider } from "@/theme";
import { createTestQueryClient } from "../../../../tests/render";

/** The modal reads safe-area insets, so it needs a provider with real metrics. */
async function renderModal(element: ReactElement) {
  const queryClient = createTestQueryClient();
  function Providers({ children }: PropsWithChildren): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
          }}
        >
          <ThemeProvider>{children}</ThemeProvider>
        </SafeAreaProvider>
      </QueryClientProvider>
    );
  }
  return await render(element, { wrapper: Providers });
}

/** `mock`-prefixed so the jest factories below may read them. */
const mockPlan: { current: UserBilling | null } = { current: null };
const mockHosts: { current: HostOut[] } = { current: [] };
const mockRemove = jest.fn(async (_hostId: string) => undefined);

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

jest.mock("@/data/queries/hosts", () => ({
  useHostsQuery: () => ({ data: mockHosts.current, isPending: false }),
  removeHostWithTrust: (host: { id: string }) => mockRemove(host.id),
}));

function host(id: string, name: string): HostOut {
  return {
    id,
    name,
    os: "darwin",
    arch: "aarch64",
    version: "0.1.0",
    daemon_tree: null,
    update: null,
    host_key_algorithm: "ed25519",
    host_public_key: null,
    status: "online",
    last_seen_at: "2026-08-31T00:00:00Z",
    session_count: 0,
    session_count_total: 0,
  } as unknown as HostOut;
}

const overLimit: UserBilling = {
  enabled: true,
  tier: "free",
  tier_name: "Free",
  host_limit: 1,
  host_count: 3,
  over_limit: true,
  status: null,
  current_period_end: null,
  cancel_at_period_end: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPlan.current = overLimit;
  mockHosts.current = [
    host("11111111-1111-4111-8111-111111111111", "dream"),
    host("22222222-2222-4222-8222-222222222222", "minivac"),
    host("33333333-3333-4333-8333-333333333333", "oracle"),
  ];
});

describe("the over-limit reconciliation", () => {
  test("renders nothing until the plan block says the choice is owed", async () => {
    mockPlan.current = { ...overLimit, over_limit: false };
    const screen = await renderModal(<OverLimitReconciliation />);
    expect(screen.queryByTestId("over-limit-reconciliation")).toBeNull();
  });

  test("renders nothing at all on a deployment without billing", async () => {
    mockPlan.current = null;
    const screen = await renderModal(<OverLimitReconciliation />);
    expect(screen.queryByTestId("over-limit-reconciliation")).toBeNull();
  });

  test("states what is held, what is included, and that nothing has stopped", async () => {
    const screen = await renderModal(<OverLimitReconciliation />);

    expect(screen.getByTestId("over-limit-reconciliation")).toBeOnTheScreen();
    expect(screen.getByText("Choose the hosts to keep")).toBeOnTheScreen();
    expect(screen.getByText(/holds 3 hosts and your plan includes 1 host/)).toBeOnTheScreen();
    expect(screen.getByText(/keeps running until you decide/)).toBeOnTheScreen();
  });

  // Host management, not commerce: it may say what the plan admits, and it may
  // not say what a plan costs or where one is bought. docs/BILLING.md §5.7.
  test("carries no price, no venue and no purchase verb", async () => {
    const screen = await renderModal(<OverLimitReconciliation />);

    expect(screen.queryByText(/[$£€]\s?\d/)).toBeNull();
    expect(screen.queryByText(/upgrade/i)).toBeNull();
    expect(screen.queryByText(/spawnd\.dev/)).toBeNull();
    expect(screen.queryByText(/subscri/i)).toBeNull();
  });

  test("cannot be dismissed: no close control, and Android's back is swallowed", async () => {
    const addEventListener = jest.spyOn(BackHandler, "addEventListener");
    const screen = await renderModal(<OverLimitReconciliation />);

    expect(screen.queryByLabelText("Close dialog")).toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
    expect(screen.queryByText("Later")).toBeNull();

    // The hardware back press is claimed, and claiming it means returning true.
    const registered = addEventListener.mock.calls.find(([event]) => event === "hardwareBackPress");
    expect(registered).toBeDefined();
    expect(registered?.[1]()).toBe(true);
    addEventListener.mockRestore();
  });

  test("keeping none is offered plainly, and still takes a deliberate press", async () => {
    const screen = await renderModal(<OverLimitReconciliation />);

    const release = screen.getByRole("button", { name: "Release 3 hosts" });
    // Nothing is chosen yet, so nothing can be released by a stray press.
    expect(release).toBeDisabled();

    await fireEvent.press(screen.getByRole("button", { name: "Keep none" }));
    expect(screen.getByTestId("over-limit-count")).toHaveTextContent("0 of 1 selected");
    expect(screen.getByRole("button", { name: "Release 3 hosts" })).toBeEnabled();

    await fireEvent.press(screen.getByRole("button", { name: "Release 3 hosts" }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(3));
  });

  test("selection is capped at the plan's limit, and releases only the rest", async () => {
    const screen = await renderModal(<OverLimitReconciliation />);

    await fireEvent.press(screen.getByLabelText("Keep dream"));
    expect(screen.getByTestId("over-limit-count")).toHaveTextContent("1 of 1 selected");

    // The limit is one, so the others are no longer selectable.
    expect(screen.getByLabelText("Keep minivac")).toBeDisabled();

    await fireEvent.press(screen.getByRole("button", { name: "Release 2 hosts" }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(2));
    expect(mockRemove).not.toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  test("a release that fails says so and leaves the choice standing", async () => {
    mockRemove.mockRejectedValueOnce(new Error("host is busy"));
    const screen = await renderModal(<OverLimitReconciliation />);

    await fireEvent.press(screen.getByRole("button", { name: "Keep none" }));
    await fireEvent.press(screen.getByRole("button", { name: "Release 3 hosts" }));

    await waitFor(() => expect(screen.getByText("host is busy")).toBeOnTheScreen());
    expect(screen.getByTestId("over-limit-reconciliation")).toBeOnTheScreen();
  });
});
