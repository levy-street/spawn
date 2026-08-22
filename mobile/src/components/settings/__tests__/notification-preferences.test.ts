import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  loadNotificationPreferences,
  MAX_MUTED_SESSIONS,
  NOTIFICATION_PREFERENCES_KEY,
  type NotificationPreferenceStorage,
  parseNotificationPreferences,
  saveNotificationPreferences,
} from "@/components/settings/notification-preferences";

function storage(initial: string | null = null): NotificationPreferenceStorage & {
  getItem: jest.Mock;
  setItem: jest.Mock;
  removeItem: jest.Mock;
} {
  return {
    getItem: jest.fn(async () => initial),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  };
}

describe("notification preferences", () => {
  test("uses the documented per-device defaults", () => {
    expect(parseNotificationPreferences(null)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(parseNotificationPreferences("not-json")).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  test("preserves valid values, defaults invalid fields, and bounds muted sessions", () => {
    const mutedSessions = Array.from(
      { length: MAX_MUTED_SESSIONS + 5 },
      (_, index) => `s-${index}`,
    );
    const parsed = parseNotificationPreferences(
      JSON.stringify({
        toast: false,
        sound: true,
        system: "yes",
        haptics: true,
        onFinished: false,
        onAwaiting: false,
        onDied: false,
        mutedSessions: [mutedSessions[0], ...mutedSessions, mutedSessions.at(-1)],
      }),
    );

    expect(parsed.toast).toBe(false);
    expect(parsed.sound).toBe(true);
    expect(parsed.system).toBe(DEFAULT_NOTIFICATION_PREFERENCES.system);
    expect(parsed.mutedSessions).toHaveLength(MAX_MUTED_SESSIONS);
    expect(parsed.mutedSessions.at(-1)).toBe(mutedSessions.at(-1));
  });

  test("reads and writes only the native local preference store", async () => {
    const deviceStore = storage(JSON.stringify({ toast: false }));
    const loaded = await loadNotificationPreferences(deviceStore);
    expect(deviceStore.getItem).toHaveBeenCalledWith(NOTIFICATION_PREFERENCES_KEY);
    expect(loaded.toast).toBe(false);

    await saveNotificationPreferences({ ...loaded, sound: true }, deviceStore);
    expect(deviceStore.setItem).toHaveBeenCalledWith(
      NOTIFICATION_PREFERENCES_KEY,
      expect.stringContaining('"sound":true'),
    );
  });
});
