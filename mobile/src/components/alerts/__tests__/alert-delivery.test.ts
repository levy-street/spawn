import {
  currentTerminalSession,
  planAlertDelivery,
  selectPendingStoredAlerts,
} from "@/components/alerts/alert-delivery";
import type { AlertEvent } from "@/data/realtime/alert-socket";
import type { StoredAlert } from "@/data/stores/alerts";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "@/lib/notifications";

jest.mock("expo-notifications", () => ({}));

const ALERT: AlertEvent = {
  event: "agent.awaiting_input",
  session_id: "session-1",
  command: "codex",
  exit_code: null,
  signal: null,
  at: "2026-08-22T00:02:00Z",
};

function prefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    mutedSessions: [],
    ...overrides,
  };
}

describe("alert delivery planning", () => {
  it("maps an active alert to one toast and the preferred semantic haptic", () => {
    expect(
      planAlertDelivery({
        alert: ALERT,
        prefs: prefs({ haptics: true }),
        appState: "active",
        currentSessionId: "another-session",
        claimed: true,
      }),
    ).toEqual({
      suppressedBy: null,
      toast: true,
      haptic: "warning",
      localNotification: false,
    });
  });

  it("suppresses every channel for the session currently on screen", () => {
    expect(
      planAlertDelivery({
        alert: ALERT,
        prefs: prefs({ haptics: true, system: true }),
        appState: "active",
        currentSessionId: ALERT.session_id,
        claimed: true,
      }),
    ).toEqual({
      suppressedBy: "current_session",
      toast: false,
      haptic: null,
      localNotification: false,
    });
  });

  it("respects event and mute preferences before claiming delivery", () => {
    expect(
      planAlertDelivery({
        alert: ALERT,
        prefs: prefs({ onAwaiting: false }),
        appState: "active",
        currentSessionId: null,
        claimed: true,
      }).suppressedBy,
    ).toBe("event_disabled");
    expect(
      planAlertDelivery({
        alert: ALERT,
        prefs: prefs({ mutedSessions: [ALERT.session_id] }),
        appState: "active",
        currentSessionId: null,
        claimed: true,
      }).suppressedBy,
    ).toBe("session_muted");
  });

  it("uses local notification delivery only while the app is not active", () => {
    const background = planAlertDelivery({
      alert: ALERT,
      prefs: prefs({ system: true }),
      appState: "background",
      currentSessionId: null,
      claimed: true,
    });
    expect(background.toast).toBe(false);
    expect(background.localNotification).toBe(true);

    const foreground = planAlertDelivery({
      alert: ALERT,
      prefs: prefs({ system: true }),
      appState: "active",
      currentSessionId: null,
      claimed: true,
    });
    expect(foreground.toast).toBe(true);
    expect(foreground.localNotification).toBe(false);
  });

  it("deduplicates pending keys and preserves received order", () => {
    const first: StoredAlert = { key: "first", alert: ALERT, receivedAt: 1 };
    const second: StoredAlert = {
      key: "second",
      alert: { ...ALERT, at: "2026-08-22T00:03:00Z" },
      receivedAt: 2,
    };
    expect(selectPendingStoredAlerts([second, first, second], new Set(["first"]))).toEqual([
      second,
    ]);
  });

  it("reads only a terminal route as the currently viewed session", () => {
    expect(currentTerminalSession("/terminal/session%201")).toBe("session 1");
    expect(currentTerminalSession("/workspace/workspace-1")).toBeNull();
    expect(currentTerminalSession("/terminal/%E0%A4%A")).toBeNull();
  });
});
