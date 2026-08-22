import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountPanel } from "@/components/settings/account-panel";
import { DeviceTrustPanel } from "@/components/settings/device-trust-panel";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import { SettingsRoot } from "@/components/settings/settings-root";
import { authToken } from "@/data/api/auth-token";
import { ThemeProvider } from "@/theme";

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockToastShow = jest.fn();
const mockToastError = jest.fn();

jest.mock("expo-router", () => ({
  router: { push: mockPush },
  useRouter: () => ({ back: mockBack, replace: mockReplace, push: mockPush }),
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ show: mockToastShow, error: mockToastError }),
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
  ApiError: class ApiError extends Error {},
}));

const mockUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@example.com",
  created_at: "2026-01-01T00:00:00Z",
  email_verified_at: "2026-01-01T00:00:00Z",
  is_admin: false,
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

  test("settings root renders exactly the nine documented panel entries", async () => {
    const screen = await render(<SettingsRoot />, { wrapper });
    expect(screen.getAllByTestId(/^settings-panel-/)).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Open hosts" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Open admin" })).toBeOnTheScreen();
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(screen.queryByText("Security")).toBeNull();
  });

  test("push-dependent notification preference is explicitly unavailable", async () => {
    const screen = await render(<NotificationsPanel />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("push-unavailable")).toBeOnTheScreen());
    expect(screen.getByText("System notification")).toBeOnTheScreen();
    expect(screen.queryByRole("switch", { name: "System notification" })).toBeNull();
    expect(screen.getByText("Unavailable")).toBeOnTheScreen();
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

  test("account confirmation input stays unmounted until deletion is expanded", async () => {
    const screen = await render(<AccountPanel />, { wrapper });

    expect(screen.queryByPlaceholderText(mockUser.email)).toBeNull();
    expect(screen.getAllByText("Account")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Go back" })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Delete account…" }));
    expect(screen.getByPlaceholderText(mockUser.email)).toHaveProp("autoFocus", true);
  });
});
