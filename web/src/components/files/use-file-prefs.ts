"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type ColumnWidths, parseColumnWidths } from "@/lib/files/columns";
import { parseSortSpec, type SortSpec } from "@/lib/files/sort";

/**
 * The file browser's device-local preferences: how it sorts, whether hidden
 * files show, the Details columns' widths, which view each layout opens in,
 * and whether the details pane is open. Not one of them is a path — host
 * paths are protected content and never go into browser storage (TRUST.md);
 * these are how this device likes to look at any folder.
 *
 * "Show hidden files" shares the folder picker's key, so the one switch means
 * the same thing in both, as Finder's ⇧⌘. does in its open dialogs.
 */

export type FileBrowserView = "details" | "tree";

const SORT_KEY = "spawn.files.sort";
const COLUMNS_KEY = "spawn.files.columns";
const DETAILS_PANE_KEY = "spawn.files.detailsPane";
const HIDDEN_KEY = "spawn.folderPicker.showHidden";
const viewKey = (layout: string) => `spawn.files.view.${layout}`;

const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: the choice holds for this page and is lost on reload.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changing the same preference.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function useStored(key: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function useFilePrefs(layout: "page" | "pane" | "aside") {
  const sortRaw = useStored(SORT_KEY);
  const columnsRaw = useStored(COLUMNS_KEY);
  const hiddenRaw = useStored(HIDDEN_KEY);
  const viewRaw = useStored(viewKey(layout));
  const detailsRaw = useStored(DETAILS_PANE_KEY);

  const sort = useMemo(() => parseSortSpec(parseJson(sortRaw)), [sortRaw]);
  const columns = useMemo(() => parseColumnWidths(parseJson(columnsRaw)), [columnsRaw]);
  const defaultView: FileBrowserView = layout === "page" ? "details" : "tree";
  const view: FileBrowserView =
    layout === "aside"
      ? "tree"
      : viewRaw === "details" || viewRaw === "tree"
        ? viewRaw
        : defaultView;

  return {
    sort,
    setSort: useCallback((next: SortSpec) => write(SORT_KEY, JSON.stringify(next)), []),
    showHidden: hiddenRaw === "true",
    setShowHidden: useCallback((next: boolean) => write(HIDDEN_KEY, String(next)), []),
    columns,
    setColumns: useCallback((next: ColumnWidths) => write(COLUMNS_KEY, JSON.stringify(next)), []),
    view,
    setView: useCallback((next: FileBrowserView) => write(viewKey(layout), next), [layout]),
    detailsPane: detailsRaw === "true",
    setDetailsPane: useCallback((next: boolean) => write(DETAILS_PANE_KEY, String(next)), []),
  };
}
