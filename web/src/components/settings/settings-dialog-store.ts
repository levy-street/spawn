"use client";

import { useSyncExternalStore } from "react";

/**
 * Which settings tab is open, app-wide. A module singleton (not URL state) so
 * opening settings never navigates — the modal overlays whatever the user is
 * doing, and closing it returns them exactly there.
 */
export type SettingsTab =
  | "account"
  | "appearance"
  | "hosts"
  | "agents"
  | "skills"
  | "devices"
  | "trust";

let openTab: SettingsTab | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openSettings(tab: SettingsTab = "account") {
  openTab = tab;
  emit();
}

export function closeSettings() {
  openTab = null;
  emit();
}

export function useSettingsDialog(): SettingsTab | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => openTab,
    () => null,
  );
}
