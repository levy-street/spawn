import { useSyncExternalStore } from "react";

import { CameraOverlay } from "@/components/media/camera-overlay";
import type { PickedImage } from "@/components/media/image-source";

interface PendingCapture {
  resolve: (picture: PickedImage | null) => void;
}

let pending: PendingCapture | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function settle(picture: PickedImage | null): void {
  const request = pending;
  pending = null;
  emit();
  request?.resolve(picture);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): PendingCapture | null {
  return pending;
}

/**
 * Opens the camera over everything and resolves with the photo taken, or null
 * once it is closed without one. One capture at a time: a second request
 * while the first is up answers the first with nothing.
 */
export function captureWithCamera(): Promise<PickedImage | null> {
  pending?.resolve(null);
  return new Promise<PickedImage | null>((resolve) => {
    pending = { resolve };
    emit();
  });
}

/**
 * Whether the camera is up. The persistent nav bar reads this and steps aside:
 * it is portalled to window level, above any presented modal, and a tab bar
 * across the bottom of a viewfinder is exactly what the in-app camera replaced.
 */
export function useCameraOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => null) !== null;
}

/** Mount once near the app root, the way `ConfirmHost` is. */
export function CameraHost(): React.JSX.Element {
  const request = useSyncExternalStore(subscribe, snapshot, () => null);
  return (
    <CameraOverlay
      onCapture={(picture) => settle(picture)}
      onClose={() => settle(null)}
      visible={request !== null}
    />
  );
}
