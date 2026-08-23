const PRIMARY_HEADER_DESTINATION_LABELS = new Set(["Open hosts", "Open settings"]);

/** Primary destinations live in the persistent tab bar, never in AppHeader. */
export function isPrimaryHeaderDestinationAction(action: { accessibilityLabel: string }): boolean {
  return PRIMARY_HEADER_DESTINATION_LABELS.has(action.accessibilityLabel);
}
