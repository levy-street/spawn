import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect } from "react";
import { create } from "zustand";

import {
  DEFAULT_FILE_SORT,
  type FileSort,
  isFileSortDirection,
  isFileSortKey,
} from "@/components/files/sort";

/**
 * How this device likes its folders shown: the order, whether folders sit on
 * top, and whether hidden files show. Per device, like the web file
 * browser's, and never a path — host paths are protected content and stay
 * out of device storage (docs/TRUST.md).
 */
export const FILE_VIEW_OPTIONS_KEY = "spawn.files.view";

/**
 * "Show hidden files" is one switch on a device: the launcher's folder picker
 * keeps it under this key, and the file browser shares it, as the web's two
 * do and as Finder's ⇧⌘. does in its open dialogs.
 */
export const SHOW_HIDDEN_KEY = "spawn.folderPicker.showHidden";

export interface FileViewOptions {
  sort: FileSort;
  foldersFirst: boolean;
  showHidden: boolean;
}

type ViewOption = keyof FileViewOptions;

export const DEFAULT_FILE_VIEW_OPTIONS: Readonly<FileViewOptions> = Object.freeze({
  sort: DEFAULT_FILE_SORT,
  foldersFirst: true,
  showHidden: false,
});

function defaults(): FileViewOptions {
  return { ...DEFAULT_FILE_VIEW_OPTIONS, sort: { ...DEFAULT_FILE_SORT } };
}

/** The order and folders-on-top, read back tolerantly: anything unreadable is the default. */
export function parseFileViewOptions(
  encoded: string | null,
): Pick<FileViewOptions, "sort" | "foldersFirst"> {
  const fallback = defaults();
  const result = { sort: fallback.sort, foldersFirst: fallback.foldersFirst };
  if (encoded === null) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    return result;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result;
  const stored = parsed as { sort?: unknown; foldersFirst?: unknown };
  const sort =
    typeof stored.sort === "object" && stored.sort !== null
      ? (stored.sort as { key?: unknown; direction?: unknown })
      : {};
  return {
    sort:
      isFileSortKey(sort.key) && isFileSortDirection(sort.direction)
        ? { key: sort.key, direction: sort.direction }
        : fallback.sort,
    foldersFirst:
      typeof stored.foldersFirst === "boolean" ? stored.foldersFirst : fallback.foldersFirst,
  };
}

export function parseShowHidden(encoded: string | null): boolean {
  return encoded === "true";
}

export interface FileViewOptionsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface ExplorerPrefsState extends FileViewOptions {
  hydrated: boolean;
  hydrate(storage?: FileViewOptionsStorage): Promise<void>;
  setSort(sort: FileSort, storage?: FileViewOptionsStorage): void;
  setFoldersFirst(foldersFirst: boolean, storage?: FileViewOptionsStorage): void;
  setShowHidden(showHidden: boolean, storage?: FileViewOptionsStorage): void;
}

let hydrating: Promise<void> | null = null;
/** Options chosen before the stored ones arrived: the newer choice, so hydration leaves them. */
const chosenEarly = new Set<ViewOption>();

function persistView(state: FileViewOptions, storage: FileViewOptionsStorage): void {
  const encoded = JSON.stringify({ sort: state.sort, foldersFirst: state.foldersFirst });
  void storage.setItem(FILE_VIEW_OPTIONS_KEY, encoded).catch(() => undefined);
}

/**
 * One copy for every folder on screen and the folder picker. Each folder is
 * its own pushed screen, so a change made in one has to be the order the one
 * underneath shows when you go back to it.
 */
export const useExplorerPrefs = create<ExplorerPrefsState>((set, get) => {
  const choose = (option: ViewOption) => {
    if (!get().hydrated) chosenEarly.add(option);
  };
  return {
    ...defaults(),
    hydrated: false,
    hydrate: (storage = AsyncStorage) => {
      if (get().hydrated) return Promise.resolve();
      hydrating ??= Promise.all([
        storage.getItem(FILE_VIEW_OPTIONS_KEY).catch(() => null),
        storage.getItem(SHOW_HIDDEN_KEY).catch(() => null),
      ])
        .then(([view, hidden]) => {
          if (get().hydrated) return;
          const stored: FileViewOptions = {
            ...parseFileViewOptions(view),
            showHidden: parseShowHidden(hidden),
          };
          const next: Partial<FileViewOptions> = {};
          if (!chosenEarly.has("sort")) next.sort = stored.sort;
          if (!chosenEarly.has("foldersFirst")) next.foldersFirst = stored.foldersFirst;
          if (!chosenEarly.has("showHidden")) next.showHidden = stored.showHidden;
          set({ ...next, hydrated: true });
        })
        .finally(() => {
          hydrating = null;
          chosenEarly.clear();
        });
      return hydrating;
    },
    setSort: (sort, storage = AsyncStorage) => {
      choose("sort");
      set({ sort });
      persistView(get(), storage);
    },
    setFoldersFirst: (foldersFirst, storage = AsyncStorage) => {
      choose("foldersFirst");
      set({ foldersFirst });
      persistView(get(), storage);
    },
    setShowHidden: (showHidden, storage = AsyncStorage) => {
      choose("showHidden");
      set({ showHidden });
      void storage.setItem(SHOW_HIDDEN_KEY, String(showHidden)).catch(() => undefined);
    },
  };
});

/** The view options, read from the device the first time any folder asks. */
export function useFileViewOptions(): ExplorerPrefsState {
  const prefs = useExplorerPrefs();
  const { hydrated, hydrate } = prefs;
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrate, hydrated]);
  return prefs;
}

/** Tests only: forget what was read, as a fresh launch would. */
export function resetExplorerPrefs(): void {
  hydrating = null;
  chosenEarly.clear();
  useExplorerPrefs.setState({ ...defaults(), hydrated: false });
}
