import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

import { AlertPresenter, pinUndeliveredToast } from "@/components/alerts/alert-presenter";
import type { HostOut } from "@/data/api/schemas/hosts";
import { qk } from "@/data/queryKeys";
import type { AlertEvent } from "@/data/realtime/alert-socket";
import { publishPinUndeliveredEvent } from "@/data/realtime/pin-undelivered-events";
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
    consumeLastApprovalNotificationResponse: jest.fn(() => null),
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
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    priorAppState = AppState.currentState;
    Object.defineProperty(AppState, "currentState", {
      configurable: true,
      value: "active",
      writable: true,
    });
    useAlertStore.getState().clear();
  });

  afterEach(async () => {
    await cleanup();
    queryClient.clear();
    Object.defineProperty(AppState, "currentState", {
      configurable: true,
      value: priorAppState,
      writable: true,
    });
    jest.restoreAllMocks();
  });

  it("routes one toast, deduplicates it, and suppresses the current session", async () => {
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

  it("maps an undelivered trust event to the exact host toast", () => {
    expect(
      pinUndeliveredToast(
        {
          event: "host.pin_undelivered",
          host_id: "host-1",
          browser_device_id: "device-1",
          reason: "invalid_chain",
        },
        "office-mac",
      ),
    ).toEqual({
      message: "The approval didn't reach office-mac.",
      detail:
        "office-mac could not verify the approval. Approve the device again from a device office-mac already trusts.",
    });
  });

  it("turns the alerts-socket undelivered event into a toast", async () => {
    queryClient.setQueryData<HostOut>(qk.host("host-1"), {
      id: "host-1",
      name: "office-mac",
    } as HostOut);
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <AlertPresenter currentSessionId={null} />
      </QueryClientProvider>,
    );

    await act(() => {
      publishPinUndeliveredEvent({
        event: "host.pin_undelivered",
        host_id: "host-1",
        browser_device_id: "device-1",
        reason: "other",
      });
    });

    expect(mockToastError).toHaveBeenCalledWith("The approval didn't reach office-mac.", {
      detail: "Try approving again; if it keeps failing, run spawnd doctor on office-mac.",
    });
    await view.unmount();
  });
});
