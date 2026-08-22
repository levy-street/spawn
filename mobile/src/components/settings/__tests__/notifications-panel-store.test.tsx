import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { AlertPresenter } from "@/components/alerts/alert-presenter";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import type { AlertEvent } from "@/data/realtime/alert-socket";
import { useAlertStore } from "@/data/stores/alerts";
import {
  clearNotificationPreferences,
  getNotificationPreferences,
  NOTIFICATION_PREFERENCES_STORAGE_KEY,
  normalizeNotificationPreferences,
  setNotificationPreference,
} from "@/lib/notifications";
import { ThemeProvider } from "@/theme";

const mockToastShow = jest.fn();
const mockToastError = jest.fn();

jest.mock("expo-router", () => ({
  usePathname: () => "/workspaces",
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ show: mockToastShow, error: mockToastError }),
}));

jest.mock("expo-notifications", () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  clearLastNotificationResponse: jest.fn(),
  getLastNotificationResponse: jest.fn(() => null),
  getPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  scheduleNotificationAsync: jest.fn(async () => "notification-id"),
  setNotificationHandler: jest.fn(),
}));

const ALERT: AlertEvent = {
  event: "agent.finished",
  session_id: "session-1",
  command: "codex",
  exit_code: null,
  signal: null,
  at: "2026-08-22T00:02:00Z",
};

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("shared notification preference store", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    useAlertStore.getState().clear();
    await clearNotificationPreferences();
    jest.clearAllMocks();
  });

  it("makes a panel toggle visible to the mounted presenter without a restart", async () => {
    const screen = await render(
      <>
        <NotificationsPanel />
        <AlertPresenter currentSessionId={null} />
      </>,
      { wrapper },
    );
    const finishedToggle = screen.getByRole("switch", { name: "An agent finishes" });
    expect(finishedToggle.props["accessibilityState"]).toEqual(
      expect.objectContaining({ checked: true }),
    );

    await act(async () => {
      fireEvent.press(finishedToggle);
      await Promise.resolve();
    });
    await waitFor(() => expect(getNotificationPreferences().onFinished).toBe(false));

    await act(() => {
      useAlertStore.getState().receive(ALERT, 1_000);
    });
    await waitFor(() => expect(useAlertStore.getState().alerts).toHaveLength(0));
    expect(mockToastShow).not.toHaveBeenCalled();
  });

  it("round-trips the existing key and preference schema", async () => {
    await setNotificationPreference("sound", true);
    const write = jest
      .mocked(AsyncStorage.setItem)
      .mock.calls.find(([key]) => key === NOTIFICATION_PREFERENCES_STORAGE_KEY);

    expect(write).toBeDefined();
    const encoded = write?.[1];
    expect(typeof encoded).toBe("string");
    expect(normalizeNotificationPreferences(JSON.parse(encoded ?? "null") as unknown)).toEqual(
      getNotificationPreferences(),
    );
  });
});
