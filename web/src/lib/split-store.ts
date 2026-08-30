"use client";

import { useSyncExternalStore } from "react";

/**
 * Split view — two workspaces side by side in the one main window.
 *
 * The arrangement is a *pair*: two workspace ids, left and right, held
 * independently of whatever `/w/[id]` currently names. A route onto either
 * member draws the pair; a route onto a third workspace draws that workspace
 * alone and leaves the pair standing, ready for the next time one of its
 * members is opened. That is the whole reason the pair is stored as two ids
 * rather than as "the routed one, plus a second": the earlier shape could not
 * survive its own primary being navigated away from, so visiting a third
 * workspace silently ate half the split.
 *
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

/**
 * The two workspaces of a split, in the order they are drawn. Both ends are
 * named, so the pair means the same thing whichever of them the URL is about
 * — or whether it is about either of them at all.
 */
export interface SplitPair {
  primaryId: string;
  secondaryId: string;
}

export interface SplitState {
  /**
   * The workspaces arranged side by side, or null when there is no split.
   * Kept across navigation to a third workspace: the arrangement is a thing
   * the user built, and opening something else is not a request to dismantle
   * it. `reconcile` is what clears it, and only when a member stops existing.
   */
  pair: SplitPair | null;
  /**
   * The second workspace actually on screen — which is not the same fact as
   * the pair above. On a page that is not a workspace, or on a route onto a
   * workspace outside the pair, this is null while the pair keeps standing.
   *
   * Anything *drawing* the split wants this one: the sidebar asking whether
   * the arrangement it lists is the window in front of you, a half's own
   * chrome, the drop rules asking how many halves a release can land in.
   *
   * Published by the container rather than derived here, because the answer
   * depends on what is mounted and this module cannot see the DOM. It is
   * session-only, like `activeSide` — a reload re-renders.
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
 * How narrow a half may get, as a share of the canvas. A quarter is where the
 * seam stops being draggable back; the window's own width is not policed at
 * all, because a split the user asked for is a split they get.
 */
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 0.75;
export const DEFAULT_RATIO = 0.5;

const DEFAULT_STATE: SplitState = {
  pair: null,
  renderedSecondaryId: null,
  ratio: DEFAULT_RATIO,
  activeSide: "primary",
};

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** A pair of two real, different workspaces, or null for anything else. */
function toPair(primaryId: unknown, secondaryId: unknown): SplitPair | null {
  if (typeof primaryId !== "string" || typeof secondaryId !== "string") return null;
  if (!primaryId || !secondaryId || primaryId === secondaryId) return null;
  return { primaryId, secondaryId };
}

/** Which half of `pair` a workspace occupies, or null when it is in neither. */
export function memberSide(pair: SplitPair | null, workspaceId: string | null): SplitSide | null {
  if (!pair || !workspaceId) return null;
  if (pair.primaryId === workspaceId) return "primary";
  if (pair.secondaryId === workspaceId) return "secondary";
  return null;
}

/**
 * The pair a given route draws, or null when that route draws one workspace.
 *
 * The single rule the whole feature turns on: a split is on screen when the
 * URL names one of its members, and the arrangement is the pair's own, not
 * the URL's. Opening a third workspace therefore parks the split rather than
 * consuming a half of it.
 */
export function splitFor(pair: SplitPair | null, routedId: string | null): SplitPair | null {
  return memberSide(pair, routedId) ? pair : null;
}

/** Coerce anything that came out of storage into a usable split. */
export function normalizeSplit(value: unknown): SplitState {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_STATE };
  const raw = value as Record<string, unknown>;
  return {
    // A value written by the older shape carried only the second workspace,
    // which names no arrangement on its own; it normalises to no split, and
    // the next one the user builds overwrites it.
    pair: toPair(raw.primaryId, raw.secondaryId),
    // Never restored: whether a half is on screen is a fact about what is
    // mounted, and nothing is mounted at the moment storage is read.
    renderedSecondaryId: null,
    ratio: clampRatio(typeof raw.ratio === "number" ? raw.ratio : DEFAULT_RATIO),
    // Never restored: which half you were last typing in is a fact about a
    // session, and a reload starts at whichever half the URL names.
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
      JSON.stringify({
        primaryId: state.pair?.primaryId ?? null,
        secondaryId: state.pair?.secondaryId ?? null,
        ratio: state.ratio,
      }),
    );
  } catch {
    // Storage refused; the arrangement still holds for this session.
  }
}

function samePair(a: SplitPair | null, b: SplitPair | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.primaryId === b.primaryId && a.secondaryId === b.secondaryId;
}

function set(next: SplitState): void {
  if (
    samePair(next.pair, state.pair) &&
    next.renderedSecondaryId === state.renderedSecondaryId &&
    next.ratio === state.ratio &&
    next.activeSide === state.activeSide
  ) {
    return;
  }
  const persistable = !samePair(next.pair, state.pair) || next.ratio !== state.ratio;
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
   * Arrange these two workspaces side by side, left first. Refuses the one
   * arrangement that means nothing — a workspace beside itself — rather than
   * leaving every caller to check.
   *
   * Rearranging an existing split keeps the seam where it is: the window's
   * shape is the user's, and only its contents were asked to change.
   */
  setPair(primaryId: string | null, secondaryId: string | null): void {
    ensureInitialised();
    const pair = toPair(primaryId, secondaryId);
    if (!pair) return;
    set({ ...state, pair });
  },

  /** No split at all, whichever workspace the window ends up showing. */
  clear(): void {
    ensureInitialised();
    set({ ...state, pair: null, activeSide: "primary" });
  },

  /**
   * End the split, keeping `keepId` — the "close the other half" gesture,
   * wherever it is offered from. Returns the workspace the caller now has to
   * navigate to, or null when the route already lands somewhere sensible:
   * either it is already on the half being kept, or it was never on this
   * split at all and nothing about the current page changed. Navigation stays
   * with the caller; this module owns no router.
   */
  unsplit(keepId: string, routedId: string | null): string | null {
    ensureInitialised();
    const side = memberSide(state.pair, routedId);
    set({ ...state, pair: null, activeSide: "primary" });
    return side && routedId !== keepId ? keepId : null;
  },

  /**
   * Report which second workspace is actually mounted, or null when the
   * window is showing one. The container is the only caller: it holds the
   * outgoing half mounted through its collapse, so this stays set for the
   * length of a close and the surfaces reading it do not reflow while the
   * geometry is still moving.
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

  /** Which half owns the global gestures now. No-op when there is no split. */
  setActiveSide(side: SplitSide): void {
    ensureInitialised();
    if (!state.pair) return;
    set({ ...state, activeSide: side });
  },

  /**
   * Hand the gestures to the half the URL is about. Called when the route
   * changes rather than on every render: within a split the active half is
   * the user's own — clicking into the other pane moves it, and nothing
   * should move it back until they go somewhere.
   */
  followRoute(routedId: string | null): void {
    ensureInitialised();
    set({ ...state, activeSide: memberSide(state.pair, routedId) ?? "primary" });
  },

  /**
   * Reconcile the pair against the workspaces that actually exist. Called by
   * the split container on every workspace list change, and it is what makes
   * an archive or a delete take its half of the arrangement with it.
   *
   * `knownIds` null means "the list has not loaded yet" — the pair is left
   * alone rather than being cleared against an empty list, which would drop
   * the arrangement on every cold load.
   */
  reconcile(knownIds: ReadonlySet<string> | null): void {
    ensureInitialised();
    const pair = state.pair;
    if (!pair || !knownIds) return;
    if (knownIds.has(pair.primaryId) && knownIds.has(pair.secondaryId)) return;
    set({ ...state, pair: null, activeSide: "primary" });
  },
};

/** The split arrangement, reactively. */
export function useSplit(): SplitState {
  return useSyncExternalStore(splitStore.subscribe, splitStore.get, () => DEFAULT_STATE);
}

/**
 * Whether two workspaces are on screen right now — the drawn fact, not the
 * stored one. A parked pair, held for the next time one of its members is
 * opened, reads false here.
 */
export function useIsSplit(): boolean {
  return useSplit().renderedSecondaryId !== null;
}
