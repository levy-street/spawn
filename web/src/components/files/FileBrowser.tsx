"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  ChevronsDownUp,
  Copy,
  CornerUpLeft,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  List,
  ListTree,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  type DragEvent,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DetailsPane } from "@/components/files/DetailsPane";
import { DETAILS_HEADER_HEIGHT, DetailsHeader, DetailsRow } from "@/components/files/DetailsView";
import { FileList, type FileListHandle } from "@/components/files/file-list";
import { InlineNameInput } from "@/components/files/file-name";
import { FilePreviewCard } from "@/components/files/file-preview-card";
import { FileViewerDialog } from "@/components/files/file-viewer-dialog";
import { PathBar, type PathBarHandle } from "@/components/files/PathBar";
import { type PreviewPlacement, previewPlacement } from "@/components/files/preview-placement";
import { TREE_INDENT_PX, TreeEntryRow, TreeStatusRow } from "@/components/files/TreeView";
import { isFinalListError, useDirectoryListings } from "@/components/files/use-directory-listings";
import { type FileBrowserView, useFilePrefs } from "@/components/files/use-file-prefs";
import { useOpenHostFolder } from "@/components/files/use-open-host-folder";
import { useDaemonConnections } from "@/components/hosts/DaemonConnectionsProvider";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useHoverIntent } from "@/components/ui/hover-intent";
import {
  type MenuPlacement,
  measureMenu,
  placeMenu,
  pointAnchor,
} from "@/components/ui/menu-position";
import { useDismissOnModalOpen } from "@/components/ui/modal-layer";
import { Popover } from "@/components/ui/popover";
import { useDesktopShell } from "@/hooks/useDesktopShell";
import { useHostControl } from "@/hooks/useHostControl";
import { ApiError, hosts } from "@/lib/api";
import {
  COLUMNS,
  type ColumnKey,
  columnTemplate,
  minimumTableWidth,
  resizeColumn,
} from "@/lib/files/columns";
import {
  changedOnHostNotice,
  changeErrorCopy,
  DELETE_PERMANENTLY_LABEL,
  deleteConfirmCopy,
  deletedNotice,
  deletingNotice,
  EMPTY_FOLDER,
  FILTER_PLACEHOLDER,
  FOLDERS_ON_TOP_LABEL,
  HIDE_HIDDEN_LABEL,
  listErrorCopy,
  NEW_FILE_LABEL,
  NEW_FOLDER_LABEL,
  noFilterMatches,
  onlyHiddenFiles,
  POLLED_REFRESH_NOTE,
  partialDeleteNotice,
  SHOW_HIDDEN_LABEL,
  SORT_ORDER_LABELS,
  statusSummary,
  TRUNCATED_ROW_LABEL,
  truncationNotice,
  UNNAMED_HOST,
  UPLOAD_FILES_LABEL,
} from "@/lib/files/copy";
import { filterEntries } from "@/lib/files/filter";
import { formatSize } from "@/lib/files/format";
import {
  canGoBack,
  canGoForward,
  currentPath,
  goBack,
  goForward,
  type NavHistory,
  pushHistory,
  resolveGoToFolder,
  startHistory,
} from "@/lib/files/navigation";
import {
  EMPTY_SELECTION,
  type FocusTarget,
  moveFocus,
  reconcileSelection,
  renameKey,
  type SelectionState,
  selectAll,
  selectedInOrder,
  selectKeys,
  selectOnly,
  selectRange,
  toggleFocused,
  toggleKey,
} from "@/lib/files/selection";
import { FIRST_ORDER, SORT_KEYS, type SortOrder, sortEntries, toggleSort } from "@/lib/files/sort";
import { flattenTree, outermostItems, type TreeRow } from "@/lib/files/tree";
import { pushTypeAhead, type TypeAheadState, typeAheadMatch } from "@/lib/files/type-ahead";
import { HostControlClient, HostControlError, type HostDirEntry } from "@/lib/hostControl";
import {
  detectAppleModifiers,
  type ExplorerShortcut,
  explorerShortcut,
  keystrokeBelongsToText,
} from "@/lib/keyboard-chords";
import {
  isPathWithin,
  joinPath,
  normalizeAbsolutePath,
  type PathFlavor,
  parentDir,
  basename as pathBasename,
  pathFlavorForHostOS,
  pathsEqual,
  trimTrailingSlash,
} from "@/lib/paths";
import { deriveFileCapabilities } from "@/lib/preview/capabilities";
import { classifyFile } from "@/lib/preview/file-kinds";
import { previewCache } from "@/lib/preview/preview-cache";
import { SIGNED_RTC_REFUSAL_DETAIL } from "@/lib/signed-rtc-trust";
import { cn } from "@/lib/utils";

/**
 * SPAWN D's file browser: one component, three layouts.
 *
 * - `page` — a host's Files: a toolbar (Back, Forward, Up, the path bar,
 *   the filter, the view switch, New, view options, the details pane), the
 *   Details view by default, and a status bar.
 * - `pane` — a workspace's file explorer window: the dense tree by default,
 *   no toolbar of its own (the pane's header carries its actions), the rest
 *   on the background's context menu.
 * - `aside` — a session's files: the dense tree only.
 *
 * Every listing comes through `useDirectoryListings` (a v1 host is drained
 * and then polled one page at a time); every order, filter and selection
 * through the pure modules in `lib/files/`; every key through
 * `explorerShortcut`. Actions are offered only when the host's hello
 * advertises the operation, never because of the platform it runs on.
 */

export type FileBrowserLayout = "page" | "pane" | "aside";

/** Imperative surface for hosts that carry the browser's actions in their own header. */
export type FileBrowserHandle = {
  newFolder: () => void;
  newFile: () => void;
  upload: () => void;
  refresh: () => void;
  collapseAll: () => void;
  toggleHidden: () => void;
  focusFilter: () => void;
};

export interface FileBrowserProps {
  hostId: string;
  layout: FileBrowserLayout;
  /** The folder a pane or aside is rooted at; on the page, where it opens. Defaults to home. */
  rootPath?: string;
  /** What the top crumb says for a pane's root. */
  rootLabel?: string;
  /** A deep link: a folder opens there, a file opens its folder with it selected. */
  initialPath?: string;
  className?: string;
  /**
   * The folder on screen, whenever it changes (page layout only). The page
   * keeps it with the tab, never in the URL: a host path is protected content.
   */
  onPathChange?: (path: string) => void;
}

/** sha256 of nothing: a new, empty file. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Open folders a tree may hold at once — each is a listing kept fresh. */
const MAX_EXPANDED_FOLDERS = 32;

type EntryFlatRow = Extract<TreeRow, { kind: "entry" }>;
type FlatRow =
  | TreeRow
  | { kind: "create"; dir: string; depth: number; creating: "folder" | "file" };

interface MenuState {
  x: number;
  y: number;
  /** Null for the folder's own ground; otherwise the rows it acts on. */
  targets: EntryFlatRow[] | null;
  dir: string;
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | null {
  return err instanceof HostControlError ? err.code : null;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** The child of `parent` on the way down to `descendant`. */
function childToward(parent: string, descendant: string, flavor: PathFlavor): string {
  const next = trimTrailingSlash(normalizeAbsolutePath(descendant, flavor), flavor)
    .slice(trimTrailingSlash(parent, flavor).length)
    .split(flavor === "windows" ? /[\\/]/u : "/")
    .filter(Boolean)[0];
  return next ? normalizeAbsolutePath(joinPath(parent, next, flavor), flavor) : descendant;
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const apply = () => setCoarse(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return coarse;
}

export const FileBrowser = forwardRef<FileBrowserHandle, FileBrowserProps>(function FileBrowser(
  { hostId, layout, rootPath, rootLabel, initialPath, className, onPathChange },
  handleRef,
) {
  const listId = useId();
  const listRef = useRef<FileListHandle>(null);
  const pathBarRef = useRef<PathBarHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadDirRef = useRef<string | null>(null);
  const typeAheadRef = useRef<TypeAheadState | null>(null);

  const daemonConnections = useDaemonConnections();
  const desktopShell = useDesktopShell();
  const coarse = useCoarsePointer();
  const {
    client,
    state: hostControlState,
    capabilities,
    os: hostOs,
    signedRtcRefusal,
    connectionError,
  } = useHostControl(hostId);
  const flavor = pathFlavorForHostOS(hostOs);
  const controlReady = hostControlState === "ready" && client !== null;
  // Gated on what the daemon advertised, never on the platform it reports:
  // an old agent on a Mac must not be offered what it cannot do, and a future
  // Linux agent lights them up with no change here.
  const caps = useMemo(() => deriveFileCapabilities(capabilities, hostOs), [capabilities, hostOs]);
  const can = useMemo(
    () => ({
      mkdir: capabilities.has("fs.mkdir"),
      write: capabilities.has("fs.write.begin"),
      rename: capabilities.has("fs.rename"),
      remove: capabilities.has("fs.remove"),
      read: capabilities.has("fs.read"),
    }),
    [capabilities],
  );

  const hostQ = useQuery({
    queryKey: ["host", hostId],
    queryFn: () => hosts.get(hostId),
    staleTime: 30_000,
  });
  const hostName = hostQ.data?.name ?? UNNAMED_HOST;
  const hostNameRef = useRef(hostName);
  hostNameRef.current = hostName;
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 30_000 });
  const otherHosts = (hostsQ.data ?? []).filter((h) => h.id !== hostId);
  const homeQ = useQuery({
    queryKey: ["host-home", hostId],
    queryFn: () => client!.home(),
    enabled: controlReady,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });
  const homeDir = homeQ.data?.home_dir
    ? trimTrailingSlash(normalizeAbsolutePath(homeQ.data.home_dir, flavor), flavor)
    : null;

  const prefs = useFilePrefs(layout);
  const { sort, showHidden, view, setShowHidden } = prefs;
  const [columns, setColumnsLive] = useState(prefs.columns);
  useEffect(() => setColumnsLive(prefs.columns), [prefs.columns]);

  // ---- Where the browser is -------------------------------------------------
  const root = rootPath ? trimTrailingSlash(normalizeAbsolutePath(rootPath, flavor), flavor) : null;
  const base = root ?? homeDir;
  /** The highest folder a crumb or Up may reach. */
  const ceiling = layout === "page" ? (homeDir ?? base) : base;
  const deepLinkPending = Boolean(initialPath) && layout === "page";
  const [history, setHistory] = useState<NavHistory | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const appliedDeepLink = useRef<string | null>(null);
  const probeFolderRef = useRef<string | null>(null);
  const cwd = history ? currentPath(history) : null;

  // ---- View state -----------------------------------------------------------
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ dir: string; kind: "folder" | "file" } | null>(null);
  /** Why the host refused the name in the open New or Rename field. */
  const [nameError, setNameError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** Kebab, New and View options menus open right now: polling waits for them too. */
  const [openMenus, setOpenMenus] = useState(0);
  const onMenuOpenChange = useCallback(
    (open: boolean) => setOpenMenus((count) => Math.max(0, count + (open ? 1 : -1))),
    [],
  );
  /** A delete is being confirmed or run: another one waits its turn. */
  const deletingRef = useRef(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [listFocused, setListFocused] = useState(false);
  const [pollPaths, setPollPaths] = useState<string[]>([]);
  // Which rows are on screen matters only to the tree's polling, so a scroll
  // across a row boundary must not re-render the whole browser: the range is
  // kept in a ref and the tree recomputes what it polls once scrolling rests.
  const rangeRef = useRef<[number, number]>([0, 0]);
  const [rangeSettled, setRangeSettled] = useState(0);
  const [now, setNow] = useState(() => new Date());

  // A different host or root is a different browser: nothing carries over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on identity changes only
  useEffect(() => {
    setHistory(null);
    setExpanded([]);
    setSelection(EMPTY_SELECTION);
    setFilter("");
    appliedDeepLink.current = null;
  }, [hostId, rootPath]);

  // The page waits for a deep link to say where it opens; everything else
  // opens at its root.
  useEffect(() => {
    if (history !== null || !base || deepLinkPending) return;
    setHistory(startHistory(base));
  }, [base, deepLinkPending, history]);

  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const neededPaths = useMemo(
    () => (cwd ? (view === "tree" ? [cwd, ...expanded] : [cwd]) : []),
    [cwd, expanded, view],
  );

  const paused =
    renaming !== null || creating !== null || menu !== null || openMenus > 0 || dropDir !== null;
  const { folders, fetching, refresh, refreshAll, prefetch } = useDirectoryListings({
    hostId,
    client,
    ready: controlReady,
    paths: neededPaths,
    pollPaths,
    paused,
  });
  const cwdState = cwd ? folders.get(cwd) : undefined;
  const cwdListing = cwdState?.listing;

  // "Today at…" moves with the clock: re-read it whenever the listing moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the listing is the trigger
  useEffect(() => setNow(new Date()), [cwdListing]);

  // ---- Rows -----------------------------------------------------------------
  // The count line's two numbers mean the same on the phone: `shown` is the
  // rows on screen at the folder's own level (after the hidden toggle and the
  // filter), `hidden` the hidden names the filter would otherwise show.
  const { rows, shown, hidden, truncated } = useMemo(() => {
    const none = { rows: [] as FlatRow[], shown: 0, hidden: 0, truncated: false };
    if (!cwd) return none;
    if (view === "details") {
      const entries = cwdListing?.entries ?? [];
      const filtered = filterEntries(entries, { query: filter, showHidden });
      const out: FlatRow[] = sortEntries(filtered.visible, sort).map((entry) => ({
        kind: "entry" as const,
        entry,
        depth: 0,
        parentDir: cwd,
        expanded: false,
      }));
      if (creating && pathsEqual(creating.dir, cwd, flavor)) {
        out.unshift({ kind: "create", dir: cwd, depth: 0, creating: creating.kind });
      }
      return {
        rows: out,
        shown: filtered.visible.length,
        hidden: filtered.hiddenCount,
        truncated: cwdListing?.truncated ?? false,
      };
    }
    const flat = flattenTree({
      root: cwd,
      folder: (path) => folders.get(path),
      expanded: expandedSet,
      sort,
      query: filter,
      showHidden,
    });
    // The root's own loading, failure and truncation are said around the
    // list, not as rows in it.
    const out: FlatRow[] = flat.rows.filter((row) => !(row.kind === "status" && row.dir === cwd));
    if (creating) {
      if (pathsEqual(creating.dir, cwd, flavor)) {
        out.unshift({ kind: "create", dir: cwd, depth: 0, creating: creating.kind });
      } else {
        const at = out.findIndex(
          (row) => row.kind === "entry" && pathsEqual(row.entry.path, creating.dir, flavor),
        );
        const parent = out[at];
        if (parent && parent.kind === "entry") {
          out.splice(at + 1, 0, {
            kind: "create",
            dir: creating.dir,
            depth: parent.depth + 1,
            creating: creating.kind,
          });
        }
      }
    }
    return {
      rows: out,
      shown: flat.rootShown,
      hidden: flat.rootHidden,
      truncated: cwdListing?.truncated ?? false,
    };
  }, [creating, cwd, cwdListing, expandedSet, filter, flavor, folders, showHidden, sort, view]);

  const entryRowList = useMemo(
    () => rows.filter((row): row is EntryFlatRow => row.kind === "entry"),
    [rows],
  );
  const order = useMemo(() => entryRowList.map((row) => row.entry.path), [entryRowList]);
  const rowByKey = useMemo(
    () => new Map(entryRowList.map((row) => [row.entry.path, row])),
    [entryRowList],
  );
  const rowIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.kind === "entry") map.set(row.entry.path, index);
    });
    return map;
  }, [rows]);

  // Rows that are gone leave the selection — once the folder has answered.
  useEffect(() => {
    if (!cwdListing) return;
    setSelection((current) => reconcileSelection(order, current));
  }, [cwdListing, order]);

  // A row asked for before it was listed (a deep link, a new folder) is
  // selected the moment it shows up.
  useEffect(() => {
    if (!pendingSelect) return;
    if (rowIndexByKey.has(pendingSelect)) {
      setSelection(selectOnly(pendingSelect));
      setPendingSelect(null);
    }
  }, [pendingSelect, rowIndexByKey]);

  // The focused row stays on screen as the keyboard moves it.
  const revealRef = useRef<(key: string) => void>(() => {});
  revealRef.current = (key: string) => {
    const index = rowIndexByKey.get(key);
    if (index !== undefined) listRef.current?.reveal(index);
  };
  useEffect(() => {
    if (selection.focus) revealRef.current(selection.focus);
  }, [selection.focus]);

  // A name field (New folder, New file, Rename) opens in view wherever the
  // list was scrolled, and stays rendered while it is open (`pinned` below),
  // so what is being typed never scrolls out of the page. A field whose row
  // has gone (the item vanished on a refresh) closes rather than leave the
  // browser waiting on an input no one can reach.
  const createIndex = useMemo(() => rows.findIndex((row) => row.kind === "create"), [rows]);
  const renameIndex = renaming !== null ? (rowIndexByKey.get(renaming) ?? -1) : -1;
  const editIndex = createIndex >= 0 ? createIndex : renameIndex;
  const editIndexRef = useRef(editIndex);
  editIndexRef.current = editIndex;
  useEffect(() => {
    if (creating === null && renaming === null) return;
    const index = editIndexRef.current;
    if (index >= 0) listRef.current?.reveal(index);
  }, [creating, renaming]);
  useEffect(() => {
    if (creating !== null && createIndex < 0) setCreating(null);
  }, [createIndex, creating]);
  useEffect(() => {
    if (renaming !== null && renameIndex < 0) setRenaming(null);
  }, [renameIndex, renaming]);

  // Polling covers what is on screen: the folder in Details, and in the tree
  // the open folders whose rows are visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rangeSettled says when rangeRef moved
  useEffect(() => {
    if (!cwd) return;
    let next: string[];
    if (view === "details") next = [cwd];
    else {
      const dirs = new Set<string>([cwd]);
      const [first, last] = rangeRef.current;
      for (let index = first; index < last; index += 1) {
        const row = rows[index];
        if (!row) continue;
        if (row.kind === "entry") {
          dirs.add(row.parentDir);
          if (row.expanded) dirs.add(row.entry.path);
        } else dirs.add(row.dir);
      }
      next = neededPaths.filter((path) => dirs.has(path));
    }
    setPollPaths((current) => (current.join("\0") === next.join("\0") ? current : next));
  }, [cwd, neededPaths, rangeSettled, rows, view]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const rangeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onRangeChange = useCallback((start: number, end: number) => {
    rangeRef.current = [start, end];
    if (viewRef.current !== "tree") return;
    clearTimeout(rangeTimer.current);
    rangeTimer.current = setTimeout(() => setRangeSettled((tick) => tick + 1), 250);
  }, []);
  useEffect(() => () => clearTimeout(rangeTimer.current), []);

  // ---- Deep link --------------------------------------------------------------
  useEffect(() => {
    if (!initialPath || appliedDeepLink.current === initialPath) return;
    if (!controlReady || !client || !homeDir) return;
    appliedDeepLink.current = initialPath;
    const target = trimTrailingSlash(normalizeAbsolutePath(initialPath, flavor), flavor);
    if (layout !== "page") {
      // A tree rooted elsewhere opens every folder down to the target.
      const top = base ?? homeDir;
      if (!isPathWithin(target, top, flavor) || pathsEqual(target, top, flavor)) return;
      const rest = target
        .slice(top.length)
        .split(flavor === "windows" ? /[\\/]/u : "/")
        .filter(Boolean);
      const ancestors: string[] = [];
      let acc = top;
      for (const part of rest.slice(0, -1)) {
        acc = normalizeAbsolutePath(joinPath(acc, part, flavor), flavor);
        ancestors.push(acc);
      }
      setExpanded((current) =>
        [...new Set([...current, ...ancestors])].slice(0, MAX_EXPANDED_FOLDERS),
      );
      setPendingSelect(target);
      return;
    }
    if (!isPathWithin(target, homeDir, flavor)) {
      setNotice(listErrorCopy("outside_root", hostNameRef.current));
      setHistory(startHistory(homeDir));
      return;
    }
    if (!caps.stat) {
      // Without fs.stat, try it as a folder; a file answers not_directory.
      probeFolderRef.current = target;
      setHistory(startHistory(target));
      return;
    }
    // Only the latest deep link may land; an older answer arriving late is dropped.
    const current = () => appliedDeepLink.current === initialPath;
    client
      .stat(target)
      .then((stat) => {
        if (!current()) return;
        if (stat.kind === "directory") setHistory(startHistory(target));
        else {
          setHistory(startHistory(parentDir(target, flavor)));
          setPendingSelect(target);
        }
      })
      .catch((error) => {
        if (!current()) return;
        setNotice(listErrorCopy(errorCode(error), hostNameRef.current) ?? errorMessage(error));
        setHistory(startHistory(homeDir));
      });
  }, [base, caps.stat, client, controlReady, flavor, homeDir, initialPath, layout]);

  useEffect(() => {
    const probe = probeFolderRef.current;
    if (!probe || !cwd || !pathsEqual(probe, cwd, flavor)) return;
    if (cwdState?.listing) probeFolderRef.current = null;
    else if (errorCode(cwdState?.error) === "not_directory") {
      probeFolderRef.current = null;
      setHistory(startHistory(parentDir(probe, flavor)));
      setPendingSelect(probe);
    }
  }, [cwd, cwdState, flavor]);

  // ---- Navigation -------------------------------------------------------------
  // Every folder the page lands in — a navigation, Back, a deep link that
  // resolved to a file's folder — is reported, so the page can keep it with
  // the tab (never in the URL).
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;
  useEffect(() => {
    if (cwd && layout === "page") onPathChangeRef.current?.(cwd);
  }, [cwd, layout]);

  /** A new folder on screen starts clean, with `select` picked once it shows. */
  const settleAt = useCallback((select: string | null = null) => {
    setSelection(EMPTY_SELECTION);
    setPendingSelect(select);
    setFilter("");
    setExpanded([]);
    setRenaming(null);
    setCreating(null);
    setNameError(null);
    setNotice(null);
    setStatus(null);
  }, []);

  const navigate = useCallback(
    (path: string, select: string | null = null) => {
      if (!history) return;
      const next = pushHistory(history, path, (a, b) => pathsEqual(a, b, flavor));
      if (next === history) return;
      setHistory(next);
      settleAt(select);
    },
    [flavor, history, settleAt],
  );

  const stepHistory = useCallback(
    (direction: "back" | "forward") => {
      if (!history) return;
      const next = direction === "back" ? goBack(history) : goForward(history);
      if (next === history) return;
      const from = currentPath(history);
      const to = currentPath(next);
      setHistory(next);
      // Back out of a folder lands with that folder selected, as in Finder.
      const inside = isPathWithin(from, to, flavor) && !pathsEqual(from, to, flavor);
      settleAt(inside ? childToward(to, from, flavor) : null);
    },
    [flavor, history, settleAt],
  );

  const atCeiling = !cwd || !ceiling || pathsEqual(cwd, ceiling, flavor);
  const goUp = useCallback(() => {
    if (!cwd || atCeiling) return;
    navigate(parentDir(cwd, flavor), cwd);
  }, [atCeiling, cwd, flavor, navigate]);

  const goToFolder = useCallback(
    async (input: string): Promise<string | null> => {
      if (!homeDir || !cwd) return null;
      const resolved = resolveGoToFolder(input, { homeDir, cwd, flavor });
      if (!resolved.ok) {
        return resolved.code === "empty" ? null : listErrorCopy(resolved.code, hostName);
      }
      try {
        await prefetch(resolved.path);
      } catch (error) {
        return listErrorCopy(errorCode(error), hostName) ?? errorMessage(error);
      }
      navigate(resolved.path);
      listRef.current?.element?.focus();
      return null;
    },
    [cwd, flavor, homeDir, hostName, navigate, prefetch],
  );

  const toggleDir = useCallback(
    (path: string) => {
      if (expandedSet.has(path)) {
        setExpanded((current) =>
          current.filter((entryPath) => !isPathWithin(entryPath, path, flavor)),
        );
        return;
      }
      if (expanded.length >= MAX_EXPANDED_FOLDERS) {
        setStatus("Too many folders are open. Close one before opening another.");
        return;
      }
      setExpanded((current) => [...current, path]);
    },
    [expanded.length, expandedSet, flavor],
  );

  const openEntry = useCallback(
    (entry: HostDirEntry) => {
      if (entry.is_dir) {
        if (view === "details") navigate(entry.path);
        else toggleDir(entry.path);
      } else setViewing(entry.path);
    },
    [navigate, toggleDir, view],
  );

  // ---- Hover preview ----------------------------------------------------------
  const [fineHover, setFineHover] = useState(false);
  useEffect(() => {
    // Coarse pointers have no hover to give; the preview would only ever fire
    // on tap, which is what opening the viewer is for.
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const apply = () => setFineHover(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  const hover = useHoverIntent<{ path: string }>({ enabled: fineHover });
  const hoverEntry = useMemo(() => {
    const path = hover.value?.path;
    return path ? (rowByKey.get(path)?.entry ?? null) : null;
  }, [hover.value, rowByKey]);

  // Where the card hangs from, and whether it is lying over the panel to get
  // there — `previewPlacement` owns both, from the row's box and the panel's.
  const [hoverPlacement, setHoverPlacement] = useState<PreviewPlacement | null>(null);
  useLayoutEffect(() => {
    const path = hover.value?.path;
    const container = listRef.current?.element;
    if (!path || !container) {
      setHoverPlacement(null);
      return;
    }
    const row = container.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    if (!row) {
      setHoverPlacement(null);
      return;
    }
    setHoverPlacement(
      previewPlacement(
        row.getBoundingClientRect(),
        container.getBoundingClientRect(),
        window.innerWidth,
      ),
    );
  }, [hover.value]);

  /**
   * The card closes on geometry, never on a countdown: while one is open the
   * live region is the file panel, the card, and a narrow bridge between
   * them, so travelling to the card keeps it up and leaving takes it away.
   */
  useEffect(() => {
    if (hover.value === null || hover.pinned) return;
    const BRIDGE = 20;
    const within = (
      box: DOMRect | { left: number; right: number; top: number; bottom: number },
      x: number,
      y: number,
    ) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    const outside = (x: number, y: number) => {
      const panel = listRef.current?.element?.getBoundingClientRect() ?? null;
      const card = document.getElementById("file-preview-card")?.getBoundingClientRect() ?? null;
      if (!panel && !card) return true;
      if (panel && within(panel, x, y)) return false;
      if (card) {
        const cardOnRight = panel
          ? (card.left + card.right) / 2 >= (panel.left + panel.right) / 2
          : true;
        if (
          within(
            {
              left: card.left - (cardOnRight ? BRIDGE : 0),
              right: card.right + (cardOnRight ? 0 : BRIDGE),
              top: card.top,
              bottom: card.bottom,
            },
            x,
            y,
          )
        ) {
          return false;
        }
      }
      return true;
    };
    const onMove = (event: PointerEvent) => {
      if (outside(event.clientX, event.clientY)) hover.cancel();
    };
    const onWindowOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) hover.cancel();
    };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerout", onWindowOut);
    window.addEventListener("blur", hover.cancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onWindowOut);
      window.removeEventListener("blur", hover.cancel);
    };
  }, [hover.value, hover.pinned, hover.cancel]);

  useEffect(() => {
    if (viewing !== null) hover.cancel();
  }, [viewing, hover.cancel]);

  // A dialog opening (a delete confirm, the viewer) takes the window; a card
  // left floating over it would sit on its buttons.
  useDismissOnModalOpen(hover.value !== null, hover.cancel);

  // Losing the channel closes the card and the viewer and drops every cached
  // preview for this host, so a reconnect cannot show bytes from a session
  // that has ended.
  useEffect(() => {
    if (hostControlState === "ready") return;
    hover.cancel();
    setViewing(null);
    previewCache.clearHost(hostId);
  }, [hostControlState, hostId, hover.cancel]);

  useEffect(() => () => previewCache.clearHost(hostId), [hostId]);

  // ---- Changes ----------------------------------------------------------------
  const failure = useCallback(
    (err: unknown, name: string) =>
      changeErrorCopy(errorCode(err), { host: hostName, name }) ?? errorMessage(err),
    [hostName],
  );

  const targetDir = useCallback((): string | null => {
    if (!cwd) return null;
    if (view === "details") return cwd;
    const focus = selection.focus ? rowByKey.get(selection.focus) : undefined;
    if (!focus) return cwd;
    return focus.entry.is_dir ? focus.entry.path : focus.parentDir;
  }, [cwd, rowByKey, selection.focus, view]);

  const startCreate = useCallback(
    (kind: "folder" | "file") => {
      if (kind === "folder" ? !can.mkdir : !can.write) return;
      const dir = targetDir();
      if (!dir) return;
      if (view === "tree" && cwd && !pathsEqual(dir, cwd, flavor) && !expandedSet.has(dir)) {
        if (expanded.length >= MAX_EXPANDED_FOLDERS) return;
        setExpanded((current) => [...current, dir]);
      }
      setRenaming(null);
      setNameError(null);
      setCreating({ dir, kind });
    },
    [can.mkdir, can.write, cwd, expanded.length, expandedSet, flavor, targetDir, view],
  );

  const createM = useMutation({
    mutationFn: async ({
      dir,
      name,
      kind,
    }: {
      dir: string;
      name: string;
      kind: "folder" | "file";
    }) => {
      if (!client) throw new Error("Host is not connected");
      const path = normalizeAbsolutePath(joinPath(dir, name, flavor), flavor);
      if (kind === "folder") return (await client.mkdir(path)).path ?? path;
      // An empty file is a zero-length write that refuses to replace anything.
      return client.writeStream(emptyStream(), {
        dir,
        name,
        length: 0,
        sha256: EMPTY_SHA256,
        overwrite: false,
      });
    },
    onMutate: () => setNameError(null),
    onSuccess: (path, { dir }) => {
      setCreating(null);
      setStatus(null);
      void refresh(dir);
      setPendingSelect(path);
      // The field is gone; the keyboard goes back to the list it was in.
      listRef.current?.element?.focus();
    },
    // Said in the field where the name was typed, which stays open to fix it.
    onError: (err, { dir, name }) => {
      setNameError(failure(err, name));
      void refresh(dir);
    },
  });

  const startRename = useCallback(
    (key: string) => {
      if (!can.rename || !rowByKey.has(key)) return;
      setCreating(null);
      setMenu(null);
      setNameError(null);
      setRenaming(key);
    },
    [can.rename, rowByKey],
  );

  const renameM = useMutation({
    mutationFn: ({ entry, name }: { entry: HostDirEntry; name: string; parentDir: string }) =>
      client?.rename(entry.path, name) ?? Promise.reject(new Error("Host is not connected")),
    onMutate: () => setNameError(null),
    onSuccess: (result, { entry, parentDir: dir }) => {
      setRenaming(null);
      setStatus(null);
      listRef.current?.element?.focus();
      const to = result.path;
      if (to) {
        setSelection((current) => renameKey(current, entry.path, to));
        setPendingSelect(to);
        if (entry.is_dir) {
          const moved = (path: string) =>
            pathsEqual(path, entry.path, flavor)
              ? to
              : isPathWithin(path, entry.path, flavor)
                ? `${to}${path.slice(entry.path.length)}`
                : path;
          setExpanded((current) => current.map(moved));
        }
      }
      void refresh(dir);
    },
    // Said in the field, which stays open: a name already taken or not
    // allowed is about the new name; anything else is about the item.
    onError: (err, { entry, name, parentDir: dir }) => {
      const code = errorCode(err);
      const about =
        code === "already_exists" || code === "invalid_name" || code === "invalid_path"
          ? name
          : entry.name;
      setNameError(failure(err, about));
      void refresh(dir);
    },
  });

  const deleteEntries = useCallback(
    async (picked: EntryFlatRow[]) => {
      setMenu(null);
      if (!client || picked.length === 0 || !can.remove || deletingRef.current) return;
      // Something inside a folder that is going goes with it: the confirm
      // counts, and the host is asked for, only what is actually removed.
      const targets = outermostItems(
        picked.map((row) => ({ row, path: row.entry.path, isDir: row.entry.is_dir === true })),
        (path, folder) => isPathWithin(path, folder, flavor),
      ).map(({ row }) => row);
      const copy = deleteConfirmCopy(
        targets.map((row) => ({ name: row.entry.name, isDir: row.entry.is_dir === true })),
        hostName,
      );
      deletingRef.current = true;
      const ok = await confirm({
        title: copy.title,
        body: copy.body,
        confirmLabel: copy.confirmLabel,
        destructive: true,
      }).finally(() => {
        deletingRef.current = false;
      });
      if (!ok) return;
      // The confirm has closed; what happens next is said in the status line.
      deletingRef.current = true;
      setStatus(
        deletingNotice(
          targets.map((row) => row.entry.name),
          hostName,
        ),
      );
      const done: EntryFlatRow[] = [];
      const failed: Array<{ row: EntryFlatRow; error: unknown }> = [];
      try {
        for (const row of targets) {
          try {
            await client.remove(row.entry.path, row.entry.is_dir === true);
            done.push(row);
            setExpanded((current) =>
              current.filter((path) => !isPathWithin(path, row.entry.path, flavor)),
            );
          } catch (error) {
            failed.push({ row, error });
          }
        }
      } finally {
        deletingRef.current = false;
      }
      for (const dir of new Set(targets.map((row) => row.parentDir))) void refresh(dir);
      const first = failed[0];
      if (!first) {
        setStatus(
          deletedNotice(
            done.map((row) => row.entry.name),
            hostName,
          ),
        );
      } else {
        const reason = failure(first.error, first.row.entry.name);
        setStatus(
          targets.length === 1
            ? reason
            : partialDeleteNotice(done.length, targets.length, hostName, {
                name: first.row.entry.name,
                reason,
              }),
        );
        // What could not go stays selected, ready for another try.
        setSelection(selectKeys(failed.map(({ row }) => row.entry.path)));
      }
      listRef.current?.element?.focus();
    },
    [can.remove, client, failure, flavor, hostName, refresh],
  );

  const uploadFiles = useCallback(
    async (dir: string, files: globalThis.File[]) => {
      if (files.length === 0) return;
      setStatus(null);
      setUploadingCount((n) => n + files.length);
      for (const file of files) {
        try {
          if (!client) throw new Error("Host control channel is not ready");
          const result = await client.uploadFile(file, { dir });
          setStatus(`Uploaded ${result.path ?? file.name}`);
        } catch (err) {
          setStatus(`${file.name || "File"}: ${errorMessage(err)}`);
        } finally {
          setUploadingCount((n) => n - 1);
        }
      }
      void refresh(dir);
    },
    [client, refresh],
  );

  const transferM = useMutation({
    mutationFn: ({ entry, destHostId }: { entry: HostDirEntry; destHostId: string }) => {
      if (!client) throw new Error("Source host is not connected");
      const sharedConnection = daemonConnections.get(destHostId);
      if (!sharedConnection) throw new Error("Destination host is not connected");
      return (async () => {
        const destination = new HostControlClient(destHostId, { sharedConnection });
        try {
          await destination.waitUntilReady();
          const home = await destination.home();
          return await client.transferFileTo(destination, entry.path, home.home_dir);
        } finally {
          destination.close();
        }
      })();
    },
    onSuccess: (result) => setStatus(`Sent to ${result.path ?? "destination host"}`),
    onError: (err) => setStatus(errorMessage(err)),
  });

  const download = useCallback(
    async (entry: HostDirEntry) => {
      setStatus(`Downloading ${entry.name}...`);
      try {
        if (!client) throw new Error("Host control channel is not ready");
        await client.saveFileToBrowser(entry.path, entry.name);
        setStatus(null);
      } catch (err) {
        setStatus(`${entry.name}: ${errorMessage(err)}`);
      }
    },
    [client],
  );

  const revealM = useMutation({
    mutationFn: (entry: HostDirEntry) => client!.reveal(entry.path),
    onMutate: () => setStatus(null),
    onError: (error) => setStatus(errorMessage(error)),
  });

  const openExternalM = useMutation({
    mutationFn: (entry: HostDirEntry) => client!.openDefault(entry.path),
    onMutate: () => setStatus(null),
    onError: (error) => setStatus(errorMessage(error)),
  });

  const relativePath = useCallback(
    (path: string) => {
      if (!cwd) return path;
      if (pathsEqual(path, cwd, flavor)) return ".";
      if (isPathWithin(path, cwd, flavor)) return path.slice(cwd.length).replace(/^[\\/]/u, "");
      return path;
    },
    [cwd, flavor],
  );

  const copyText = useCallback(async (text: string, label: string) => {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`Copied ${label}`);
    } catch {
      setStatus("Clipboard unavailable");
    }
  }, []);

  const refreshEverything = useCallback(() => {
    setNotice(null);
    void refreshAll();
  }, [refreshAll]);

  const openFilter = useCallback(() => {
    setFilterOpen(true);
    requestAnimationFrame(() => {
      filterRef.current?.focus();
      filterRef.current?.select();
    });
  }, []);

  const pickUpload = useCallback(
    (dir: string | null) => {
      if (!can.write) return;
      uploadDirRef.current = dir;
      fileInputRef.current?.click();
    },
    [can.write],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      newFolder: () => startCreate("folder"),
      newFile: () => startCreate("file"),
      upload: () => pickUpload(targetDir()),
      refresh: refreshEverything,
      collapseAll: () => setExpanded([]),
      toggleHidden: () => setShowHidden(!showHidden),
      focusFilter: openFilter,
    }),
    [openFilter, pickUpload, refreshEverything, setShowHidden, showHidden, startCreate, targetDir],
  );

  // ---- Keyboard ---------------------------------------------------------------
  const selectedRows = useMemo(
    () =>
      selectedInOrder(order, selection)
        .map((key) => rowByKey.get(key))
        .filter((row): row is EntryFlatRow => row !== undefined),
    [order, rowByKey, selection],
  );

  const actionRows = (): EntryFlatRow[] => {
    if (selectedRows.length > 0) return selectedRows;
    const focus = selection.focus ? rowByKey.get(selection.focus) : undefined;
    return focus ? [focus] : [];
  };

  /** Chords that work anywhere in the browser, not only on the list. */
  const runBrowserChord = (action: ExplorerShortcut): boolean => {
    switch (action.kind) {
      case "filter":
        openFilter();
        return true;
      case "toggleHidden":
        prefs.setShowHidden(!showHidden);
        return true;
      case "goToFolder":
        if (layout !== "page") return false;
        pathBarRef.current?.edit();
        return true;
      case "details":
        if (layout !== "page") return false;
        prefs.setDetailsPane(!prefs.detailsPane);
        return true;
      case "back":
      case "forward":
        if (view !== "details" && layout !== "page") return false;
        stepHistory(action.kind);
        return true;
      case "newFolder":
        startCreate("folder");
        return true;
      default:
        return false;
    }
  };

  const runListChord = (action: ExplorerShortcut): boolean => {
    const focusRow = selection.focus ? rowByKey.get(selection.focus) : undefined;
    switch (action.kind) {
      case "move": {
        const page = listRef.current?.pageSize() ?? 10;
        const target: FocusTarget =
          action.to === "pageUp"
            ? { by: -page }
            : action.to === "pageDown"
              ? { by: page }
              : action.to;
        const mode = action.extend ? "extend" : action.keep ? "focus" : "select";
        setSelection((current) => moveFocus(order, current, target, mode));
        return true;
      }
      case "expand":
        if (view !== "tree" || !focusRow?.entry.is_dir) return false;
        if (!focusRow.expanded) toggleDir(focusRow.entry.path);
        else setSelection((current) => moveFocus(order, current, "next", "select"));
        return true;
      case "collapse":
        if (view !== "tree" || !focusRow) return false;
        if (focusRow.entry.is_dir && focusRow.expanded) toggleDir(focusRow.entry.path);
        else if (focusRow.depth > 0) setSelection(selectOnly(focusRow.parentDir));
        return true;
      case "open":
        if (!focusRow) return false;
        openEntry(focusRow.entry);
        return true;
      case "rename":
        if (!focusRow) return false;
        startRename(focusRow.entry.path);
        return true;
      case "up":
        if (view !== "details" && layout !== "page") return false;
        goUp();
        return true;
      case "selectAll":
        setSelection((current) => selectAll(order, current));
        return true;
      case "toggleSelected":
        setSelection((current) => toggleFocused(current));
        return true;
      case "peek":
        // Space peeks, the way it does in Finder: pinned, so it survives the
        // pointer wandering off, and it never waits on the hover delay.
        if (!focusRow || focusRow.entry.is_dir) return false;
        hover.pin({ path: focusRow.entry.path });
        return true;
      case "delete":
        void deleteEntries(actionRows());
        return true;
      case "escape":
        if (hover.value !== null) hover.cancel();
        else if (filter) setFilter("");
        else setSelection(EMPTY_SELECTION);
        return true;
      case "typeAhead": {
        const state = pushTypeAhead(typeAheadRef.current, action.text, Date.now());
        typeAheadRef.current = state;
        const names = entryRowList.map((row) => row.entry.name);
        const from = selection.focus ? order.indexOf(selection.focus) : -1;
        const index = typeAheadMatch(names, state.buffer, from);
        const key = index >= 0 ? order[index] : undefined;
        if (key) setSelection(selectOnly(key));
        return true;
      }
      default:
        return runBrowserChord(action);
    }
  };

  const onBrowserKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (renaming !== null || creating !== null || menu !== null) return;
    const action = explorerShortcut(event, {
      apple: detectAppleModifiers(),
      textHasKey: keystrokeBelongsToText(event.target),
      desktopShell,
    });
    if (!action) return;
    const onList = event.target === listRef.current?.element;
    const handled = onList ? runListChord(action) : runBrowserChord(action);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // ---- Pointer ----------------------------------------------------------------
  const onRowClick = (row: EntryFlatRow, event: ReactMouseEvent) => {
    const key = row.entry.path;
    const apple = detectAppleModifiers();
    const toggle = apple ? event.metaKey : event.ctrlKey;
    if (event.shiftKey) {
      setSelection((current) => selectRange(order, current, key, { additive: toggle }));
      return;
    }
    if (toggle) {
      setSelection((current) => toggleKey(current, key));
      return;
    }
    setSelection(selectOnly(key));
    if (renaming === key || view !== "tree") return;
    // The tree opens on a single click, as VS Code's does.
    if (row.entry.is_dir) toggleDir(key);
    else setViewing(key);
  };

  const onRowDoubleClick = (row: EntryFlatRow) => {
    if (view === "details") openEntry(row.entry);
  };

  const openContextMenu = (event: ReactMouseEvent, row: EntryFlatRow | null) => {
    event.preventDefault();
    event.stopPropagation();
    // A menu opening behind a floating preview reads as a bug.
    hover.cancel();
    if (!row) {
      setMenu({ x: event.clientX, y: event.clientY, targets: null, dir: cwd ?? "" });
      return;
    }
    let targets: EntryFlatRow[];
    if (selection.selected.has(row.entry.path) && selectedRows.length > 1) targets = selectedRows;
    else {
      setSelection(selectOnly(row.entry.path));
      targets = [row];
    }
    setMenu({ x: event.clientX, y: event.clientY, targets, dir: row.parentDir });
  };

  const dropProps = (dir: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!can.write || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDropDir(dir);
    },
    onDragLeave: (event: DragEvent) => {
      event.stopPropagation();
      setDropDir((current) => (current === dir ? null : current));
    },
    onDrop: (event: DragEvent) => {
      if (!can.write || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDropDir(null);
      void uploadFiles(dir, Array.from(event.dataTransfer.files));
    },
  });

  // Close the context menu on an outside press or Escape.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Placed by the shared menu geometry: a menu at the cursor near a viewport
  // edge is exactly where a naively-positioned one runs off the screen.
  const [menuCoords, setMenuCoords] = useState<MenuPlacement | null>(null);
  useLayoutEffect(() => {
    if (!menu) {
      setMenuCoords(null);
      return;
    }
    const place = () => {
      const { width, height } = measureMenu(menuRef.current, 176);
      setMenuCoords(
        placeMenu({
          anchor: pointAnchor(menu.x, menu.y),
          menuWidth: width,
          menuHeight: height,
          align: "start",
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [menu]);

  // ---- Menus ------------------------------------------------------------------
  const entryActions = (row: EntryFlatRow): ReactNode => {
    const { entry } = row;
    return (
      <>
        {entry.is_dir ? (
          <DropdownMenuItem onSelect={() => openEntry(entry)}>
            <FolderOpen className="size-4" aria-hidden />
            Open
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => setViewing(entry.path)}>
            <Eye className="size-4" aria-hidden />
            Open preview
          </DropdownMenuItem>
        )}
        {/* Absent, not disabled, when the host cannot do it: a greyed-out row
            invites a support question that has no good answer. */}
        {caps.reveal && (
          <DropdownMenuItem onSelect={() => revealM.mutate(entry)}>
            <FolderSearch className="size-4" aria-hidden />
            {caps.revealLabel}
          </DropdownMenuItem>
        )}
        {caps.open && !entry.is_dir && !classifyFile(entry).executable && (
          <DropdownMenuItem onSelect={() => openExternalM.mutate(entry)}>
            <ExternalLink className="size-4" aria-hidden />
            {caps.openLabel}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copyText(entry.path, "path")}>
          <Copy className="size-4" aria-hidden />
          Copy path
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyText(relativePath(entry.path), "relative path")}>
          <CornerUpLeft className="size-4" aria-hidden />
          Copy relative path
        </DropdownMenuItem>
        {(can.read || can.rename) && <DropdownMenuSeparator />}
        {!entry.is_dir && can.read && (
          <DropdownMenuItem onSelect={() => void download(entry)}>
            <Download className="size-4" aria-hidden />
            Download
          </DropdownMenuItem>
        )}
        {can.rename && (
          <DropdownMenuItem onSelect={() => startRename(entry.path)}>
            <Pencil className="size-4" aria-hidden />
            Rename
          </DropdownMenuItem>
        )}
        {!entry.is_dir && can.read && otherHosts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Send to host</DropdownMenuLabel>
            {otherHosts.map((other) => (
              <DropdownMenuItem
                key={other.id}
                disabled={other.status !== "online"}
                onSelect={() => transferM.mutate({ entry, destHostId: other.id })}
              >
                <ArrowRightLeft className="size-4" aria-hidden />
                {other.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {can.remove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => void deleteEntries([row])}>
              <Trash2 className="size-4" aria-hidden />
              {DELETE_PERMANENTLY_LABEL}
            </DropdownMenuItem>
          </>
        )}
      </>
    );
  };

  const selectionActions = (targets: EntryFlatRow[]): ReactNode => (
    <>
      <DropdownMenuLabel>{`${targets.length} selected`}</DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={() =>
          void copyText(targets.map((row) => row.entry.path).join("\n"), `${targets.length} paths`)
        }
      >
        <Copy className="size-4" aria-hidden />
        Copy paths
      </DropdownMenuItem>
      {can.remove && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => void deleteEntries(targets)}>
            <Trash2 className="size-4" aria-hidden />
            {DELETE_PERMANENTLY_LABEL}
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  // The folder is handed over in memory, never put in the link: a host path
  // in a URL reaches the server's logs, a prefetch and the browser's history.
  const openHostFolder = useOpenHostFolder();
  const offerFullBrowser = Boolean(cwd) && layout !== "page";

  const backgroundActions = (): ReactNode => (
    <>
      {can.mkdir && (
        <DropdownMenuItem onSelect={() => startCreate("folder")}>
          <FolderPlus className="size-4" aria-hidden />
          {NEW_FOLDER_LABEL}
        </DropdownMenuItem>
      )}
      {can.write && (
        <DropdownMenuItem onSelect={() => startCreate("file")}>
          <FilePlus className="size-4" aria-hidden />
          {NEW_FILE_LABEL}
        </DropdownMenuItem>
      )}
      {can.write && (
        <DropdownMenuItem onSelect={() => pickUpload(targetDir())}>
          <Upload className="size-4" aria-hidden />
          {UPLOAD_FILES_LABEL}
        </DropdownMenuItem>
      )}
      {(can.mkdir || can.write) && <DropdownMenuSeparator />}
      <DropdownMenuItem checked={showHidden} onSelect={() => prefs.setShowHidden(!showHidden)}>
        {SHOW_HIDDEN_LABEL}
      </DropdownMenuItem>
      {layout === "pane" && (
        <>
          <DropdownMenuItem checked={view === "details"} onSelect={() => prefs.setView("details")}>
            View as details
          </DropdownMenuItem>
          <DropdownMenuItem checked={view === "tree"} onSelect={() => prefs.setView("tree")}>
            View as tree
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      {view === "tree" && expanded.length > 0 && (
        <DropdownMenuItem onSelect={() => setExpanded([])}>
          <ChevronsDownUp className="size-4" aria-hidden />
          Collapse all
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={refreshEverything}>
        <RefreshCw className="size-4" aria-hidden />
        Refresh
      </DropdownMenuItem>
      {offerFullBrowser && (
        <DropdownMenuItem onSelect={() => openHostFolder(hostId, cwd)}>
          <ExternalLink className="size-4" aria-hidden />
          Open in full browser
        </DropdownMenuItem>
      )}
    </>
  );

  // ---- Rendering --------------------------------------------------------------
  const dense = layout !== "page";
  const rowHeight = coarse ? 40 : dense ? 24 : 28;
  const template = columnTemplate(columns);
  const minWidth = view === "details" ? minimumTableWidth(columns) : undefined;
  const focusIndex = selection.focus ? rowIndexByKey.get(selection.focus) : undefined;
  const activeId = focusIndex !== undefined ? `${listId}-r${focusIndex}` : undefined;

  const viewableRows = useMemo(
    () => entryRowList.filter((row) => !row.entry.is_dir),
    [entryRowList],
  );
  const viewingIndex =
    viewing === null ? -1 : viewableRows.findIndex((r) => r.entry.path === viewing);
  const viewingEntry = viewingIndex >= 0 ? (viewableRows[viewingIndex]?.entry ?? null) : null;

  const selectedBytes = useMemo(() => {
    const files = selectedRows.filter((row) => !row.entry.is_dir && row.entry.size != null);
    return files.length > 0 ? files.reduce((sum, row) => sum + (row.entry.size ?? 0), 0) : null;
  }, [selectedRows]);

  const rowMenu = (row: EntryFlatRow) => (
    <DropdownMenu
      onOpenChange={onMenuOpenChange}
      className="absolute right-1 top-1/2 -translate-y-1/2"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            // The menu is about to open where the card is sitting.
            hover.cancel();
            props.onClick();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          // The kebab sits on the path to the card: hovering it suppresses a
          // preview that has not opened yet, but never dismisses one already
          // open, or the card could not be reached at all.
          onPointerEnter={() => {
            if (hover.value === null) hover.cancel();
          }}
          aria-label={`${row.entry.name} actions`}
          className="z-10 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/filerow:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
        >
          <MoreHorizontal className="size-3.5" aria-hidden />
        </button>
      )}
    >
      {entryActions(row)}
    </DropdownMenu>
  );

  const renameInput = (row: EntryFlatRow) =>
    renaming === row.entry.path ? (
      <InlineNameInput
        initial={row.entry.name}
        label="Rename entry"
        flavor={flavor}
        pending={renameM.isPending}
        selectStem={!row.entry.is_dir}
        error={nameError}
        onSubmit={(name) => renameM.mutate({ entry: row.entry, name, parentDir: row.parentDir })}
        onCancel={() => {
          setRenaming(null);
          setNameError(null);
          listRef.current?.element?.focus();
        }}
      />
    ) : null;

  const onRowPointerEnter = (row: EntryFlatRow) => {
    // A folder has nothing to preview, and resting on one is the pointer
    // saying it has moved on from the file whose card is up.
    if (row.entry.is_dir) {
      if (!hover.pinned) hover.cancel();
      return;
    }
    if (renaming || menu || dropDir || viewing) return;
    hover.enter({ path: row.entry.path });
  };

  const renderRow = (index: number, top: number): ReactNode => {
    const row = rows[index];
    if (!row) return null;
    const id = `${listId}-r${index}`;
    if (row.kind === "create") {
      return (
        <div
          key={`create:${row.dir}`}
          id={id}
          className="absolute inset-x-0 flex items-center gap-1 pr-2"
          style={{
            top,
            height: rowHeight,
            paddingLeft: view === "tree" ? 6 + row.depth * TREE_INDENT_PX + 18 : 8,
          }}
        >
          {row.creating === "folder" ? (
            <Folder className="size-4 shrink-0 text-info" aria-hidden />
          ) : (
            <File className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <InlineNameInput
            label={row.creating === "folder" ? "Folder name" : "File name"}
            placeholder={row.creating === "folder" ? "folder name" : "file name"}
            flavor={flavor}
            pending={createM.isPending}
            error={nameError}
            onSubmit={(name) => createM.mutate({ dir: row.dir, name, kind: row.creating })}
            onCancel={() => {
              setCreating(null);
              setNameError(null);
              listRef.current?.element?.focus();
            }}
          />
        </div>
      );
    }
    if (row.kind === "status") {
      const message =
        row.state === "loading"
          ? "Loading…"
          : row.state === "truncated"
            ? TRUNCATED_ROW_LABEL
            : row.state === "changed"
              ? changedOnHostNotice(hostName)
              : (listErrorCopy(errorCode(row.error), hostName) ?? errorMessage(row.error));
      return (
        <TreeStatusRow
          key={`status:${row.dir}:${row.state}`}
          top={top}
          height={rowHeight}
          depth={row.depth}
          state={row.state}
          message={message}
          detail={row.state === "truncated" ? truncationNotice(hostName) : undefined}
          onRetry={
            row.state === "error" || row.state === "changed"
              ? () => void refresh(row.dir)
              : undefined
          }
        />
      );
    }
    const selected = selection.selected.has(row.entry.path);
    const focused = listFocused && selection.focus === row.entry.path;
    const common = {
      id,
      top,
      height: rowHeight,
      entry: row.entry,
      selected,
      focused,
      dropTarget: dropDir === row.entry.path,
      query: filter,
      rename: renameInput(row),
      menu: rowMenu(row),
      onClick: (event: ReactMouseEvent) => onRowClick(row, event),
      onDoubleClick: () => onRowDoubleClick(row),
      onContextMenu: (event: ReactMouseEvent) => openContextMenu(event, row),
      onPointerEnter: () => onRowPointerEnter(row),
      dropProps: row.entry.is_dir ? dropProps(row.entry.path) : undefined,
    };
    if (view === "details") {
      return (
        <DetailsRow key={row.entry.path} {...common} index={index} template={template} now={now} />
      );
    }
    return (
      <TreeEntryRow
        key={row.entry.path}
        {...common}
        depth={row.depth}
        expanded={row.expanded}
        loadingChildren={row.expanded && Boolean(folders.get(row.entry.path)?.loading)}
        dense={dense}
      />
    );
  };

  // What an empty list says, if anything.
  const rootError = cwdState?.error && !cwdListing ? cwdState.error : null;
  // Not `isLoading`: while the channel connects the query is disabled, so it
  // is pending but not fetching — and the list would claim to be empty.
  const rootBusy =
    hostControlState !== "error" && !rootError && (!controlReady || !cwd || !cwdListing);
  let emptyContent: ReactNode = null;
  if (rootBusy) {
    emptyContent = (
      // Placeholder rows rather than a spinner: the panel fills with the
      // shape of what is coming instead of jumping from empty to full.
      <div
        role="status"
        aria-label="Loading files"
        aria-busy
        className="absolute inset-x-0 top-0 animate-pulse space-y-1 px-2 py-1"
        style={{ top: view === "details" ? DETAILS_HEADER_HEIGHT : 0 }}
      >
        {["w-2/5", "w-3/5", "w-1/2", "w-4/6", "w-1/3", "w-2/4"].map((width) => (
          <div key={width} className="flex h-6 items-center gap-2" aria-hidden>
            <div className="size-4 shrink-0 rounded bg-muted" />
            <div className={cn("h-2.5 rounded bg-muted", width)} />
          </div>
        ))}
      </div>
    );
  } else if (rootError) {
    emptyContent = (
      <div
        className="absolute inset-x-0 px-3 py-3 text-xs"
        style={{ top: view === "details" ? DETAILS_HEADER_HEIGHT : 0 }}
      >
        <p role="alert" className="text-destructive">
          {listErrorCopy(errorCode(rootError), hostName) ?? errorMessage(rootError)}
        </p>
        {!isFinalListError(rootError) && cwd && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-7"
            onClick={() => void refresh(cwd)}
          >
            Retry
          </Button>
        )}
      </div>
    );
  } else if (cwdListing && !connectionError) {
    const onlyHidden = hidden > 0 && !filter.trim();
    emptyContent = (
      <div
        className="absolute inset-x-0 px-3 py-4 text-center text-xs text-muted-foreground"
        style={{ top: view === "details" ? DETAILS_HEADER_HEIGHT : 0 }}
      >
        {filter.trim() ? (
          <p>{noFilterMatches(filter, hidden)}</p>
        ) : onlyHidden ? (
          <>
            <p>{onlyHiddenFiles(hidden)}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7"
              onClick={() => prefs.setShowHidden(true)}
            >
              {SHOW_HIDDEN_LABEL}
            </Button>
          </>
        ) : (
          <p>
            {EMPTY_FOLDER}
            {can.write && " Drop files here to upload."}
          </p>
        )}
      </div>
    );
  }

  const header =
    view === "details" ? (
      <DetailsHeader
        template={template}
        sort={sort}
        widths={columns}
        onSort={(key) => prefs.setSort(toggleSort(sort, key))}
        onResize={(key: ColumnKey, width) =>
          setColumnsLive((current) => resizeColumn(current, key, width))
        }
        onResizeEnd={(key: ColumnKey, width) => prefs.setColumns(resizeColumn(columns, key, width))}
      />
    ) : undefined;

  const filterField = (compact: boolean) => (
    <div className={cn("relative", compact ? "w-full" : "w-full @xl/files:w-44")}>
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={filterRef}
        type="search"
        aria-label={FILTER_PLACEHOLDER}
        placeholder={FILTER_PLACEHOLDER}
        value={filter}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setFilter("");
            if (layout !== "page") setFilterOpen(false);
            listRef.current?.element?.focus();
          } else if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            listRef.current?.element?.focus();
            if (!selection.focus) {
              setSelection((current) => moveFocus(order, current, "first", "select"));
            }
          }
        }}
        className={cn(
          "w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring",
          compact ? "h-7" : "h-8",
        )}
      />
    </div>
  );

  const showFilterRow = layout !== "page" && (filterOpen || filter !== "");
  const sortOrders: SortOrder[] =
    FIRST_ORDER[sort.key] === "asc" ? ["asc", "desc"] : ["desc", "asc"];
  const viewToggle = (target: FileBrowserView, label: string, Icon: typeof List) => (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
      aria-label={label}
      title={label}
      aria-pressed={view === target}
      onClick={() => prefs.setView(target)}
    >
      <Icon className="size-4" aria-hidden />
    </Button>
  );

  return (
    <div className={cn("@container/files flex min-h-0 flex-col", className)}>
      {layout === "page" && (
        <div
          role="toolbar"
          aria-label="Files toolbar"
          onKeyDown={onBrowserKeyDown}
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5"
        >
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Back"
              title="Back"
              disabled={!history || !canGoBack(history)}
              onClick={() => stepHistory("back")}
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Forward"
              title="Forward"
              disabled={!history || !canGoForward(history)}
              onClick={() => stepHistory("forward")}
            >
              <ArrowRight className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Enclosing folder"
              title="Enclosing folder"
              disabled={atCeiling}
              onClick={goUp}
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
          </div>
          {cwd && ceiling && homeDir ? (
            <PathBar
              ref={pathBarRef}
              className="min-w-[10rem] flex-1 basis-60"
              path={cwd}
              ceiling={ceiling}
              ceilingLabel="Home"
              homeDir={homeDir}
              flavor={flavor}
              editable
              onNavigate={(path) => navigate(path)}
              onSubmit={goToFolder}
            />
          ) : (
            <div className="h-8 min-w-[10rem] flex-1 basis-60" />
          )}
          <div className="flex w-full items-center gap-1 @xl/files:w-auto">
            <div className="min-w-0 flex-1">{filterField(false)}</div>
            <div className="flex shrink-0 items-center">
              {viewToggle("details", "Details view", List)}
              {viewToggle("tree", "Tree view", ListTree)}
              {view === "tree" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Collapse all"
                  title="Collapse all"
                  onClick={() => setExpanded([])}
                >
                  <ChevronsDownUp className="size-4" aria-hidden />
                </Button>
              )}
              {(can.mkdir || can.write) && (
                <DropdownMenu
                  align="end"
                  onOpenChange={onMenuOpenChange}
                  renderTrigger={(props) => (
                    <Button
                      {...props}
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label="New"
                      title="New"
                    >
                      <Plus className="size-4" aria-hidden />
                    </Button>
                  )}
                >
                  {can.mkdir && (
                    <DropdownMenuItem onSelect={() => startCreate("folder")}>
                      <FolderPlus className="size-4" aria-hidden />
                      {NEW_FOLDER_LABEL}
                    </DropdownMenuItem>
                  )}
                  {can.write && (
                    <DropdownMenuItem onSelect={() => startCreate("file")}>
                      <FilePlus className="size-4" aria-hidden />
                      {NEW_FILE_LABEL}
                    </DropdownMenuItem>
                  )}
                  {can.write && (
                    <DropdownMenuItem onSelect={() => pickUpload(targetDir())}>
                      <Upload className="size-4" aria-hidden />
                      {UPLOAD_FILES_LABEL}
                    </DropdownMenuItem>
                  )}
                </DropdownMenu>
              )}
              <DropdownMenu
                align="end"
                onOpenChange={onMenuOpenChange}
                renderTrigger={(props) => (
                  <Button
                    {...props}
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="View options"
                    title="View options"
                  >
                    <SlidersHorizontal className="size-4" aria-hidden />
                  </Button>
                )}
              >
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                {SORT_KEYS.map((key) => (
                  <DropdownMenuItem
                    key={key}
                    checked={sort.key === key}
                    onSelect={() =>
                      sort.key !== key && prefs.setSort({ ...sort, key, order: FIRST_ORDER[key] })
                    }
                  >
                    {COLUMNS.find((column) => column.key === key)?.label ?? key}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                {/* Worded for the field, its first-click direction first. */}
                {sortOrders.map((order) => (
                  <DropdownMenuItem
                    key={order}
                    checked={sort.order === order}
                    onSelect={() => prefs.setSort({ ...sort, order })}
                  >
                    {SORT_ORDER_LABELS[sort.key][order]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  checked={sort.foldersFirst}
                  onSelect={() => prefs.setSort({ ...sort, foldersFirst: !sort.foldersFirst })}
                >
                  {FOLDERS_ON_TOP_LABEL}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  checked={showHidden}
                  onSelect={() => prefs.setShowHidden(!showHidden)}
                >
                  {SHOW_HIDDEN_LABEL}
                </DropdownMenuItem>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={showHidden ? HIDE_HIDDEN_LABEL : SHOW_HIDDEN_LABEL}
                title={showHidden ? HIDE_HIDDEN_LABEL : SHOW_HIDDEN_LABEL}
                aria-pressed={showHidden}
                onClick={() => prefs.setShowHidden(!showHidden)}
              >
                {showHidden ? (
                  <Eye className="size-4" aria-hidden />
                ) : (
                  <EyeOff className="size-4" aria-hidden />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Refresh files"
                title="Refresh"
                onClick={refreshEverything}
              >
                <RefreshCw className={cn("size-4", fetching && "animate-spin")} aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                // The pane only fits a wide browser; narrower, there is no toggle to offer.
                className="hidden size-8 aria-pressed:bg-accent aria-pressed:text-accent-foreground @3xl/files:inline-flex"
                aria-label="Details pane"
                title="Details pane"
                aria-pressed={prefs.detailsPane}
                onClick={() => prefs.setDetailsPane(!prefs.detailsPane)}
              >
                <PanelRight className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Always mounted: hosts that hide the toolbar still upload through the
          handle's upload(), which clicks this input. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        aria-label="Upload file input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          const dir = uploadDirRef.current ?? cwd;
          if (dir) void uploadFiles(dir, files);
        }}
      />

      {showFilterRow && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          {filterField(true)}
          <button
            type="button"
            aria-label="Close filter"
            onClick={() => {
              setFilter("");
              setFilterOpen(false);
              listRef.current?.element?.focus();
            }}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {signedRtcRefusal && (
        // A trust refusal is not a transport hiccup: say why the channel is
        // blocked and point at the page with the safe next step. Never an override.
        <div
          className="shrink-0 px-3 py-2 text-xs leading-relaxed text-destructive"
          role="alert"
          data-testid="files-trust-refusal"
        >
          {SIGNED_RTC_REFUSAL_DETAIL[signedRtcRefusal]}{" "}
          <Link
            href={`/hosts/${hostId}`}
            className="font-medium text-foreground underline underline-offset-2"
          >
            Review this host
          </Link>
        </div>
      )}
      {connectionError && !signedRtcRefusal && (
        <p className="shrink-0 px-3 py-2 text-xs text-destructive" role="alert">
          {connectionError}
        </p>
      )}
      {notice && (
        <p
          className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {notice}
        </p>
      )}
      {truncated && (
        <p
          role="note"
          className="flex shrink-0 items-start gap-2 border-b border-border bg-warning-soft px-3 py-1.5 text-xs text-foreground"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          {truncationNotice(hostName)}
        </p>
      )}
      {cwdListing?.changedOnHost && (
        // A folder bigger than a page cannot be kept current one page at a
        // time; rather than show rows that may be gone as if they were live,
        // it says it changed, and reads it all again when asked.
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-info-soft px-3 py-1 text-xs text-foreground"
        >
          <RefreshCw className="size-3.5 shrink-0 text-info" aria-hidden />
          <span className="min-w-0 flex-1">{changedOnHostNotice(hostName)}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={!controlReady}
            onClick={() => cwd && void refresh(cwd)}
          >
            Refresh
          </Button>
        </div>
      )}
      {layout !== "page" && view === "details" && cwd && ceiling && homeDir && (
        <PathBar
          className="shrink-0 border-b border-border"
          path={cwd}
          ceiling={ceiling}
          ceilingLabel={rootLabel ?? (pathBasename(ceiling, flavor) || ceiling)}
          homeDir={homeDir}
          flavor={flavor}
          editable={false}
          onNavigate={(path) => navigate(path)}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <FileList
            ref={listRef}
            key={view}
            role={view === "details" ? "grid" : "tree"}
            label="Files"
            count={rows.length}
            rowHeight={rowHeight}
            header={header}
            headerHeight={view === "details" ? DETAILS_HEADER_HEIGHT : 0}
            minWidth={minWidth}
            activeId={activeId}
            pinned={[focusIndex ?? -1, editIndex]}
            scrollKey={cwd ?? ""}
            renderRow={renderRow}
            onRangeChange={onRangeChange}
            onKeyDown={onBrowserKeyDown}
            onFocus={(event) => {
              if (event.target === event.currentTarget) setListFocused(true);
            }}
            onBlur={(event) => {
              if (event.target === event.currentTarget) setListFocused(false);
            }}
            onScroll={() => hover.cancel()}
            // The card is about a file, so it goes the moment the pointer is
            // on something that is not one. A pinned card stays — Space asked
            // for it, and only Escape answers that.
            onPointerMove={(event) => {
              if (hover.value === null || hover.pinned) return;
              if (!(event.target as Element).closest("[data-path]")) hover.cancel();
            }}
            // A preview still waiting on its delay is for a row the pointer
            // has now left; one already open is closed by geometry instead.
            onPointerLeave={() => {
              if (hover.value === null) hover.cancel();
            }}
            onClick={(event) => {
              // A click on the ground between and below rows clears the selection.
              const target = event.target as Element;
              if (!target.closest("[data-path], button, input, [role='separator']")) {
                setSelection(EMPTY_SELECTION);
              }
            }}
            onContextMenu={(event) => {
              if ((event.target as Element).closest("[data-path]")) return;
              openContextMenu(event, null);
            }}
            className={cn(dropDir && cwd && dropDir === cwd && "bg-primary/5")}
            {...(cwd ? dropProps(cwd) : {})}
          >
            {emptyContent}
          </FileList>
        </div>
        {layout === "page" && prefs.detailsPane && cwd && homeDir && (
          <DetailsPane
            hostId={hostId}
            client={client}
            canStat={caps.stat}
            entries={selectedRows.map((row) => row.entry)}
            folderName={pathsEqual(cwd, homeDir, flavor) ? "Home" : pathBasename(cwd, flavor)}
            folderCount={shown}
            homeDir={homeDir}
            flavor={flavor}
            onCopyPath={(path) => void copyText(path, "path")}
            onClose={() => prefs.setDetailsPane(false)}
            className="hidden @3xl/files:flex"
          />
        )}
      </div>

      {layout === "page" ? (
        <div
          className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1 text-[11px] text-muted-foreground"
          role="status"
        >
          <span className="min-w-0 flex-1 truncate">
            {uploadingCount > 0
              ? `Uploading ${uploadingCount} file(s)...`
              : (status ??
                (cwdListing
                  ? statusSummary({
                      shown,
                      hidden,
                      selected: selectedRows.length,
                      selectedBytes,
                      formatBytes: formatSize,
                    })
                  : ""))}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {(fetching || uploadingCount > 0) && (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            )}
            {/* Only a folder that fits on one page is kept current on a timer. */}
            {controlReady && cwdListing && !cwdListing.multiPage && POLLED_REFRESH_NOTE}
          </span>
        </div>
      ) : (
        (status || uploadingCount > 0) && (
          <div
            className="flex shrink-0 items-center gap-2 border-t border-border px-2 py-1 text-[11px] text-muted-foreground"
            role="status"
          >
            {uploadingCount > 0 && <Loader2 className="size-3 animate-spin" aria-hidden />}
            <span className="truncate">
              {uploadingCount > 0 ? `Uploading ${uploadingCount} file(s)...` : status}
            </span>
          </div>
        )
      )}

      {/* Hover preview. Anchored to the panel's edges but the row's vertical
          extent, so it tracks the row without sliding sideways, and pinned
          to the right when it is lying over the panel. */}
      <Popover
        open={hoverEntry !== null}
        anchor={hoverPlacement?.anchor ?? null}
        side="right"
        align="start"
        flip={!hoverPlacement?.overlay}
        interactive
        id="file-preview-card"
        ariaLabel={hoverEntry ? `${hoverEntry.name} preview` : undefined}
      >
        {hoverEntry && (
          <FilePreviewCard
            hostId={hostId}
            entry={hoverEntry}
            client={client}
            caps={caps}
            onOpen={() => {
              hover.cancel();
              setViewing(hoverEntry.path);
            }}
          />
        )}
      </Popover>

      <FileViewerDialog
        open={viewing !== null && viewingEntry !== null}
        hostId={hostId}
        entry={viewingEntry}
        client={client}
        caps={caps}
        hasPrev={viewingIndex > 0}
        hasNext={viewingIndex >= 0 && viewingIndex < viewableRows.length - 1}
        relativePath={viewingEntry ? relativePath(viewingEntry.path) : ""}
        onNavigate={(delta) => {
          const next = viewableRows[viewingIndex + delta];
          if (next) {
            setViewing(next.entry.path);
            setSelection(selectOnly(next.entry.path));
          }
        }}
        onClose={() => setViewing(null)}
        onDownload={() => viewingEntry && void download(viewingEntry)}
        onReveal={() => viewingEntry && revealM.mutate(viewingEntry)}
        onOpenExternal={() => viewingEntry && openExternalM.mutate(viewingEntry)}
        onCopyPath={() => viewingEntry && void copyText(viewingEntry.path, "path")}
      />

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-44 overflow-y-auto overscroll-contain rounded-lg border border-popover-border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/50"
          style={menuCoords ?? { position: "fixed", visibility: "hidden" }}
          onClick={() => setMenu(null)}
        >
          {menu.targets === null
            ? backgroundActions()
            : menu.targets.length === 1 && menu.targets[0]
              ? entryActions(menu.targets[0])
              : selectionActions(menu.targets)}
        </div>
      )}
    </div>
  );
});
