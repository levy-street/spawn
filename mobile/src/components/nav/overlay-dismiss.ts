const navigationOverlayDismissers = new Set<() => void>();

/** Registers a portalled overlay that primary navigation must close before changing tabs. */
export function registerNavigationOverlayDismiss(onDismiss: () => void): () => void {
  navigationOverlayDismissers.add(onDismiss);
  return () => {
    navigationOverlayDismissers.delete(onDismiss);
  };
}

/** Closes every registered overlay and reports whether navigation should reset to a root. */
export function dismissNavigationOverlays(): boolean {
  const dismissers = [...navigationOverlayDismissers];
  for (const dismiss of dismissers) dismiss();
  return dismissers.length > 0;
}
