"use client";

import { createContext, type ReactNode, type RefObject, useContext, useMemo } from "react";

/**
 * Which column of the window a workspace surface belongs to.
 *
 * Before split view there was exactly one grid on screen, and half a dozen
 * places took the shortcut that follows from that: `document.querySelector`
 * for the canvas, for the launcher, for the openings a dragged pane can land
 * in. With several workspaces up, every one of those finds the *first* match
 * in the document, which is the leftmost column regardless of who asked — a
 * launcher on the right measuring the canvas on the left drops panes at
 * coordinates from the wrong grid.
 *
 * So surfaces stop asking the document and ask their own column instead. The
 * unsplit window provides this too, as column 0 of one, so there is one code
 * path rather than a split-only branch in every consumer.
 */
export interface PaneScope {
  /** The workspace this column is showing. */
  workspaceId: string;
  /** Which column this is, counted from the left. Zero when unsplit. */
  column: number;
  /** True only when the window actually holds more than one workspace. */
  split: boolean;
  /**
   * Whether this column is the one the address bar is about. Any column of a
   * split can be — the URL names a workspace, not a position — and the
   * surfaces that push a route (a first window opening with `?focus=`) are the
   * ones that need to know, so the other columns never navigate on their
   * behalf.
   */
  routed: boolean;
  /**
   * Whether this column owns the document-level gestures — keyboard focus
   * movement, the workspace digit shortcuts. Always true when unsplit.
   */
  active: boolean;
  /**
   * This column's root element. A ref rather than the node, so the value is
   * stable across renders and a gesture that starts before layout settles
   * still reads the live element when it runs.
   */
  rootRef: RefObject<HTMLElement | null>;
}

const PaneScopeContext = createContext<PaneScope | null>(null);

export function PaneScopeProvider({
  workspaceId,
  column,
  split,
  routed,
  active,
  rootRef,
  children,
}: PaneScope & { children: ReactNode }) {
  const value = useMemo<PaneScope>(
    () => ({ workspaceId, column, split, routed, active, rootRef }),
    [active, column, rootRef, routed, split, workspaceId],
  );
  return <PaneScopeContext.Provider value={value}>{children}</PaneScopeContext.Provider>;
}

/**
 * This surface's column of the window.
 *
 * Throws when used outside a provider rather than inventing a default: a
 * silent fallback would put us straight back to document-wide lookups, and
 * the bug that causes only shows up in split view, which is exactly where
 * nobody is looking.
 */
export function usePaneScope(): PaneScope {
  const scope = useContext(PaneScopeContext);
  if (!scope) throw new Error("usePaneScope must be used within a PaneScopeProvider");
  return scope;
}

/**
 * Optional variant, for surfaces that also render outside a workspace (the
 * session page, the sidebar's own previews). Null means "not in a column", and
 * the caller is expected to fall back to the whole document.
 */
export function useOptionalPaneScope(): PaneScope | null {
  return useContext(PaneScopeContext);
}

/**
 * The DOM attribute every column's root carries, naming the workspace in it.
 * Gestures that hit-test with `elementFromPoint` use it to find which column a
 * pointer is over — a pointer is a document-level fact, so that lookup
 * genuinely has to start there.
 */
export const PANE_SCOPE_ATTR = "data-workspace-pane";

/** The column of the window under a point, or null when the point is elsewhere. */
export function paneRootAt(x: number, y: number): HTMLElement | null {
  const under = document.elementFromPoint(x, y);
  return under?.closest?.<HTMLElement>(`[${PANE_SCOPE_ATTR}]`) ?? null;
}

/**
 * Query within one column. `root` null falls back to the document, which is the
 * correct answer for surfaces that are not inside a column at all — not a
 * silent degradation, since `useOptionalPaneScope` is what produces the null.
 */
export function queryInPane<E extends Element = Element>(
  root: HTMLElement | null,
  selector: string,
): E | null {
  return (root ?? document).querySelector<E>(selector);
}

export function queryAllInPane<E extends Element = Element>(
  root: HTMLElement | null,
  selector: string,
): E[] {
  return [...(root ?? document).querySelectorAll<E>(selector)];
}
