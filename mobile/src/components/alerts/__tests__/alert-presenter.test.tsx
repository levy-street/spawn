import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

import { AlertPresenter } from "@/components/alerts/alert-presenter";
import type { AlertEvent } from "@/data/realtime/alert-socket";
import { useAlertStore } from "@/data/stores/alerts";

const mockPush = jest.fn();
const mockToastShow = jest.fn();
const mockToastError = jest.fn();
const mockSchedule = jest.fn(async () => ({ scheduled: true, identifier: "local-1" }));

jest.mock("expo-router", () => ({
  usePathname: () => "/workspaces",
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({
    error: mockToastError,
    show: mockToastShow,
  }),
}));

jest.mock("@/lib/haptics", () => ({
  haptics: {
    error: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
  },
}));

jest.mock("@/lib/notifications", () => {
  const prefs = {
    toast: true,
    sound: false,
    system: false,
    haptics: false,
    onFinished: true,
    onAwaiting: true,
    onDied: true,
    mutedSessions: [],
  };
  return {
    configureLocalNotifications: jest.fn(),
    consumeLastLocalNotificationResponse: jest.fn(() => null),
    getNotificationPreferences: jest.fn(() => prefs),
    hydrateNotificationPreferences: jest.fn(async () => prefs),
    notificationEventEnabled: jest.fn(
      (value: typeof prefs, event: string) =>
        (event === "agent.finished" && value.onFinished) ||
        (event === "agent.awaiting_input" && value.onAwaiting) ||
        (event === "session.died" && value.onDied),
    ),
    scheduleLocalAlertNotification: mockSchedule,
    subscribeToLocalNotificationResponses: jest.fn(() => jest.fn()),
  };
});

const ALERT: AlertEvent = {
  event: "agent.finished",
  session_id: "session-1",
  command: "codex",
  exit_code: null,
  signal: null,
  at: "2026-08-22T00:02:00Z",
};

describe("AlertPresenter", () => {
  let priorAppState: AppStateStatus;

  beforeEach(() => {
    jest.clearAllMocks();
    priorAppState = AppState.currentState;
    Object.defineProperty(AppState, "currentState", {
      configurable: true,
      value: "active",
      writable: true,
    });
    useAlertStore.getState().clear();
  });

  afterEach(() => {
    Object.defineProperty(AppState, "currentState", {
      configurable: true,
      value: priorAppState,
      writable: true,
    });
    jest.restoreAllMocks();
  });

  it("routes one toast, deduplicates it, and suppresses the current session", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onOpenSession = jest.fn();
    useAlertStore.getState().receive(ALERT, 1_000);

    const view = await render(
      <QueryClientProvider client={queryClient}>
        <AlertPresenter currentSessionId={null} onOpenSession={onOpenSession} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mockToastShow).toHaveBeenCalledTimes(1));
    expect(mockToastShow).toHaveBeenCalledWith(
      "Codex finished",
      expect.objectContaining({
        actionLabel: "Go to Codex finished",
        detail: "Session session-",
      }),
    );
    await waitFor(() => expect(useAlertStore.getState().alerts).toHaveLength(0));
    const options = mockToastShow.mock.calls[0]?.[1] as { onPress?: () => void } | undefined;
    options?.onPress?.();
    expect(onOpenSession).toHaveBeenCalledWith(ALERT.session_id);

    expect(useAlertStore.getState().receive(ALERT, 1_001)).toBe(false);
    expect(mockToastShow).toHaveBeenCalledTimes(1);

    await view.rerender(
      <QueryClientProvider client={queryClient}>
        <AlertPresenter currentSessionId={ALERT.session_id} onOpenSession={onOpenSession} />
      </QueryClientProvider>,
    );
    await act(() => {
      useAlertStore.getState().receive({ ...ALERT, at: "2026-08-22T00:03:00Z" }, 2_000);
    });

    await waitFor(() => expect(useAlertStore.getState().alerts).toHaveLength(0));
    expect(mockToastShow).toHaveBeenCalledTimes(1);
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});
