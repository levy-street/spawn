"use client";

import { useSyncExternalStore } from "react";

/**
 * One pending "start approving this device" request, app-wide. The ceremony
 * itself is driven by a single app-level host (AccessCeremonyHost) so the
 * relay is never double-driven; any surface (the Access roster's Approve
 * button, the corner toast) asks for a ceremony through here.
 */
let requestedDeviceId: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function requestApproval(deviceId: string) {
  requestedDeviceId = deviceId;
  emit();
}

export function consumeApprovalRequest() {
  requestedDeviceId = null;
  emit();
}

export function useApprovalRequest(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => requestedDeviceId,
    () => null,
  );
}
