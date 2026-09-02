"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  ChevronRight,
  ChevronsDownUp,
  Copy,
  CornerUpLeft,
  Download,
  ExternalLink,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import {
  type DragEvent,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileIcon } from "@/components/files/file-icon";
import { FilePreviewCard } from "@/components/files/file-preview-card";
import { FileViewerDialog } from "@/components/files/file-viewer-dialog";
import { type PreviewPlacement, previewPlacement } from "@/components/files/preview-placement";
import { Button } from "@/components/ui/button";
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
import { Popover } from "@/components/ui/popover";
import { useHostControl } from "@/hooks/useHostControl";
import { ApiError, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { HostControlClient, type HostDirEntry, type HostDirList } from "@/lib/hostControl";
import {
  isPathWithin,
  isValidPathLeafName,
  joinPath,
  normalizeAbsolutePath,
  type PathFlavor,
  basename as pathBasename,
  pathFlavorForHostOS,
  pathsEqual,
} from "@/lib/paths";
import { deriveFileCapabilities } from "@/lib/preview/capabilities";
import { classifyFile } from "@/lib/preview/file-kinds";
import { previewCache } from "@/lib/preview/preview-cache";
import { resolveSignedRtcTrust, SIGNED_RTC_REFUSAL_DETAIL } from "@/lib/signed-rtc-trust";
import { cn } from "@/lib/utils";
import { FILE_EXPLORER_RETAINED_PAGE_LIMIT, retainDirectoryPages } from "./fileExplorerPaging";

/**
 * VS Code-style lazy file tree for a spawn host. Flat-rendered rows with
 * indent guides; directories expand in place and load on demand.
 */

const INDENT_PX = 12;

interface EntryRow {
  kind: "entry";
  entry: HostDirEntry;
  depth: number;
  parentDir: string;
}

interface PageRow {
  kind: "page";
  depth: number;
  dir: string;
  nextCursor: number | null;
  loading: boolean;
  error: unknown;
  limitReached: boolean;
}

type Row = EntryRow | PageRow;

interface DirectoryListing {
  entries: HostDirEntry[];
  nextCursor: number | null;
  loading: boolean;
  error: unknown;
  limitReached: boolean;
}

interface MenuState {
  x: number;
  y: number;
  entry: HostDirEntry;
  parentDir: string;
}

function baseName(path: string, flavor: PathFlavor): string {
  return pathBasename(path, flavor) || path;
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : String(err);
}

export function formatSize(size: number | null | undefined): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Imperative surface for hosts that fold the explorer's actions into their
 *  own single header row (widget pane, files aside). */
export type FileExplorerHandle = {
  newFolder: () => void;
  upload: () => void;
  refresh: () => void;
  collapseAll: () => void;
};

export const FileExplorer = forwardRef<
  FileExplorerHandle,
  {
    hostId: string;
    /** Directory the tree is rooted at; defaults to the daemon home dir. */
    rootPath?: string;
    rootLabel?: string;
    /** Deep link: ancestors are expanded and the entry selected once loaded. */
    initialPath?: string;
    dense?: boolean;
    /** The host renders its own single-row header (and reaches the actions
     *  through the ref); the explorer's built-in header row is dropped. */
    hideHeader?: boolean;
    className?: string;
  }
>(function FileExplorer(
  { hostId, rootPath, rootLabel, initialPath, dense = false, hideHeader = false, className },
  handleRef,
) {
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [pageCursors, setPageCursors] = useState<Record<string, number[]>>({});
  const uploadDirRef = useRef<string | null>(null);
  const initialAppliedRef = useRef(false);
  const { user } = useAuth();
  // Liveness for the destination-channel trust capability: a transfer that
  // spans a logout or account switch must abort rather than complete under the
  // previous account's pin and signing identity.
  const liveAccountIdRef = useRef<string | null>(user?.id ?? null);
  liveAccountIdRef.current = user?.id ?? null;
  const {
    client: hostControl,
    state: hostControlState,
    capabilities,
    os: hostOs,
    signedRtcRefusal,
  } = useHostControl(hostId);
  const pathFlavor = pathFlavorForHostOS(hostOs);
  const controlReady = hostControlState === "ready" && hostControl !== null;
  // Actions are gated on what the daemon advertised, never on the platform it
  // reports: an old agent on a Mac must not be offered what it cannot do, and a
  // future Linux agent lights them up with no change here.
  const caps = useMemo(() => deriveFileCapabilities(capabilities, hostOs), [capabilities, hostOs]);

  const [viewing, setViewing] = useState<string | null>(null);
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

  /**
   * The tree keeps itself true to the disk without being asked: every visible
   * directory re-lists on this cadence (paused with the tab in background),
   * so a file an agent just wrote appears without anyone pressing Refresh.
   * Held off whenever a shifting list would tear something out from under the
   * pointer — an inline rename or new-folder input, a context menu, a drag.
   * Structural sharing keeps an unchanged answer from re-rendering anything.
   */
  const POLL_MS = 3_000;
  const polling =
    controlReady && renaming === null && creatingIn === null && menu === null && dropDir === null;

  const rootQ = useQuery({
    queryKey: ["host-files", hostId, rootPath ?? ""],
    queryFn: () => hostControl!.listPage(rootPath),
    enabled: controlReady,
    refetchInterval: polling ? POLL_MS : false,
    gcTime: 0,
  });
  const resolvedRoot = rootQ.data?.path ?? rootPath ?? null;

  const childQs = useQueries({
    queries: expanded.map((path) => ({
      queryKey: ["host-files", hostId, path],
      queryFn: () => hostControl!.listPage(path),
      enabled: controlReady,
      refetchInterval: polling ? POLL_MS : false,
      gcTime: 0,
    })),
  });
  const pageRequests = useMemo(
    () =>
      Object.entries(pageCursors).flatMap(([path, cursors]) =>
        cursors.map((cursor) => ({ path, cursor })),
      ),
    [pageCursors],
  );
  const pageQs = useQueries({
    queries: pageRequests.map(({ path, cursor }) => ({
      queryKey: ["host-files", hostId, path, "page", cursor],
      queryFn: () => hostControl!.listPage(path, cursor),
      enabled: controlReady,
      gcTime: 0,
    })),
  });
  const { rootListing, listings } = useMemo(() => {
    const extra = new Map<string, (typeof pageQs)[number]>();
    pageRequests.forEach(({ path, cursor }, index) => {
      const query = pageQs[index];
      if (query) extra.set(`${path}\0${cursor}`, query);
    });
    const build = (
      path: string,
      firstPage: HostDirList | undefined,
      firstLoading: boolean,
      firstError: unknown,
    ): DirectoryListing => {
      const pages = firstPage ? [firstPage] : [];
      let loading = firstLoading;
      let error = firstError;
      for (const cursor of pageCursors[path] ?? []) {
        const query = extra.get(`${path}\0${cursor}`);
        if (query?.data) pages.push(query.data);
        else {
          loading ||= Boolean(query?.isLoading || query?.isFetching);
          error ??= query?.error;
          break;
        }
      }
      const retained = retainDirectoryPages(pages);
      return { ...retained, loading, error };
    };
    const map = new Map<string, DirectoryListing>();
    expanded.forEach((path, index) => {
      const query = childQs[index];
      map.set(
        path,
        build(
          path,
          query?.data,
          Boolean(!query?.data && (query?.isLoading || query?.isFetching)),
          query?.error,
        ),
      );
    });
    return {
      rootListing: resolvedRoot
        ? build(
            resolvedRoot,
            rootQ.data,
            Boolean(!rootQ.data && (rootQ.isLoading || rootQ.isFetching)),
            rootQ.error,
          )
        : null,
      listings: map,
    };
  }, [childQs, expanded, pageCursors, pageQs, pageRequests, resolvedRoot, rootQ]);
  const retainedPageCount = 1 + expanded.length + pageRequests.length;

  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const otherHosts = (hostsQ.data ?? []).filter((h) => h.id !== hostId);

  // Props identify a distinct host tree, so local paging state must not leak.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on tree identity changes
  useEffect(() => {
    setPageCursors({});
    setExpanded([]);
    initialAppliedRef.current = false;
  }, [hostId, rootPath]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (listing: DirectoryListing, depth: number, parentDir: string) => {
      for (const entry of listing.entries) {
        out.push({ kind: "entry", entry, depth, parentDir });
        if (entry.is_dir && expanded.includes(entry.path)) {
          const child = listings.get(entry.path);
          if (child) walk(child, depth + 1, entry.path);
        }
      }
      if (listing.loading || listing.error || listing.nextCursor !== null || listing.limitReached) {
        out.push({
          kind: "page",
          depth,
          dir: parentDir,
          nextCursor: listing.nextCursor,
          loading: listing.loading,
          error: listing.error,
          limitReached: listing.limitReached,
        });
      }
    };
    if (rootListing && resolvedRoot) walk(rootListing, 0, resolvedRoot);
    return out;
  }, [resolvedRoot, expanded, listings, rootListing]);
  const entryRows = useMemo(
    () => rows.filter((row): row is EntryRow => row.kind === "entry"),
    [rows],
  );
  /** Files only — Prev/Next in the viewer steps past folders, not into them. */
  const viewableRows = useMemo(() => entryRows.filter((row) => !row.entry.is_dir), [entryRows]);
  const viewingIndex = useMemo(
    () => (viewing === null ? -1 : viewableRows.findIndex((r) => r.entry.path === viewing)),
    [viewing, viewableRows],
  );
  const viewingEntry = viewingIndex >= 0 ? (viewableRows[viewingIndex]?.entry ?? null) : null;
  const hoverEntry = useMemo(() => {
    const path = hover.value?.path;
    if (!path) return null;
    return entryRows.find((row) => row.entry.path === path)?.entry ?? null;
  }, [hover.value, entryRows]);

  // Where the card hangs from, and whether it is lying over the panel to get
  // there — `previewPlacement` owns both, from the row's box and the panel's.
  const [hoverPlacement, setHoverPlacement] = useState<PreviewPlacement | null>(null);
  useLayoutEffect(() => {
    const path = hover.value?.path;
    const container = containerRef.current;
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
   * The card closes on geometry, never on a countdown.
   *
   * While one is open the live region is the file panel, the card, and a narrow
   * bridge across the gap between them — so travelling from a row to the card,
   * pausing on the way, reading it, or drifting back into the list all keep it
   * up, and it goes the instant the pointer is somewhere else. A close *timer*
   * is what makes a hover card unreachable: the deadline runs while the pointer
   * is still on its way there.
   */
  useEffect(() => {
    if (hover.value === null || hover.pinned) return;
    /**
     * Slack on the corridor between the panel and the card — and only there.
     * Padding the card's far side would keep it alive while the pointer is
     * heading away from it, which is the opposite of what leniency is for.
     */
    const BRIDGE = 20;
    const within = (
      box: DOMRect | { left: number; right: number; top: number; bottom: number },
      x: number,
      y: number,
    ) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

    const outside = (x: number, y: number) => {
      const panel = containerRef.current?.getBoundingClientRect() ?? null;
      const card = document.getElementById("file-preview-card")?.getBoundingClientRect() ?? null;
      if (!panel && !card) return true;
      // Inside the list the rows decide: another file swaps the card, and a
      // folder or the bare panel (below the last row, between rows) takes it
      // away — see the row's pointerenter and the tree's pointermove.
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
    // Leaving the window entirely counts as leaving the region.
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

  // Opening the viewer, losing the channel, or unmounting all close the card;
  // a disconnect additionally drops every cached preview for this host so a
  // reconnect cannot show bytes from a session that has ended.
  useEffect(() => {
    if (viewing !== null) hover.cancel();
  }, [viewing, hover.cancel]);

  useEffect(() => {
    if (hostControlState === "ready") return;
    hover.cancel();
    setViewing(null);
    previewCache.clearHost(hostId);
  }, [hostControlState, hostId, hover.cancel]);

  useEffect(() => () => previewCache.clearHost(hostId), [hostId]);

  // Deep link: expand every ancestor between the root and initialPath.
  useEffect(() => {
    if (initialAppliedRef.current || !initialPath || !resolvedRoot) return;
    if (
      pathsEqual(initialPath, resolvedRoot, pathFlavor) ||
      !isPathWithin(initialPath, resolvedRoot, pathFlavor)
    ) {
      initialAppliedRef.current = true;
      return;
    }
    const rest = initialPath
      .slice(resolvedRoot.length)
      .split(pathFlavor === "windows" ? /[\\/]/u : "/")
      .filter(Boolean);
    const ancestors: string[] = [];
    let acc = resolvedRoot;
    for (const part of rest) {
      acc = normalizeAbsolutePath(joinPath(acc, part, pathFlavor), pathFlavor);
      ancestors.push(acc);
    }
    const available = Math.max(0, FILE_EXPLORER_RETAINED_PAGE_LIMIT - 1);
    setExpanded((current) => [...new Set([...current, ...ancestors])].slice(0, available));
    if (ancestors.length > available) {
      setStatus("File view limit reached before the full deep link could be expanded");
    }
    setSelected(initialPath);
    initialAppliedRef.current = true;
  }, [initialPath, pathFlavor, resolvedRoot]);

  const refreshDir = useCallback(
    (dir: string | null) => {
      setPageCursors((current) => {
        const next = { ...current };
        if (dir) delete next[dir];
        else if (resolvedRoot) delete next[resolvedRoot];
        return next;
      });
      if (dir === null || dir === resolvedRoot) {
        qc.invalidateQueries({ queryKey: ["host-files", hostId, rootPath ?? ""] });
        if (resolvedRoot) qc.invalidateQueries({ queryKey: ["host-files", hostId, resolvedRoot] });
      } else {
        qc.invalidateQueries({ queryKey: ["host-files", hostId, dir] });
      }
    },
    [hostId, qc, resolvedRoot, rootPath],
  );

  const refreshAll = useCallback(() => {
    setPageCursors({});
    qc.invalidateQueries({ queryKey: ["host-files", hostId] });
  }, [hostId, qc]);

  useImperativeHandle(
    handleRef,
    () => ({
      newFolder: () => {
        if (resolvedRoot) {
          setCreatingIn(resolvedRoot);
          setFolderDraft("");
        }
      },
      upload: () => {
        uploadDirRef.current = resolvedRoot;
        fileInputRef.current?.click();
      },
      refresh: refreshAll,
      collapseAll: () => {
        setExpanded([]);
        setPageCursors((current) =>
          resolvedRoot && current[resolvedRoot] ? { [resolvedRoot]: current[resolvedRoot] } : {},
        );
      },
    }),
    [refreshAll, resolvedRoot],
  );

  const toggleDir = useCallback(
    (path: string) => {
      if (expanded.includes(path)) {
        setExpanded((current) =>
          current.filter((entryPath) => !isPathWithin(entryPath, path, pathFlavor)),
        );
        setPageCursors((pages) =>
          Object.fromEntries(
            Object.entries(pages).filter(([pagePath]) => !isPathWithin(pagePath, path, pathFlavor)),
          ),
        );
        return;
      }
      if (retainedPageCount >= FILE_EXPLORER_RETAINED_PAGE_LIMIT) {
        setStatus("File view limit reached; collapse a directory before expanding another");
        return;
      }
      setExpanded((current) => [...current, path]);
    },
    [expanded, pathFlavor, retainedPageCount],
  );

  const loadNextPage = useCallback(
    (path: string, cursor: number) => {
      if (retainedPageCount >= FILE_EXPLORER_RETAINED_PAGE_LIMIT) {
        setStatus("File view limit reached; collapse a directory before loading more entries");
        return;
      }
      setPageCursors((current) => {
        const cursors = current[path] ?? [];
        return cursors.includes(cursor) ? current : { ...current, [path]: [...cursors, cursor] };
      });
    },
    [retainedPageCount],
  );

  const uploadFiles = useCallback(
    async (dir: string, files: globalThis.File[]) => {
      if (files.length === 0) return;
      setStatus(null);
      setUploadingCount((n) => n + files.length);
      for (const file of files) {
        try {
          if (!hostControl) throw new Error("Host control channel is not ready");
          const result = await hostControl.uploadFile(file, { dir });
          setStatus(`Uploaded ${result.path ?? file.name}`);
        } catch (err) {
          setStatus(`${file.name || "File"}: ${errorMessage(err)}`);
        } finally {
          setUploadingCount((n) => n - 1);
        }
      }
      refreshDir(dir);
    },
    [hostControl, refreshDir],
  );

  const mkdirM = useMutation({
    mutationFn: ({ dir, name }: { dir: string; name: string }) =>
      hostControl?.mkdir(normalizeAbsolutePath(joinPath(dir, name, pathFlavor), pathFlavor)) ??
      Promise.reject(new Error("Host is not connected")),
    onSuccess: (_, { dir }) => {
      setCreatingIn(null);
      setFolderDraft("");
      refreshDir(dir);
      if (dir !== resolvedRoot) setExpanded((cur) => (cur.includes(dir) ? cur : [...cur, dir]));
    },
    onError: (err) => setStatus(errorMessage(err)),
  });

  const renameM = useMutation({
    mutationFn: ({ entry, name }: { entry: HostDirEntry; name: string; parentDir: string }) =>
      hostControl?.rename(entry.path, name) ?? Promise.reject(new Error("Host is not connected")),
    onSuccess: (result, { entry, parentDir }) => {
      setRenaming(null);
      if (result.path) {
        setSelected(result.path);
        if (entry.is_dir) {
          setExpanded((cur) =>
            cur.map((p) =>
              pathsEqual(p, entry.path, pathFlavor)
                ? (result.path as string)
                : isPathWithin(p, entry.path, pathFlavor)
                  ? `${result.path}${p.slice(entry.path.length)}`
                  : p,
            ),
          );
          setPageCursors((current) =>
            Object.fromEntries(
              Object.entries(current).map(([path, cursors]) => [
                pathsEqual(path, entry.path, pathFlavor)
                  ? (result.path as string)
                  : isPathWithin(path, entry.path, pathFlavor)
                    ? `${result.path}${path.slice(entry.path.length)}`
                    : path,
                cursors,
              ]),
            ),
          );
        }
      }
      refreshDir(parentDir);
      setStatus(null);
    },
    onError: (err) => setStatus(errorMessage(err)),
  });

  const deleteM = useMutation({
    mutationFn: ({ entry }: { entry: HostDirEntry; parentDir: string }) =>
      hostControl?.remove(entry.path, entry.is_dir === true) ??
      Promise.reject(new Error("Host is not connected")),
    onSuccess: (_, { entry, parentDir }) => {
      setStatus(`Deleted ${entry.name}`);
      setExpanded((cur) => cur.filter((path) => !isPathWithin(path, entry.path, pathFlavor)));
      setPageCursors((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([path]) => !isPathWithin(path, entry.path, pathFlavor)),
        ),
      );
      if (selected && pathsEqual(selected, entry.path, pathFlavor)) setSelected(null);
      refreshDir(parentDir);
    },
    onError: (err) => setStatus(errorMessage(err)),
  });

  const transferM = useMutation({
    mutationFn: ({
      entry,
      destHostId,
      destDir,
    }: {
      entry: HostDirEntry;
      destHostId: string;
      destDir: string;
    }) => {
      if (!hostControl) throw new Error("Source host is not connected");
      // The destination channel must honour the same pin gate as the source:
      // a pinned host is never reached over a raw path, file transfer included.
      // Without an account we cannot consult the pin store, so fail closed
      // rather than silently transferring over an unverified connection.
      const accountId = user?.id;
      if (!accountId) throw new Error("Not signed in; cannot verify the destination host");
      return (async () => {
        const destHost = await hosts.get(destHostId);
        const destination = new HostControlClient(destHostId, {
          resolveSignedRtcTrust: () =>
            resolveSignedRtcTrust({
              accountId,
              hostId: destHostId,
              claimedHostPublicKey: destHost.host_public_key ?? null,
              isActive: () => liveAccountIdRef.current === accountId,
            }),
        });
        try {
          await destination.waitUntilReady();
          const home = await destination.home();
          return await hostControl.transferFileTo(
            destination,
            entry.path,
            destDir === "~" ? home.home_dir : destDir,
          );
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
        if (!hostControl) throw new Error("Host control channel is not ready");
        await hostControl.saveFileToBrowser(entry.path, entry.name);
        setStatus(null);
      } catch (err) {
        setStatus(`${entry.name}: ${errorMessage(err)}`);
      }
    },
    [hostControl],
  );

  const relativePath = useCallback(
    (path: string) => {
      if (!resolvedRoot) return path;
      if (pathsEqual(path, resolvedRoot, pathFlavor)) return ".";
      if (isPathWithin(path, resolvedRoot, pathFlavor)) {
        return path.slice(resolvedRoot.length).replace(/^[\\/]/u, "");
      }
      return path;
    },
    [pathFlavor, resolvedRoot],
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

  const startRename = useCallback((entry: HostDirEntry) => {
    setRenaming(entry.path);
    setRenameDraft(entry.name);
    setMenu(null);
  }, []);

  const confirmDelete = useCallback(
    (entry: HostDirEntry, parentDir: string) => {
      setMenu(null);
      const detail = entry.is_dir ? `${entry.name} and everything in it` : entry.name;
      if (confirm(`Delete ${detail}?`)) deleteM.mutate({ entry, parentDir });
    },
    [deleteM],
  );

  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  // Close the context menu on outside pointer / escape. Uses a contains
  // check (like DropdownMenu) — stopPropagation can't reliably beat a
  // document-level listener to the punch.
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

  // Placed by the shared menu geometry rather than by hand: the context menu
  // opens at the cursor, which near a viewport edge is exactly where a
  // naively-positioned menu runs off the screen.
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

  const onRowKeyDown = (event: ReactKeyboardEvent) => {
    if (renaming || creatingIn !== null) return;
    const index = entryRows.findIndex((r) => r.entry.path === selected);
    const row = index >= 0 ? entryRows[index] : null;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = entryRows[Math.min(entryRows.length - 1, index + 1)] ?? entryRows[0];
      if (next) setSelected(next.entry.path);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = entryRows[Math.max(0, index - 1)] ?? entryRows[0];
      if (prev) setSelected(prev.entry.path);
    } else if (event.key === "ArrowRight" && row?.entry.is_dir) {
      event.preventDefault();
      if (!expanded.includes(row.entry.path)) toggleDir(row.entry.path);
    } else if (event.key === "ArrowLeft" && row) {
      event.preventDefault();
      if (row.entry.is_dir && expanded.includes(row.entry.path)) {
        toggleDir(row.entry.path);
      } else if (row.depth > 0) {
        setSelected(row.parentDir);
      }
    } else if (event.key === "Enter" && row) {
      event.preventDefault();
      // Opening is what Enter means everywhere else; Download stays one menu
      // item away rather than being the only way to look at a file.
      if (row.entry.is_dir) toggleDir(row.entry.path);
      else setViewing(row.entry.path);
    } else if (event.key === " " && row && !row.entry.is_dir) {
      // Space peeks, the way it does in Finder. Pinned, so it survives the
      // pointer wandering off, and it never waits on the hover delay.
      event.preventDefault();
      hover.pin({ path: row.entry.path });
    } else if (event.key === "Escape") {
      hover.cancel();
    } else if (event.key === "F2" && row) {
      event.preventDefault();
      startRename(row.entry);
    } else if (event.key === "Delete" && row) {
      event.preventDefault();
      confirmDelete(row.entry, row.parentDir);
    }
  };

  const dropProps = (dir: string) => ({
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes("Files")) {
        event.preventDefault();
        event.stopPropagation();
        setDropDir(dir);
      }
    },
    onDragLeave: (event: DragEvent) => {
      event.stopPropagation();
      setDropDir((cur) => (cur === dir ? null : cur));
    },
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDropDir(null);
      void uploadFiles(dir, Array.from(event.dataTransfer.files));
    },
  });

  const openContextMenu = (event: ReactMouseEvent, entry: HostDirEntry, parentDir: string) => {
    event.preventDefault();
    // The card is pointer-events-none, so it cannot be clicked through — but a
    // menu opening behind a floating preview reads as a bug either way.
    hover.cancel();
    setSelected(entry.path);
    setMenu({ x: event.clientX, y: event.clientY, entry, parentDir });
  };

  const revealM = useMutation({
    mutationFn: (entry: HostDirEntry) => hostControl!.reveal(entry.path),
    onMutate: () => setStatus(null),
    onError: (error) => setStatus(errorMessage(error)),
  });

  const openExternalM = useMutation({
    mutationFn: (entry: HostDirEntry) => hostControl!.openDefault(entry.path),
    onMutate: () => setStatus(null),
    onError: (error) => setStatus(errorMessage(error)),
  });

  const rowActions = (entry: HostDirEntry, parentDir: string) => (
    <>
      {!entry.is_dir && (
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
      {(!entry.is_dir || caps.reveal) && <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={() => void copyText(entry.path, "path")}>
        <Copy className="size-4" aria-hidden />
        Copy path
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void copyText(relativePath(entry.path), "relative path")}>
        <CornerUpLeft className="size-4" aria-hidden />
        Copy relative path
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {!entry.is_dir && (
        <DropdownMenuItem onSelect={() => void download(entry)}>
          <Download className="size-4" aria-hidden />
          Download
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => startRename(entry)}>
        <Pencil className="size-4" aria-hidden />
        Rename
      </DropdownMenuItem>
      {!entry.is_dir && otherHosts.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Send to host</DropdownMenuLabel>
          {otherHosts.map((other) => (
            <DropdownMenuItem
              key={other.id}
              disabled={other.status !== "online"}
              onSelect={() =>
                transferM.mutate({
                  entry,
                  destHostId: other.id,
                  destDir: "~",
                })
              }
            >
              <ArrowRightLeft className="size-4" aria-hidden />
              {other.name}
            </DropdownMenuItem>
          ))}
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={() => confirmDelete(entry, parentDir)}>
        <Trash2 className="size-4" aria-hidden />
        Delete
      </DropdownMenuItem>
    </>
  );

  // Not `isLoading`: while the host channel is still connecting the query is
  // disabled, so it is pending but not fetching — and the panel would claim the
  // directory is empty for the whole of a multi-second connect.
  const rootBusy = hostControlState !== "error" && (!controlReady || rootQ.isPending);
  const label = rootLabel ?? (resolvedRoot ? baseName(resolvedRoot, pathFlavor) : "files");

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {!hideHeader && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          <span
            className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            title={resolvedRoot ?? undefined}
          >
            {label}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="New folder"
            onClick={() => {
              if (resolvedRoot) {
                setCreatingIn(resolvedRoot);
                setFolderDraft("");
              }
            }}
          >
            <FolderPlus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Upload files"
            onClick={() => {
              uploadDirRef.current = resolvedRoot;
              fileInputRef.current?.click();
            }}
          >
            <Upload className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Refresh files"
            onClick={refreshAll}
          >
            <RefreshCw className={cn("size-3.5", rootQ.isFetching && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Collapse all"
            onClick={() => {
              setExpanded([]);
              setPageCursors((current) =>
                resolvedRoot && current[resolvedRoot]
                  ? { [resolvedRoot]: current[resolvedRoot] }
                  : {},
              );
            }}
          >
            <ChevronsDownUp className="size-3.5" />
          </Button>
        </div>
      )}
      {/* Always mounted: hosts that hide the header still upload via the
          ref's upload(), which clicks this input. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        aria-label="Upload file input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const dir = uploadDirRef.current ?? resolvedRoot;
          if (dir) void uploadFiles(dir, files);
        }}
      />

      {/* Tree */}
      <div
        ref={containerRef}
        role="tree"
        aria-label="Files"
        tabIndex={0}
        onKeyDown={onRowKeyDown}
        onScroll={() => hover.cancel()}
        // The card is about a file, so it goes the moment the pointer is on
        // something that is not one: the panel's own ground, past the last
        // row or in the gutter beside them. A pinned card stays — Space
        // asked for it, and only Escape answers that.
        onPointerMove={(event) => {
          if (hover.value === null || hover.pinned) return;
          if (!(event.target as Element).closest("[role='treeitem']")) hover.cancel();
        }}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring",
          dropDir && resolvedRoot === dropDir && "bg-primary/5",
        )}
        {...(resolvedRoot ? dropProps(resolvedRoot) : {})}
      >
        {rootBusy && (
          // Placeholder rows rather than a spinner: the panel fills with the
          // shape of what is coming, so the tree does not appear to jump from
          // empty to full.
          <div
            role="status"
            aria-label="Loading files"
            aria-busy
            className="animate-pulse space-y-1 px-2 py-1"
          >
            {["w-2/5", "w-3/5", "w-1/2", "w-4/6", "w-1/3", "w-2/4"].map((width) => (
              <div
                key={width}
                className={cn("flex items-center gap-2", dense ? "h-6" : "h-7")}
                aria-hidden
              >
                <div className="size-4 shrink-0 rounded bg-muted" />
                <div className={cn("h-2.5 rounded bg-muted", width)} />
              </div>
            ))}
          </div>
        )}
        {signedRtcRefusal && (
          // A trust refusal is not a transport hiccup: say why the channel is
          // blocked and point at the page that carries the safe next step
          // (remove + possess again for a re-keyed host). Never an override.
          <div
            className="px-3 py-2 text-xs leading-relaxed text-destructive"
            role="alert"
            data-testid="files-trust-refusal"
          >
            {SIGNED_RTC_REFUSAL_DETAIL[signedRtcRefusal]}{" "}
            <Link
              href={`/hosts/${hostId}`}
              className="font-medium underline underline-offset-2 text-foreground"
            >
              Review this host
            </Link>
          </div>
        )}
        {rootQ.error && (
          <p className="px-3 py-2 text-xs text-destructive" role="alert">
            {errorMessage(rootQ.error)}
          </p>
        )}
        {!rootBusy && entryRows.length === 0 && creatingIn === null && !rootQ.error && (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            Empty directory. Drop files here to upload.
          </p>
        )}

        {creatingIn === resolvedRoot && resolvedRoot && (
          <NewFolderRow
            depth={0}
            draft={folderDraft}
            pathFlavor={pathFlavor}
            setDraft={setFolderDraft}
            pending={mkdirM.isPending}
            onSubmit={(name) => mkdirM.mutate({ dir: resolvedRoot, name })}
            onCancel={() => setCreatingIn(null)}
          />
        )}

        {rows.map((row) => {
          if (row.kind === "page") {
            const atCapacity = retainedPageCount >= FILE_EXPLORER_RETAINED_PAGE_LIMIT;
            const label = row.loading
              ? "Loading more entries..."
              : row.error
                ? "Retry directory"
                : row.limitReached || atCapacity
                  ? "Entry limit reached"
                  : "Load more";
            return (
              <button
                key={`page:${row.dir}:${row.nextCursor ?? "terminal"}`}
                type="button"
                className="flex h-7 w-full items-center gap-2 text-left text-xs text-muted-foreground hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-transparent"
                style={{ paddingLeft: 20 + row.depth * INDENT_PX }}
                disabled={row.loading || row.limitReached || (atCapacity && !row.error)}
                onClick={() => {
                  if (row.error) refreshDir(row.dir);
                  else if (row.nextCursor !== null) loadNextPage(row.dir, row.nextCursor);
                }}
              >
                {row.loading && <Loader2 className="size-3 animate-spin" aria-hidden />}
                {label}
              </button>
            );
          }
          const { entry, depth, parentDir } = row;
          const isDir = entry.is_dir === true;
          const isExpanded = isDir && expanded.includes(entry.path);
          const isSelected = selected === entry.path;
          const isRenaming = renaming === entry.path;
          const childLoading = isExpanded && listings.get(entry.path)?.loading;
          return (
            <div key={entry.path}>
              <div
                role="treeitem"
                tabIndex={-1}
                aria-selected={isSelected}
                aria-expanded={isDir ? isExpanded : undefined}
                data-path={entry.path}
                className={cn(
                  "group/filerow relative flex cursor-default select-none items-center gap-1 pr-8",
                  dense ? "h-6" : "h-7",
                  isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
                  dropDir === entry.path && "bg-primary/10 outline outline-1 outline-primary",
                )}
                style={{ paddingLeft: 6 + depth * INDENT_PX }}
                onClick={(event) => {
                  // This row's dropdown is portalled to <body>, but React
                  // events bubble through the React tree rather than the DOM,
                  // so a click on one of its items arrives here too. Anything
                  // that did not physically happen inside the row — a menu
                  // item, a dismissing click — is not a click on the row.
                  if (!event.currentTarget.contains(event.target as Node)) return;
                  setSelected(entry.path);
                  if (isRenaming) return;
                  if (isDir) toggleDir(entry.path);
                  else setViewing(entry.path);
                }}
                // Enter/leave, never move: they fire once per row, so running
                // the pointer down a list cannot re-trigger a fetch per pixel.
                onPointerEnter={() => {
                  // A folder has nothing to preview, and resting on one is
                  // the pointer saying it has moved on from the file whose
                  // card is up — so the card goes, unless it was pinned.
                  if (isDir) {
                    if (!hover.pinned) hover.cancel();
                    return;
                  }
                  if (isRenaming || menu || dropDir || viewing) return;
                  hover.enter({ path: entry.path });
                }}
                onContextMenu={(e) => openContextMenu(e, entry, parentDir)}
                {...(isDir ? dropProps(entry.path) : {})}
              >
                {depth > 0 && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 left-0 flex"
                    style={{ paddingLeft: 11 }}
                  >
                    {Array.from({ length: depth }).map((_, i) => (
                      <span
                        // biome-ignore lint/suspicious/noArrayIndexKey: purely decorative guides
                        key={i}
                        className="h-full border-l border-border/50"
                        style={{ width: INDENT_PX }}
                      />
                    ))}
                  </span>
                )}
                {isDir ? (
                  <ChevronRight
                    className={cn(
                      "z-10 size-3.5 shrink-0 text-muted-foreground transition-transform",
                      isExpanded && "rotate-90",
                    )}
                    aria-hidden
                  />
                ) : (
                  <span className="z-10 size-3.5 shrink-0" aria-hidden />
                )}
                {isDir ? (
                  isExpanded ? (
                    <FolderOpen className="z-10 size-4 shrink-0 text-info" aria-hidden />
                  ) : (
                    <Folder className="z-10 size-4 shrink-0 text-info" aria-hidden />
                  )
                ) : (
                  <FileIcon
                    name={entry.name}
                    kind={entry.kind}
                    className="z-10 size-4 shrink-0 text-muted-foreground"
                  />
                )}
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    aria-label="Rename entry"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        const name = pathFlavor === "windows" ? renameDraft : renameDraft.trim();
                        if (isValidPathLeafName(name, pathFlavor) && name !== entry.name) {
                          renameM.mutate({ entry, name, parentDir });
                        } else {
                          setRenaming(null);
                        }
                      }
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={() => setRenaming(null)}
                    className="z-10 h-5 min-w-0 flex-1 rounded border border-ring bg-background px-1 text-[13px] outline-none"
                    disabled={renameM.isPending}
                  />
                ) : (
                  <span className="z-10 min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
                )}
                {childLoading && (
                  <Loader2
                    className="z-10 size-3 shrink-0 animate-spin text-muted-foreground"
                    aria-hidden
                  />
                )}
                {!dense && !isDir && (
                  <span className="z-10 hidden shrink-0 pr-1 text-[11px] tabular-nums text-muted-foreground sm:block">
                    {formatSize(entry.size)}
                  </span>
                )}
                <DropdownMenu
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  renderTrigger={(props) => (
                    <button
                      {...props}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        // The menu is about to open where the card is sitting.
                        hover.cancel();
                        props.onClick();
                      }}
                      // The kebab sits at the row's right edge, which is
                      // directly on the path to the card. So this suppresses a
                      // preview that has not opened yet — hovering the menu
                      // button is not a request to look at the file — but never
                      // dismisses one already open, or the card could not be
                      // reached at all.
                      onPointerEnter={() => {
                        if (hover.value === null) hover.cancel();
                      }}
                      aria-label={`${entry.name} actions`}
                      className="z-10 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/filerow:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    >
                      <MoreHorizontal className="size-3.5" aria-hidden />
                    </button>
                  )}
                >
                  {rowActions(entry, parentDir)}
                </DropdownMenu>
              </div>
              {creatingIn === entry.path && (
                <NewFolderRow
                  depth={depth + 1}
                  draft={folderDraft}
                  pathFlavor={pathFlavor}
                  setDraft={setFolderDraft}
                  pending={mkdirM.isPending}
                  onSubmit={(name) => mkdirM.mutate({ dir: entry.path, name })}
                  onCancel={() => setCreatingIn(null)}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Hover preview. Anchored to the panel's edges but the row's vertical
          extent, so it tracks the row without sliding sideways as the pointer
          runs down the list — and pinned to the right when it is lying over
          the panel, where a flip would carry it onto the sidebar. */}
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
            client={hostControl}
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
        client={hostControl}
        caps={caps}
        hasPrev={viewingIndex > 0}
        hasNext={viewingIndex >= 0 && viewingIndex < viewableRows.length - 1}
        relativePath={viewingEntry ? relativePath(viewingEntry.path) : ""}
        onNavigate={(delta) => {
          const next = viewableRows[viewingIndex + delta];
          if (next) {
            setViewing(next.entry.path);
            setSelected(next.entry.path);
          }
        }}
        onClose={() => setViewing(null)}
        onDownload={() => viewingEntry && void download(viewingEntry)}
        onReveal={() => viewingEntry && revealM.mutate(viewingEntry)}
        onOpenExternal={() => viewingEntry && openExternalM.mutate(viewingEntry)}
        onCopyPath={() => viewingEntry && void copyText(viewingEntry.path, "path")}
      />

      {/* Right-click context menu */}
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-44 overflow-y-auto overscroll-contain rounded-lg border border-popover-border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/50"
          style={menuCoords ?? { position: "fixed", visibility: "hidden" }}
          onClick={() => setMenu(null)}
        >
          {rowActions(menu.entry, menu.parentDir)}
        </div>
      )}

      {/* Status footer */}
      {(status || uploadingCount > 0) && (
        <div
          className="flex shrink-0 items-center gap-2 border-t border-border px-2 py-1 text-[11px] text-muted-foreground"
          role="status"
        >
          {uploadingCount > 0 && <Loader2 className="size-3 animate-spin" aria-hidden />}
          <span className="truncate">
            {uploadingCount > 0 ? `Uploading ${uploadingCount} file(s)...` : status}
          </span>
        </div>
      )}
    </div>
  );
});

function NewFolderRow({
  depth,
  draft,
  pathFlavor,
  setDraft,
  pending,
  onSubmit,
  onCancel,
}: {
  depth: number;
  draft: string;
  pathFlavor: PathFlavor;
  setDraft: (value: string) => void;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex h-7 items-center gap-1 pr-2"
      style={{ paddingLeft: 6 + depth * INDENT_PX + 14 }}
    >
      <Folder className="size-4 shrink-0 text-info" aria-hidden />
      <input
        ref={(el) => el?.focus()}
        aria-label="Folder name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          const name = pathFlavor === "windows" ? draft : draft.trim();
          if (e.key === "Enter" && isValidPathLeafName(name, pathFlavor)) onSubmit(name);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
        placeholder="folder name"
        className="h-5 min-w-0 flex-1 rounded border border-ring bg-background px-1 text-[13px] outline-none"
        disabled={pending}
      />
    </div>
  );
}
