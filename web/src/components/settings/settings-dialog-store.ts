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
  | "notifications"
  | "hosts"
  | "agents"
  | "access"
  | "skills"
  | "templates";

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

/**
 * The settings tab a full-page navigation came *from*, so that page's back
 * control can return to it instead of guessing.
 *
 * A module value rather than a query parameter, for the same reason the open
 * tab is one: the dialog is not URL state, so "I got here from the Hosts tab"
 * is a fact about this session's navigation and not about the address. It is
 * read once and cleared — arriving any other way, or reloading, leaves it null,
 * and back then means back.
 */
let returnTab: SettingsTab | null = null;

/** Close the dialog on the way to a page that can return to this tab. */
export function leaveSettingsFor(tab: SettingsTab) {
  returnTab = tab;
  closeSettings();
}

/** The tab to return to, consumed. Null unless the last navigation set one. */
export function takeSettingsReturn(): SettingsTab | null {
  const tab = returnTab;
  returnTab = null;
  return tab;
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
