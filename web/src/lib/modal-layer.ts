/**
 * Which of two overlapping surfaces wins, when a stacking order alone cannot
 * say.
 *
 * Menus and popovers are drawn *above* modals on purpose: one opened from
 * inside a dialog has to clear it — settings' agent rows, the file viewer's
 * kebab, the folder picker's breadcrumb. That is only right for a popup the
 * modal itself spawned. A popup already on screen when a modal opens has the
 * opposite claim: the modal has just taken the window, and a menu floating
 * over its scrim — still clickable, still hit-testing above it — is a leftover,
 * not a layer.
 *
 * Order is the whole rule, and it is not something z-index can express. So a
 * modal announces itself as it opens and every popup already up takes that as
 * its dismissal; a popup opened afterwards subscribes to the next one instead.
 * Deliberately not a DOM event: a plain registry needs no event name, no
 * document, and can be reasoned about in a test.
 */
const listeners = new Set<() => void>();

/** Called by every modal surface as it opens: dialogs, sheets, drawers. */
export function announceModalOpen(): void {
  // Iterated over a copy: the usual reaction is a popup closing itself, which
  // unsubscribes mid-notification.
  for (const listener of [...listeners]) listener();
}

/** Register a popup's dismissal. Returns the unsubscribe. */
export function subscribeToModalOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
