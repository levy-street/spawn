"use client";

import { useSyncExternalStore } from "react";

/**
 * Which settings tab is open, app-wide. A module singleton (not URL state) so
 * opening settings never navigates — the modal overlays whatever the user is
 * doing, and closing it returns them exactly there.
 */
/**
 * Machines are the Legion's, not a setting: possessing one is the Add a
 * machine dialog (`hosts/add-machine-dialog-store`) and a host's own page
 * renames and removes it, so there is no Hosts tab to return to.
 */
export type SettingsTab =
  | "account"
  | "appearance"
  | "notifications"
  | "agents"
  | "access"
  | "skills"
  | "templates"
  /**
   * Only on a deployment that has billing. `SettingsDialog` drops the tab
   * where there is none, so a self-hoster never sees it — and an
   * `openSettings("subscription")` that reaches one anyway (a stale caller, or
   * a call made before the config landed) falls back to Account rather than
   * opening an empty panel.
   */
  | "subscription";

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
