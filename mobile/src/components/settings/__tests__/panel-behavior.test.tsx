import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountPanel } from "@/components/settings/account-panel";
import { DeviceTrustPanel } from "@/components/settings/device-trust-panel";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import { SETTINGS_PANELS } from "@/components/settings/settings-inventory";
import { SettingsRoot } from "@/components/settings/settings-root";
import { authToken } from "@/data/api/auth-token";
import { ThemeProvider } from "@/theme";

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockToastShow = jest.fn();
const mockToastError = jest.fn();
const mockToastSuccess = jest.fn();
const mockSignOutEverywhere = jest.fn(async () => ({ access_token: "caller-session" }));

jest.mock("expo-router", () => ({
  router: { push: mockPush },
  useRouter: () => ({ back: mockBack, replace: mockReplace, push: mockPush }),
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ show: mockToastShow, error: mockToastError, success: mockToastSuccess }),
}));

jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: jest.fn(async () => "notification-id"),
}));

jest.mock("@/data/api/auth-token", () => ({
  authToken: {
    get: jest.fn(async () => "token"),
    set: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
    captureFromResponse: jest.fn(async () => null),
  },
}));

jest.mock("@/data/api/client", () => ({
  api: jest.fn(async () => undefined),
  ApiError: class ApiError extends Error {
    status: number;

    constructor(status: number, _code: string, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

jest.mock("@/data/queries/auth", () => ({
  useSignOutEverywhereMutation: () => ({
    isPending: false,
    mutateAsync: mockSignOutEverywhere,
    reset: jest.fn(),
  }),
}));

const mockUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@example.com",
  created_at: "2026-01-01T00:00:00Z",
  email_verified_at: "2026-01-01T00:00:00Z",
  is_admin: false,
  // Null is what a deployment without billing sends, and what most of this file
  // exercises: no plan block, so no Subscription row.
  billing: null as {
    enabled: boolean;
    tier: string;
    tier_name: string;
    host_limit: number | null;
    host_count: number;
    over_limit: boolean;
    status: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null,
};

jest.mock("@/data/queries/settings", () => ({
  useMeSettingsQuery: () => ({ data: { user: mockUser }, isPending: false }),
  useDeleteAccountMutation: () => ({
    isPending: false,
    error: null,
    mutateAsync: jest.fn(),
    reset: jest.fn(),
  }),
  useBrowserDevicesSettingsQuery: () => ({ data: [], isPending: false }),
  useTrustBundleSettingsQuery: () => ({ data: null, isPending: false }),
  usePasskeysSettingsQuery: () => ({ data: [], isPending: false }),
  useEndorsementsSettingsQuery: () => ({ data: [], isPending: false }),
}));

jest.mock("@/data/api/config", () => ({
  getBaseUrl: jest.fn(async () => "https://spawn.example"),
}));

jest.mock("@/data/trust/host-pins", () => ({
  formatHostFingerprint: jest.fn(() => "SHA256:phone"),
  openHostPinStore: jest.fn(async () => ({
    list: jest.fn(async () => []),
    clearAccount: jest.fn(async () => undefined),
  })),
}));

jest.mock("@/data/trust/endorsement", () => ({
  passkeyPrfCapability: {
    available: false,
    reason:
      "Saved trust passkeys require an installed build. Approve this device from another trusted device, or pair a host directly.",
  },
  probePasskeyPrfCapability: jest.fn(async () => ({
    available: false,
    reason:
      "Saved trust passkeys require an installed build. Approve this device from another trusted device, or pair a host directly.",
  })),
}));

jest.mock("@/lib/crypto/identity", () => ({
  setDeviceIdentityAccount: jest.fn(),
  deviceIdentity: {
    publicKey: jest.fn(async () => null),
    reset: jest.fn(async () => undefined),
  },
}));

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe("settings panel behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  });

  test("settings root renders the documented panels plus connectivity", async () => {
    const screen = await render(<SettingsRoot />, { wrapper });

    expect(SETTINGS_PANELS).toHaveLength(9);
    // Machines belong to the Legion tab, so Settings never lists a Hosts panel.
    expect(screen.queryByTestId("settings-panel-hosts")).toBeNull();
    for (const panel of SETTINGS_PANELS) {
      // Billing is off in this fixture, so Subscription is deliberately absent
      // — see the test below.
      if (panel.key === "subscription") continue;
      expect(screen.getByTestId(`settings-panel-${panel.key}`)).toBeOnTheScreen();
    }
    // Server and About are not inventory panels but the root still owns them.
    expect(screen.getByTestId("settings-panel-server")).toBeOnTheScreen();
    expect(screen.getByTestId("settings-panel-about")).toBeOnTheScreen();
    expect(screen.getAllByTestId(/^settings-panel-/)).toHaveLength(SETTINGS_PANELS.length + 1);
    // Hosts and Settings are bottom-nav roots and are not linked from any header;
    // Admin is a row in the list rather than a header icon, and a non-admin
    // account does not get the row at all.
    expect(screen.queryByRole("button", { name: "Open hosts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open admin" })).toBeNull();
    expect(screen.queryByTestId("settings-panel-admin")).toBeNull();
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(screen.queryByText("Security")).toBeNull();
  });

  // Billing off means no billing surface at all, exactly as `is_admin` decides
  // the Admin row. A self-hosted deployment sends no plan block and gets no
  // Subscription row; a hosted one does. docs/BILLING.md §6.4.
  test("the Subscription row appears only where the server has billing", async () => {
    const off = await render(<SettingsRoot />, { wrapper });
    expect(off.queryByTestId("settings-panel-subscription")).toBeNull();
    await off.unmount();

    mockUser.billing = {
      enabled: true,
      tier: "coven",
      tier_name: "Coven",
      host_limit: 3,
      host_count: 2,
      over_limit: false,
      status: "active",
      current_period_end: "2026-09-24T00:00:00Z",
      cancel_at_period_end: false,
    };
    try {
      const on = await render(<SettingsRoot />, { wrapper });
      const row = on.getByTestId("settings-panel-subscription");
      expect(row).toBeOnTheScreen();
      await fireEvent.press(row);
      expect(mockPush).toHaveBeenCalledWith("/settings/subscription");
    } finally {
      mockUser.billing = null;
    }
  });

  test("an admin reaches admin from a list row, never from the header", async () => {
    mockUser.is_admin = true;
    try {
      const screen = await render(<SettingsRoot />, { wrapper });

      const row = screen.getByTestId("settings-panel-admin");
      expect(row).toBeOnTheScreen();
      expect(screen.queryByRole("button", { name: "Open admin" })).toBeNull();

      await fireEvent.press(row);
      expect(mockPush).toHaveBeenCalledWith("/admin");
    } finally {
      mockUser.is_admin = false;
    }
  });

  test("system notifications are a live toggle, with a way back in after a refusal", async () => {
    const screen = await render(<NotificationsPanel />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("push-toggle")).toBeOnTheScreen());
    expect(screen.getByRole("switch", { name: "System notification" })).toBeOnTheScreen();
    expect(screen.queryByText("Unavailable")).toBeNull();
    // Permission has never been asked for here, so there is nothing to reverse
    // in the system Settings yet and no row that sends you there.
    expect(screen.queryByTestId("push-open-settings")).toBeNull();
  });

  test("passkey capability probe renders the honest Expo Go state", async () => {
    const screen = await render(<DeviceTrustPanel />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("passkey-unavailable")).toBeOnTheScreen());
    expect(screen.getByText("Set up a passkey")).toBeOnTheScreen();
    expect(
      screen.getAllByText(
        "Saved trust passkeys require an installed build. Approve this device from another trusted device, or pair a host directly.",
      ).length,
    ).toBeGreaterThan(0);
  });

  test("sign out clears the bearer token and returns to the auth gate", async () => {
    const screen = await render(<AccountPanel />, { wrapper });
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => {
      expect(authToken.clear).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
  });

  test("sign out everywhere confirms, preserves this session, and reports success", async () => {
    const screen = await render(<AccountPanel />, { wrapper });
    await fireEvent.press(screen.getByRole("button", { name: "Sign out everywhere" }));

    expect(screen.getByText("Sign out everywhere?")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Every other browser and phone signed in to this account will be signed out. This one stays signed in.",
      ),
    ).toBeOnTheScreen();
    const confirms = screen.getAllByRole("button", { name: "Sign out everywhere" });
    const confirm = confirms.at(-1);
    if (!confirm) throw new Error("Sign-out-everywhere confirmation is missing");
    await fireEvent.press(confirm);

    await waitFor(() => expect(mockSignOutEverywhere).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).toHaveBeenCalledWith("Signed out everywhere else.");
    expect(mockReplace).not.toHaveBeenCalledWith("/login");
  });

  test("sign out everywhere becomes unavailable after an old-server 404", async () => {
    const { ApiError } = jest.requireMock("@/data/api/client") as {
      ApiError: new (status: number, code: string, message: string) => Error;
    };
    mockSignOutEverywhere.mockRejectedValueOnce(new ApiError(404, "http_404", "not found"));
    const screen = await render(<AccountPanel />, { wrapper });
    await fireEvent.press(screen.getByRole("button", { name: "Sign out everywhere" }));
    const confirms = screen.getAllByRole("button", { name: "Sign out everywhere" });
    const confirm = confirms.at(-1);
    if (!confirm) throw new Error("Sign-out-everywhere confirmation is missing");
    await fireEvent.press(confirm);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Not available on this server yet." }),
      ).toBeDisabled(),
    );
  });

  test("account confirmation input stays unmounted until deletion is expanded", async () => {
    const screen = await render(<AccountPanel />, { wrapper });

    expect(screen.queryByPlaceholderText(mockUser.email)).toBeNull();
    expect(screen.getAllByText("Account")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Go back" })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Delete account…" }));
    expect(screen.getByPlaceholderText(mockUser.email)).toHaveProp("autoFocus", true);
  });
});
