"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the profile is open, app-wide.
 *
 * A module singleton rather than URL state, for the same reason the settings
 * dialog is one: the profile overlays whatever you were doing — a workspace
 * full of live terminals — and closing it has to put you back exactly there,
 * with every pane still attached.
 */
let open = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openProfile() {
  open = true;
  emit();
}

export function closeProfile() {
  open = false;
  emit();
}

export function useProfileDialog(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false,
  );
}
