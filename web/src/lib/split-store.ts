"use client";

import { useSyncExternalStore } from "react";
import { type Columns, MIN_MEMBERS, normalizeSizes, removeColumn, toGroup } from "./split-group";

/**
 * Split view — two to four workspaces side by side in the one main window.
 *
 * The arrangement is a *group*: an ordered list of workspace ids, drawn as
 * columns left to right, held independently of whatever `/w/[id]` currently
 * names. A route onto any member draws the group; a route onto a workspace
 * outside it draws that workspace alone and leaves the group standing, ready
 * for the next time one of its members is opened. That is the whole reason the
 * group is stored as its own list rather than as "the routed one, plus the
 * others": the earlier shape could not survive its own first member being
 * navigated away from, so visiting another workspace silently ate part of the
 * split.
 *
 * The group is per-device state, not workspace data: it is the same kind of
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
 *
 * The arithmetic of a group — adding, removing and moving columns, the seams
 * and their floors, how many columns a window holds — is `split-group`'s.
 * This module only holds the one group there is, and says when it changed.
 */

export const SPLIT_STORAGE_KEY = "spawn.workspaces.split";

/**
 * The workspaces of a split, in the order they are drawn, and each column's
 * share of the canvas. Every member is named, so the group means the same
 * thing whichever of them the URL is about — or whether it is about any of
 * them at all.
 */
export type SplitGroup = Columns;

export interface SplitState {
  /**
   * The workspaces arranged side by side, or null when there is no split.
   * Kept across navigation to a workspace outside it: the arrangement is a
   * thing the user built, and opening something else is not a request to
   * dismantle it. Removing a member is what shrinks it — by hand, or through
   * `reconcile` when a member stops existing — and a group left with one
   * workspace is no group at all.
   */
  group: SplitGroup | null;
  /**
   * The workspaces actually on screen as columns, left to right — which is not
   * the same fact as the group above. Empty when the window draws a single
   * workspace: on a page that is not a workspace, on a route onto a workspace
   * outside the group (which keeps standing), or before anything has mounted.
   * It can also be fewer than the group, on a window too narrow to draw all of
   * it, and for the length of a close it still names the column on its way out.
   *
   * Anything *drawing* the split wants this one: the sidebar asking whether
   * the arrangement it lists is the window in front of you, a column's own
   * chrome, the drop rules asking which columns a release can land in.
   *
   * Published by the container rather than derived here, because the answer
   * depends on what is mounted and this module cannot see the DOM. It is
   * session-only, like `activeId` — a reload re-renders.
   */
  rendered: readonly string[];
  /**
   * The member that owns document-level gestures: the pane-focus arrows, the
   * workspace digit shortcuts, and anything else that reads as "the thing I
   * am working in". Every grid registers the same global listeners, so without
   * this a keypress fires in all of them. Null when there is no split, or
   * before anything has claimed it — then it is whichever column the URL is
   * about.
   */
  activeId: string | null;
  /**
   * Where the address bar is about to go, set by whatever just sent it there
   * and cleared the moment any route arrives. The route trails the change
   * that made it — a member leaving, a drop that moves the URL — by a render
   * or more, and in between the window draws towards this rather than
   * flashing the arrangement the route still names. Session-only.
   */
  heading: string | null;
}

const NOTHING_RENDERED: readonly string[] = [];

const DEFAULT_STATE: SplitState = {
  group: null,
  rendered: NOTHING_RENDERED,
  activeId: null,
  heading: null,
};

/** Whether `workspaceId` is one of the group's columns. */
export function isMember(group: SplitGroup | null, workspaceId: string | null): boolean {
  return Boolean(group && workspaceId && group.members.includes(workspaceId));
}

/**
 * The group a given route draws, or null when that route draws one workspace.
 *
 * The single rule the whole feature turns on: a split is on screen when the
 * URL names one of its members, and the arrangement is the group's own, not
 * the URL's. Opening a workspace outside it therefore parks the split rather
 * than consuming a column of it.
 */
export function splitFor(group: SplitGroup | null, routedId: string | null): SplitGroup | null {
  return isMember(group, routedId) ? group : null;
}

/**
 * What the two-workspace shape wrote: a left and a right, and the left one's
 * share of the window. It loads as the same split — same order, same seam —
 * with the share held to the bounds it always had.
 */
function legacyPair(primaryId: unknown, secondaryId: unknown, ratio: unknown): SplitGroup | null {
  const share =
    typeof ratio === "number" && Number.isFinite(ratio)
      ? Math.min(0.75, Math.max(0.25, ratio))
      : 0.5;
  return toGroup([primaryId, secondaryId], [share, 1 - share]);
}

/** Coerce anything that came out of storage into a usable split. */
export function normalizeSplit(value: unknown): SplitState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_STATE };
  }
  const raw = value as Record<string, unknown>;
  return {
    // The current shape names its members outright. Anything else is read as
    // the pair this used to be — two named halves and a ratio — and a value
    // written by the shape before that, which carried only the second
    // workspace, names no arrangement on its own: it normalises to no split,
    // and the next one the user builds overwrites it.
    group:
      "members" in raw
        ? toGroup(raw.members, raw.sizes)
        : legacyPair(raw.primaryId, raw.secondaryId, raw.ratio),
    // Never restored: whether a column is on screen is a fact about what is
    // mounted, and nothing is mounted at the moment storage is read.
    rendered: NOTHING_RENDERED,
    // Never restored: which column you were last typing in is a fact about a
    // session, and a reload starts at whichever column the URL names.
    activeId: null,
    heading: null,
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
/**
 * Where each workspace that has left the group handed its column, for the
 * length of the session. Two things notice a workspace going — the list
 * refresh that reconciles the group, and the 404 its own column gets — in
 * either order, and both have to send the address bar to the same place.
 */
const departed = new Map<string, string>();

function emit(): void {
  for (const listener of listeners) listener();
}

function ensureInitialised(): void {
  if (initialised || typeof window === "undefined") return;
  initialised = true;
  state = readStoredSplit();
}

/**
 * The value a group is stored as. Its members and widths, and beside them the
 * pair the two-workspace shape wrote — its first two columns, and the first
 * one's share of those two — for the builds that only know that shape: a
 * rollback, or a tab still open on the previous deploy, reads this through
 * master's reader and finds a split rather than nothing. This build reads
 * `members` first, so the pair beside it is never what it acts on.
 */
export function storedSplit(group: SplitGroup): Record<string, unknown> {
  const [primaryId, secondaryId] = group.members;
  const [first = 0.5, second = 0.5] = group.sizes;
  return {
    members: group.members,
    sizes: group.sizes,
    primaryId,
    secondaryId,
    ratio: first + second > 0 ? first / (first + second) : 0.5,
  };
}

/** Write the persistable part of the state; what is drawn and active is session-only. */
function persist(): void {
  try {
    if (state.group) {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(storedSplit(state.group)));
    } else {
      // No split is nothing to remember, not an empty one to restore.
      window.localStorage.removeItem(SPLIT_STORAGE_KEY);
    }
  } catch {
    // Storage refused; the arrangement still holds for this session.
  }
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((item, index) => item === b[index]));
}

function sameGroup(a: SplitGroup | null, b: SplitGroup | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return sameList(a.members, b.members) && sameList(a.sizes, b.sizes);
}

function set(next: SplitState): void {
  if (
    sameGroup(next.group, state.group) &&
    sameList(next.rendered, state.rendered) &&
    next.activeId === state.activeId &&
    next.heading === state.heading
  ) {
    return;
  }
  const persistable = !sameGroup(next.group, state.group);
  state = next;
  if (persistable) persist();
  emit();
}

/**
 * The column that takes over from `workspaceId` when the members in `gone`
 * leave: the nearest one still standing to its right, or to its left at the
 * end of the row — the neighbour that slides into its slot. Null when none
 * is left.
 */
function successorOf(
  members: readonly string[],
  workspaceId: string,
  gone: ReadonlySet<string>,
): string | null {
  const at = members.indexOf(workspaceId);
  if (at < 0) return null;
  const after = members.slice(at + 1).find((id) => !gone.has(id));
  const before = members
    .slice(0, at)
    .reverse()
    .find((id) => !gone.has(id));
  return after ?? before ?? null;
}

/** The group minus one member, or null once that leaves a single workspace. */
function without(group: SplitGroup, workspaceId: string): SplitGroup | null {
  const rest = removeColumn(group, workspaceId);
  return rest.members.length >= MIN_MEMBERS ? rest : null;
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
   * Arrange these workspaces side by side, left to right, at these widths.
   * Refuses anything that is not an arrangement — fewer than two, more than
   * four, a workspace beside itself — rather than leaving every caller to
   * check.
   *
   * Without widths, rearranging the same number of columns keeps the seams
   * where they are: the window's shape is the user's, and only its contents
   * were asked to change. A different number of columns starts even.
   */
  arrange(members: readonly string[], sizes?: readonly number[]): void {
    ensureInitialised();
    const keep =
      sizes ?? (state.group?.members.length === members.length ? state.group.sizes : undefined);
    const group = toGroup([...members], keep);
    if (!group) return;
    set({ ...state, group, activeId: isMember(group, state.activeId) ? state.activeId : null });
  },

  /** No split at all, whichever workspace the window ends up showing. */
  clear(): void {
    ensureInitialised();
    departed.clear();
    set({ ...state, group: null, activeId: null, heading: null });
  },

  /**
   * One workspace steps out and the rest stay split — "remove from split",
   * wherever it is offered from. Two leave one, and one is not a split, so a
   * pair dissolves exactly as it always did.
   *
   * Returns the workspace the caller now has to navigate to, or null when the
   * route already lands somewhere sensible. Only a route onto the workspace
   * leaving has to move, and it moves to the column that takes its place — the
   * neighbour to its right, or to its left at the end of the row — so the
   * address bar stays on something the window is still showing. Navigation
   * stays with the caller; this module owns no router.
   */
  remove(workspaceId: string, routedId: string | null): string | null {
    ensureInitialised();
    const routed = routedId === workspaceId;
    const group = state.group;
    if (!group || !isMember(group, workspaceId)) {
      // Already gone — a list refresh reconciled it first. Where it went is
      // still where a route onto it has to go.
      return routed ? (departed.get(workspaceId) ?? null) : null;
    }
    const successor = successorOf(group.members, workspaceId, new Set([workspaceId]));
    if (successor) departed.set(workspaceId, successor);
    const next = without(group, workspaceId);
    const activeId = !next ? null : state.activeId === workspaceId ? successor : state.activeId;
    set({ ...state, group: next, activeId, heading: routed ? successor : state.heading });
    return routed ? successor : null;
  },

  /**
   * End the split, keeping `keepId` — the "keep only this one" gesture,
   * wherever it is offered from. Returns the workspace the caller now has to
   * navigate to, or null when the route already lands somewhere sensible:
   * either it is already on the column being kept, or it was never on this
   * split at all and nothing about the current page changed.
   */
  unsplit(keepId: string, routedId: string | null): string | null {
    ensureInitialised();
    const onSplit = isMember(state.group, routedId);
    const destination = onSplit && routedId !== keepId ? keepId : null;
    set({ ...state, group: null, activeId: null, heading: destination ?? state.heading });
    return destination;
  },

  /**
   * Report which workspaces are actually mounted as columns, left to right,
   * or nothing when the window is showing one. The container is the only
   * caller: it holds a closing column mounted through its collapse, so this
   * keeps naming it for the length of a close and the surfaces reading it do
   * not reflow while the geometry is still moving.
   */
  setRendered(workspaceIds: readonly string[]): void {
    ensureInitialised();
    const rendered = workspaceIds.length > 1 ? [...workspaceIds] : NOTHING_RENDERED;
    if (sameList(rendered, state.rendered)) return;
    set({ ...state, rendered });
  },

  /**
   * New column widths, left to right. Normalised and held off the floor, so a
   * caller may pass raw arithmetic; ignored when there is no split.
   */
  setSizes(sizes: readonly number[]): void {
    ensureInitialised();
    const group = state.group;
    if (!group) return;
    set({ ...state, group: { ...group, sizes: normalizeSizes(sizes, group.members.length) } });
  },

  /** Which member owns the global gestures now. No-op for anything else. */
  setActive(workspaceId: string): void {
    ensureInitialised();
    if (!isMember(state.group, workspaceId)) return;
    set({ ...state, activeId: workspaceId });
  },

  /**
   * Hand the gestures to the column the URL is about. Called when the route
   * changes rather than on every render: within a split the active column is
   * the user's own — clicking into another pane moves it, and nothing should
   * move it back until they go somewhere.
   */
  followRoute(routedId: string | null): void {
    ensureInitialised();
    set({
      ...state,
      activeId: isMember(state.group, routedId) ? routedId : null,
      heading: null,
    });
  },

  /**
   * Say the address bar is on its way to `workspaceId`, for whoever sends it
   * there without going through `remove` — a drop that has to take the route
   * with it. Cleared by the route arriving (`followRoute`).
   */
  setHeading(workspaceId: string): void {
    ensureInitialised();
    set({ ...state, heading: workspaceId });
  },

  /**
   * Reconcile the group against the workspaces that actually exist. Called by
   * the split container on every workspace list change, and it is what makes
   * an archive or a delete take its column of the arrangement with it.
   *
   * Only the missing members go. The others stay split if there are still two
   * of them: a group of four that loses one to an archive on another device is
   * still the three-column window its owner built, and dismantling it would be
   * a second loss nobody asked for. A pair that loses one is one workspace,
   * which is no split — the same outcome a pair has always had.
   *
   * `knownIds` null means "the list has not loaded yet" — the group is left
   * alone rather than being cleared against an empty list, which would drop
   * the arrangement on every cold load.
   *
   * Returns where the address bar has to go when `routedId` was one of the
   * members that went — the column that took its place — or null when the
   * route can stay. This can arrive before the 404 the routed column gets for
   * itself, or after it; `remove` answers that 404 with the same destination.
   */
  reconcile(knownIds: ReadonlySet<string> | null, routedId: string | null = null): string | null {
    ensureInitialised();
    const group = state.group;
    if (!group || !knownIds) return null;
    const missing = group.members.filter((id) => !knownIds.has(id));
    if (missing.length === 0) return null;
    const gone = new Set(missing);
    for (const id of missing) {
      const successor = successorOf(group.members, id, gone);
      if (successor) departed.set(id, successor);
    }
    let next: SplitGroup | null = group;
    for (const id of missing) next = next ? without(next, id) : null;
    // The address bar was on one that went: it goes to the column that took
    // its place, and the window draws that while the route catches up.
    const destination = routedId && gone.has(routedId) ? (departed.get(routedId) ?? null) : null;
    set({
      ...state,
      group: next,
      activeId: isMember(next, state.activeId) ? state.activeId : null,
      heading: destination ?? state.heading,
    });
    return destination;
  },
};

/** The split arrangement, reactively. */
export function useSplit(): SplitState {
  return useSyncExternalStore(splitStore.subscribe, splitStore.get, () => DEFAULT_STATE);
}

/**
 * Whether more than one workspace is on screen right now — the drawn fact, not
 * the stored one. A parked group, held for the next time one of its members is
 * opened, reads false here.
 */
export function useIsSplit(): boolean {
  return useSplit().rendered.length > 1;
}
