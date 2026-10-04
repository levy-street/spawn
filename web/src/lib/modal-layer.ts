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

/**
 * What a menu or a dialog looks like on screen. Every menu here renders
 * `role="menu"` only while it is open, and every modal surface `role="dialog"`
 * (or `alertdialog`, or `aria-modal`) only while it is up — including the few
 * that never announce themselves above, and anything added later. A hover card
 * is `role="group"` precisely so it never matches.
 */
const OPEN_LAYER_SELECTOR =
  '[role="menu"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** The slice of a DOM element `menuOrDialogOpen` reads, so a test can hand it plain objects. */
export type LayerElement<E> = {
  contains(other: E | null): boolean;
  getAttribute(name: string): string | null;
};

/**
 * Whether a menu or a dialog is open anywhere except around `owner`.
 *
 * The question a hover card asks before it opens. The card is the lowest thing
 * on screen: it gives way to every menu and every dialog, whoever opened it —
 * except a dialog or drawer the card's own list lives inside, which is the
 * ground it stands on rather than something over it. A surface still playing
 * its closing animation (`data-state="closed"`) is already gone.
 */
export function menuOrDialogOpen<E extends LayerElement<E>>(
  root: { querySelectorAll(selectors: string): ArrayLike<E> },
  owner: E | null,
): boolean {
  return Array.from(root.querySelectorAll(OPEN_LAYER_SELECTOR)).some(
    (layer) =>
      layer.getAttribute("data-state") !== "closed" && !(owner !== null && layer.contains(owner)),
  );
}
