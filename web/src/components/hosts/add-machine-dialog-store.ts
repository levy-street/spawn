"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the Add a machine dialog is open, app-wide.
 *
 * A module singleton, for the same reason the settings dialog has one:
 * opening it never navigates. It overlays whatever the person is doing —
 * the fleet page, a workspace, the Access panel — and closing it returns
 * them exactly there. `/device` stays a route because approval links from
 * the terminal land on it; every in-app "add a machine" affordance opens
 * this instead.
 */
let isOpen = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openAddMachine() {
  isOpen = true;
  emit();
}

export function closeAddMachine() {
  isOpen = false;
  emit();
}

export function useAddMachineDialog(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => isOpen,
    () => false,
  );
}
