import { useCallback, useEffect, useState } from "react";
import {
  loadNotificationPreferences,
  type NotificationBooleanKey,
  type NotificationPreferences,
  saveNotificationPreferences,
} from "@/components/settings/notification-preferences";

export interface NotificationPreferencesState {
  preferences: NotificationPreferences | null;
  setPreference: (key: NotificationBooleanKey, value: boolean) => void;
  error: string | null;
}

export function useNotificationPreferences(): NotificationPreferencesState {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadNotificationPreferences().then((loaded) => {
      if (active) setPreferences(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((key: NotificationBooleanKey, value: boolean) => {
    setPreferences((current) => {
      if (current === null) return current;
      const next = { ...current, [key]: value };
      void saveNotificationPreferences(next).then(
        () => setError(null),
        () => setError("Notification preferences could not be saved on this device."),
      );
      return next;
    });
  }, []);

  return { preferences, setPreference, error };
}
