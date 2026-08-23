"use client";

import { useSyncExternalStore } from "react";

/**
 * Split view — two workspaces side by side in the one main window.
 *
 * The routed workspace (`/w/[id]`) is always the primary, on the left; a
 * second workspace can be set beside it and the seam between them dragged.
 * The pair is per-device state, not workspace data: it is the same kind of
 * fact as the sidebar's width or a workspace's last-open tab, and like both
 * of those it lives in localStorage and never touches the server. Nothing in
 * the layout envelope knows a workspace is being shown beside another one.
 *
 * Deliberately NOT a query parameter. `?split=` would make the arrangement
 * shareable, which is the wrong promise — a link that rearranges the
 * recipient's window is not a link to a workspace — and reading search params
 * in the shell would drag a Suspense boundary up around the sidebar for no
 * gain. Same reasoning as `settings-dialog-store`.
 *
 * A module singleton rather than context, because the two sides that need it
 * are not in one tree: the sidebar (in `AppShell`) opens a split, and the
 * workspace page (in `children`) renders it.
 */

export const SPLIT_STORAGE_KEY = "spawn.workspaces.split";

/** Which half of a split a component belongs to. Unsplit is all `primary`. */
export type SplitSide = "primary" | "secondary";

export interface SplitState {
  /**
   * The workspace shown beside the routed one, or null when the window holds
   * a single workspace. Never equal to the routed workspace — `open` refuses
   * that, and `reconcile` clears it if navigation makes it so.
   */
  secondaryId: string | null;
  /**
   * The second workspace actually on screen — which is not the same fact as
   * the pair above. Below the width a split needs, the container renders the
   * primary alone and this stays null while `secondaryId` keeps the
   * arrangement for when the window widens again.
   *
   * Anything *drawing* the split wants this one: the sidebar marking a row as
   * shown-beside, a half's own chrome, the grid asking whether it has half a
   * window to lay out in. Only the container itself wants the stored pair.
   *
   * Published by the container rather than derived here, because the answer
   * depends on a measured element and this module cannot see the DOM. It is
   * session-only, like `activeSide` — a reload re-measures.
   */
  renderedSecondaryId: string | null;
  /** The primary's share of the canvas width, 0..1, clamped to the bounds. */
  ratio: number;
  /**
   * The half that owns document-level gestures: the pane-focus arrows, the
   * workspace digit shortcuts, and anything else that reads as "the thing I
   * am working in". Both grids register the same global listeners, so without
   * this a keypress fires in both.
   */
  activeSide: SplitSide;
}

/**
 * How narrow a half may get. Below a quarter the grid has nothing left to say
 * — a 24-column canvas at 4-column minimum needs real width to be a grid at
 * all — and the seam stops being draggable back.
 */
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 0.75;
export const DEFAULT_RATIO = 0.5;

const DEFAULT_STATE: SplitState = {
  secondaryId: null,
  renderedSecondaryId: null,
  ratio: DEFAULT_RATIO,
  activeSide: "primary",
};

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** Coerce anything that came out of storage into a usable split. */
export function normalizeSplit(value: unknown): SplitState {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_STATE };
  const raw = value as Record<string, unknown>;
  return {
    secondaryId: typeof raw.secondaryId === "string" && raw.secondaryId ? raw.secondaryId : null,
    // Never restored: whether a half is on screen is a measurement, and
    // nothing has been measured yet at the moment storage is read.
    renderedSecondaryId: null,
    ratio: clampRatio(typeof raw.ratio === "number" ? raw.ratio : DEFAULT_RATIO),
    // Never restored: which half you were last typing in is a fact about a
    // session, and a reload starts at the routed workspace by definition.
    activeSide: "primary",
  };
}

export function readStoredSplit(): SplitState {
  if (typeof window === "undefined") return { ...DEFAULT_STATE };
  try {
    const stored = window.localStorage.getItem(SPLIT_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_STATE };
    return normalizeSplit(JSON.parse(stored));
  } catch {
    // Private browsing, blocked storage, or a corrupt value. A single
    // workspace is a perfectly good answer and not worth surfacing.
    return { ...DEFAULT_STATE };
  }
}

// --- store -----------------------------------------------------------------

const listeners = new Set<() => void>();
let state: SplitState = { ...DEFAULT_STATE };
let initialised = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function ensureInitialised(): void {
  if (initialised || typeof window === "undefined") return;
  initialised = true;
  state = readStoredSplit();
}

/** Write the persistable half of the state; `activeSide` is session-only. */
function persist(): void {
  try {
    window.localStorage.setItem(
      SPLIT_STORAGE_KEY,
      JSON.stringify({ secondaryId: state.secondaryId, ratio: state.ratio }),
    );
  } catch {
    // Storage refused; the arrangement still holds for this session.
  }
}

function set(next: SplitState): void {
  if (
    next.secondaryId === state.secondaryId &&
    next.renderedSecondaryId === state.renderedSecondaryId &&
    next.ratio === state.ratio &&
    next.activeSide === state.activeSide
  ) {
    return;
  }
  const persistable = next.secondaryId !== state.secondaryId || next.ratio !== state.ratio;
  state = next;
  if (persistable) persist();
  emit();
}

export const splitStore = {
  get(): SplitState {
    ensureInitialised();
    return state;
  },

  subscribe(listener: () => void): () => void {
    ensureInitialised();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /**
   * Show `workspaceId` beside the routed one. `routedId` is passed so the
   * store can refuse the one arrangement that means nothing — a workspace
   * beside itself — rather than leaving every caller to check.
   *
   * Opening onto an already-split window replaces the second workspace and
   * keeps the seam where it is: the window's shape is the user's, and only
   * its contents were asked to change.
   */
  open(workspaceId: string, routedId: string | null): void {
    ensureInitialised();
    if (!workspaceId || workspaceId === routedId) return;
    set({ ...state, secondaryId: workspaceId });
  },

  /** Back to one workspace, keeping the routed one. */
  close(): void {
    ensureInitialised();
    set({ ...state, secondaryId: null, activeSide: "primary" });
  },

  /**
   * Back to one workspace, keeping the *second* one — the "close the left
   * half" gesture. Clears the split and returns the workspace the caller now
   * has to navigate to, or null when there was nothing to promote. Navigation
   * stays with the caller: this module owns no router.
   */
  promoteSecondary(): string | null {
    ensureInitialised();
    const promoted = state.secondaryId;
    if (!promoted) return null;
    set({ ...state, secondaryId: null, activeSide: "primary" });
    return promoted;
  },

  /**
   * Report which second workspace is actually mounted, or null when the
   * window is showing one. The container is the only caller: it owns the
   * measurement, and it holds the outgoing half mounted through its collapse,
   * so this stays set for the length of a close and the surfaces reading it
   * do not reflow while the geometry is still moving.
   */
  setRendered(workspaceId: string | null): void {
    ensureInitialised();
    set({ ...state, renderedSecondaryId: workspaceId });
  },

  /** Move the seam. Clamped, so a caller may pass raw pointer arithmetic. */
  setRatio(ratio: number): void {
    ensureInitialised();
    set({ ...state, ratio: clampRatio(ratio) });
  },

  /** Which half owns the global gestures now. No-op when not split. */
  setActiveSide(side: SplitSide): void {
    ensureInitialised();
    if (!state.secondaryId) return;
    set({ ...state, activeSide: side });
  },

  /**
   * Reconcile the stored pair against the workspaces that actually exist and
   * the one currently routed. Called by the split container on every
   * workspace list change, and it is what makes the arrangement survive an
   * archive, a delete, or navigating to the workspace already on the right.
   *
   * `knownIds` null means "the list has not loaded yet" — the pair is left
   * alone rather than being cleared against an empty list, which would drop
   * the second workspace on every cold load.
   */
  reconcile(routedId: string | null, knownIds: ReadonlySet<string> | null): void {
    ensureInitialised();
    const secondary = state.secondaryId;
    if (!secondary) return;
    if (secondary === routedId) {
      // Navigated to the workspace that was already beside this one; it is
      // the whole window now.
      set({ ...state, secondaryId: null, activeSide: "primary" });
      return;
    }
    if (knownIds && !knownIds.has(secondary)) {
      set({ ...state, secondaryId: null, activeSide: "primary" });
    }
  },
};

/** The split arrangement, reactively. */
export function useSplit(): SplitState {
  return useSyncExternalStore(splitStore.subscribe, splitStore.get, () => DEFAULT_STATE);
}

/**
 * Whether two workspaces are on screen right now — the drawn fact, not the
 * stored one. A window too narrow to hold a split reads false here while
 * keeping its pair for when it widens.
 */
export function useIsSplit(): boolean {
  return useSplit().renderedSecondaryId !== null;
}
