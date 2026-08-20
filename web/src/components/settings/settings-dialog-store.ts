"use client";

import { useSyncExternalStore } from "react";

/**
 * Which settings tab is open, app-wide. A module singleton (not URL state) so
 * opening settings never navigates — the modal overlays whatever the user is
 * doing, and closing it returns them exactly there. /settings and /trust stay
 * deep-linkable via redirect pages that call `openSettings` on mount.
 */
export type SettingsTab = "account" | "appearance" | "access" | "skills";

/**
 * Old bookmarks and copy said "Browser devices" / "Device trust"; both now
 * live on the one Access tab (docs/TRUST_UX.md).
 */
export type SettingsTabRequest = SettingsTab | "devices" | "trust";

let openTab: SettingsTab | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openSettings(tab: SettingsTabRequest = "account") {
  openTab = tab === "devices" || tab === "trust" ? "access" : tab;
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
