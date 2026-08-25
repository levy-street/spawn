import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { Linking } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  NotificationsPanel,
  systemNotificationHint,
} from "@/components/settings/notifications-panel";
import { clearNotificationPreferences } from "@/lib/notifications";
import { requestPushRegistration, unregisterForPushNotifications } from "@/lib/push";
import { ThemeProvider } from "@/theme";

const mockGetPermissions = jest.fn(async () => ({ status: "undetermined" }));
const mockRequestPermissions = jest.fn(async () => ({ status: "granted" }));

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("expo-notifications", () => ({
  getPermissionsAsync: () => mockGetPermissions(),
  requestPermissionsAsync: () => mockRequestPermissions(),
  scheduleNotificationAsync: jest.fn(async () => "notification-id"),
}));

jest.mock("@/lib/push", () => ({
  requestPushRegistration: jest.fn(),
  unregisterForPushNotifications: jest.fn(async () => undefined),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrapper({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

describe("system notifications on the notifications panel", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await clearNotificationPreferences();
    mockGetPermissions.mockResolvedValue({ status: "undetermined" });
    mockRequestPermissions.mockResolvedValue({ status: "granted" });
  });

  it("says what the row does, and where to go after a refusal", () => {
    expect(systemNotificationHint("granted", true)).toMatch(/even while SPAWN D is closed/);
    expect(systemNotificationHint("undetermined", true)).toMatch(/Asks for permission/);
    expect(systemNotificationHint("denied", true)).toMatch(/system Settings/);
  });

  it("asks the system when turned on and registers the phone once allowed", async () => {
    const screen = await render(<NotificationsPanel />, { wrapper });
    const toggle = await screen.findByRole("switch", { name: "System notification" });
    // Wanted by default, but not yet allowed: the row reads as off until the
    // system has said yes.
    await waitFor(() => expect(mockGetPermissions).toHaveBeenCalled());
    expect(toggle.props["accessibilityState"]).toMatchObject({ checked: false });

    await fireEvent.press(toggle);

    await waitFor(() => expect(mockRequestPermissions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestPushRegistration).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "System notification" }).props["accessibilityState"],
      ).toMatchObject({ checked: true }),
    );
    expect(screen.queryByTestId("push-open-settings")).toBeNull();
  });

  it("offers the system Settings after a refusal, since it cannot ask twice", async () => {
    mockGetPermissions.mockResolvedValue({ status: "denied" });
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    const screen = await render(<NotificationsPanel />, { wrapper });

    const row = await screen.findByTestId("push-open-settings");
    expect(
      screen.getByRole("switch", { name: "System notification" }).props["accessibilityState"],
    ).toMatchObject({ checked: false });
    expect(screen.getByText("Open system Settings")).toBeOnTheScreen();

    await fireEvent.press(row);
    expect(openSettings).toHaveBeenCalledTimes(1);
    openSettings.mockRestore();
  });

  it("drops the phone's registration when turned off", async () => {
    mockGetPermissions.mockResolvedValue({ status: "granted" });
    const screen = await render(<NotificationsPanel />, { wrapper });
    const toggle = await screen.findByRole("switch", { name: "System notification" });
    await waitFor(() =>
      expect(toggle.props["accessibilityState"]).toMatchObject({ checked: true }),
    );

    await fireEvent.press(screen.getByRole("switch", { name: "System notification" }));

    await waitFor(() => expect(unregisterForPushNotifications).toHaveBeenCalledTimes(1));
    expect(requestPushRegistration).not.toHaveBeenCalled();
  });
});
