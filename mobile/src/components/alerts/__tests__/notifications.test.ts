import * as ExpoNotifications from "expo-notifications";

import type { AlertEvent } from "@/data/realtime/alert-socket";
import {
  clearNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
  getNotificationPreferences,
  hydrateNotificationPreferences,
  LOCAL_NOTIFICATION_RATE_LIMIT_MS,
  normalizeNotificationPreferences,
  notificationCapabilities,
  parseNotificationNavigationTarget,
  parseNotificationPairingTarget,
  scheduleLocalAlertNotification,
  setNotificationPreference,
  setSessionNotificationsMuted,
  setSystemNotificationsEnabled,
} from "@/lib/notifications";

jest.mock("expo-notifications", () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  clearLastNotificationResponse: jest.fn(),
  getLastNotificationResponse: jest.fn(() => null),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));

const ALERT: AlertEvent = {
  event: "agent.finished",
  session_id: "session-1",
  command: "codex --quiet",
  exit_code: null,
  signal: null,
  at: "2026-08-22T00:02:00Z",
};

function permission(
  status: "granted" | "denied" | "undetermined",
): Awaited<ReturnType<typeof ExpoNotifications.getPermissionsAsync>> {
  return {
    status: status as Awaited<ReturnType<typeof ExpoNotifications.getPermissionsAsync>>["status"],
    granted: status === "granted",
    canAskAgain: status !== "denied",
    expires: "never",
  };
}

describe("notification preferences and capability", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(ExpoNotifications.getPermissionsAsync).mockResolvedValue(permission("granted"));
    jest.mocked(ExpoNotifications.requestPermissionsAsync).mockResolvedValue(permission("granted"));
    jest.mocked(ExpoNotifications.scheduleNotificationAsync).mockResolvedValue("notification-1");
    await clearNotificationPreferences();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("normalizes invalid values and bounds muted sessions to the newest 200", () => {
    const mutedSessions = Array.from({ length: 201 }, (_, index) => `session-${index}`);
    expect(
      normalizeNotificationPreferences({ toast: false, sound: "yes", mutedSessions }).toast,
    ).toBe(false);
    const normalized = normalizeNotificationPreferences({ mutedSessions });
    expect(normalized.sound).toBe(DEFAULT_NOTIFICATION_PREFERENCES.sound);
    expect(normalized.mutedSessions).toHaveLength(200);
    expect(normalized.mutedSessions[0]).toBe("session-1");
  });

  it("requests permission only after explicit system-notification enablement", async () => {
    await hydrateNotificationPreferences();
    expect(ExpoNotifications.requestPermissionsAsync).not.toHaveBeenCalled();

    await setSystemNotificationsEnabled(true);
    expect(ExpoNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(getNotificationPreferences().system).toBe(true);

    jest
      .mocked(ExpoNotifications.getPermissionsAsync)
      .mockResolvedValue(permission("undetermined"));
    await setNotificationPreference("system", false);
    await setSystemNotificationsEnabled(true);
    expect(ExpoNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps system delivery off when permission is denied", async () => {
    jest.mocked(ExpoNotifications.getPermissionsAsync).mockResolvedValue(permission("denied"));
    jest.mocked(ExpoNotifications.requestPermissionsAsync).mockResolvedValue(permission("denied"));
    expect(await setSystemNotificationsEnabled(true)).toBe("denied");
    expect(getNotificationPreferences().system).toBe(false);
  });

  it("reports remote push and suspended delivery as available now that push ships", () => {
    expect(notificationCapabilities.local.available).toBe(true);
    expect(notificationCapabilities.remote.available).toBe(true);
    expect(notificationCapabilities.remote.detail).toContain("while SPAWN D is closed");
    // The alert socket cannot reach a suspended app; push is what covers it.
    expect(notificationCapabilities.suspendedDelivery.available).toBe(true);
  });
});

describe("local alert scheduling", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    jest.mocked(ExpoNotifications.getPermissionsAsync).mockResolvedValue(permission("granted"));
    jest.mocked(ExpoNotifications.scheduleNotificationAsync).mockResolvedValue("notification-1");
    await clearNotificationPreferences();
    await setNotificationPreference("system", true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("schedules one immediate notification with route-only data", async () => {
    const result = await scheduleLocalAlertNotification({
      alert: ALERT,
      eventKey: "event-1",
      title: "Codex finished",
      body: "Project · spawn",
      appState: "background",
      workspaceId: "workspace-1",
      tabId: "tab-1",
    });

    expect(result).toEqual({ scheduled: true, identifier: "notification-1" });
    expect(ExpoNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          data: {
            sessionId: "session-1",
            eventKey: "event-1",
            workspaceId: "workspace-1",
            tabId: "tab-1",
          },
        }),
        trigger: null,
      }),
    );
    const request = jest.mocked(ExpoNotifications.scheduleNotificationAsync).mock.calls[0]?.[0];
    expect(request?.content.data).not.toHaveProperty("command");
    expect(request?.content.data).not.toHaveProperty("cwd");
  });

  it("rate-limits a chatty session until the complete window has elapsed", async () => {
    const input = {
      alert: ALERT,
      eventKey: "event-1",
      title: "Codex finished",
      body: "Project · spawn",
      appState: "background" as const,
    };
    expect((await scheduleLocalAlertNotification(input)).scheduled).toBe(true);

    jest.advanceTimersByTime(LOCAL_NOTIFICATION_RATE_LIMIT_MS - 1);
    expect(await scheduleLocalAlertNotification({ ...input, eventKey: "event-2" })).toEqual({
      scheduled: false,
      reason: "rate_limited",
    });

    jest.advanceTimersByTime(1);
    expect(
      (await scheduleLocalAlertNotification({ ...input, eventKey: "event-3" })).scheduled,
    ).toBe(true);
    expect(ExpoNotifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
  });

  it("degrades denied, muted, disabled, and foreground paths without scheduling", async () => {
    jest.mocked(ExpoNotifications.getPermissionsAsync).mockResolvedValue(permission("denied"));
    expect(
      await scheduleLocalAlertNotification({
        alert: ALERT,
        eventKey: "denied",
        title: "Codex finished",
        body: "Project",
        appState: "background",
      }),
    ).toEqual({ scheduled: false, reason: "permission_denied" });

    jest.mocked(ExpoNotifications.getPermissionsAsync).mockResolvedValue(permission("granted"));
    await setSessionNotificationsMuted(ALERT.session_id, true);
    expect(
      await scheduleLocalAlertNotification({
        alert: ALERT,
        eventKey: "muted",
        title: "Codex finished",
        body: "Project",
        appState: "background",
      }),
    ).toEqual({ scheduled: false, reason: "session_muted" });
    await setSessionNotificationsMuted(ALERT.session_id, false);
    expect(
      await scheduleLocalAlertNotification({
        alert: ALERT,
        eventKey: "active",
        title: "Codex finished",
        body: "Project",
        appState: "active",
      }),
    ).toEqual({ scheduled: false, reason: "app_active" });
  });

  it("parses only safe navigation identifiers from notification responses", () => {
    expect(
      parseNotificationNavigationTarget({
        sessionId: "session-1",
        workspaceId: "workspace-1",
        tabId: "tab-1",
        eventKey: "event-1",
        terminalOutput: "secret",
      }),
    ).toEqual({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      eventKey: "event-1",
    });
    expect(parseNotificationNavigationTarget({ workspaceId: "workspace-1" })).toBeNull();
  });

  it("accepts only the exact host pairing push shape", () => {
    expect(
      parseNotificationPairingTarget({
        event: "host.pair_requested",
        approvalRef: "approval-ref-123",
      }),
    ).toEqual({ approvalRef: "approval-ref-123" });
    for (const malformed of [
      null,
      {},
      { event: "host.pair_requested" },
      { event: "host.pair_requested", approvalRef: "" },
      { event: "host.pair_requested", approvalRef: " approval-ref-123" },
      { event: "host.pair_requested", approvalRef: 42 },
      { event: "device.approval_requested", approvalRef: "approval-ref-123" },
    ]) {
      expect(parseNotificationPairingTarget(malformed)).toBeNull();
    }
  });
});
