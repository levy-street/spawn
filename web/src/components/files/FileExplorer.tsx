"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  ChevronRight,
  ChevronsDownUp,
  Copy,
  CornerUpLeft,
  Download,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useHostControl } from "@/hooks/useHostControl";
import { ApiError, hosts } from "@/lib/api";
import {
  unsignedHostControlDestination,
  useHostControlClientFactory,
} from "@/lib/host-control-trust";
import type { HostDirEntry, HostDirList } from "@/lib/hostControl";
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

function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
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

export function FileExplorer({
  hostId,
  rootPath,
  rootLabel,
  initialPath,
  dense = false,
  className,
}: {
  hostId: string;
  /** Directory the tree is rooted at; defaults to the daemon home dir. */
  rootPath?: string;
  rootLabel?: string;
  /** Deep link: ancestors are expanded and the entry selected once loaded. */
  initialPath?: string;
  dense?: boolean;
  className?: string;
}) {
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
  const transferControllersRef = useRef(new Set<AbortController>());
  const initialAppliedRef = useRef(false);
  const hostControlFactory = useHostControlClientFactory();
  const { client: hostControl, state: hostControlState } = useHostControl(hostId);
  const controlReady = hostControlState === "ready" && hostControl !== null;

  const rootQ = useQuery({
    queryKey: ["host-files", hostId, rootPath ?? ""],
    queryFn: () => hostControl!.listPage(rootPath),
    enabled: controlReady,
    gcTime: 0,
  });
  const resolvedRoot = rootQ.data?.path ?? rootPath ?? null;

  const childQs = useQueries({
    queries: expanded.map((path) => ({
      queryKey: ["host-files", hostId, path],
      queryFn: () => hostControl!.listPage(path),
      enabled: controlReady,
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

  // Deep link: expand every ancestor between the root and initialPath.
  useEffect(() => {
    if (initialAppliedRef.current || !initialPath || !resolvedRoot) return;
    if (initialPath === resolvedRoot || !initialPath.startsWith(`${resolvedRoot}/`)) {
      initialAppliedRef.current = true;
      return;
    }
    const rest = initialPath.slice(resolvedRoot.length).split("/").filter(Boolean);
    const ancestors: string[] = [];
    let acc = resolvedRoot;
    for (const part of rest) {
      acc = `${acc}/${part}`;
      ancestors.push(acc);
    }
    const available = Math.max(0, FILE_EXPLORER_RETAINED_PAGE_LIMIT - 1);
    setExpanded((current) => [...new Set([...current, ...ancestors])].slice(0, available));
    if (ancestors.length > available) {
      setStatus("File view limit reached before the full deep link could be expanded");
    }
    setSelected(initialPath);
    initialAppliedRef.current = true;
  }, [initialPath, resolvedRoot]);

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

  const toggleDir = useCallback(
    (path: string) => {
      if (expanded.includes(path)) {
        setExpanded((current) =>
          current.filter((entryPath) => entryPath !== path && !entryPath.startsWith(`${path}/`)),
        );
        setPageCursors((pages) =>
          Object.fromEntries(
            Object.entries(pages).filter(
              ([pagePath]) => pagePath !== path && !pagePath.startsWith(`${path}/`),
            ),
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
    [expanded, retainedPageCount],
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
      hostControl?.mkdir(`${dir}/${name}`) ?? Promise.reject(new Error("Host is not connected")),
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
          const oldPrefix = `${entry.path}/`;
          setExpanded((cur) =>
            cur.map((p) =>
              p === entry.path
                ? (result.path as string)
                : p.startsWith(oldPrefix)
                  ? `${result.path}${p.slice(entry.path.length)}`
                  : p,
            ),
          );
          setPageCursors((current) =>
            Object.fromEntries(
              Object.entries(current).map(([path, cursors]) => [
                path === entry.path
                  ? (result.path as string)
                  : path.startsWith(oldPrefix)
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
      setExpanded((cur) => cur.filter((p) => p !== entry.path && !p.startsWith(`${entry.path}/`)));
      setPageCursors((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([path]) => path !== entry.path && !path.startsWith(`${entry.path}/`),
          ),
        ),
      );
      if (selected === entry.path) setSelected(null);
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
      return (async () => {
        const destination = hostControlFactory.createClient(
          unsignedHostControlDestination(destHostId),
        );
        const operation = new AbortController();
        transferControllersRef.current.add(operation);
        const signal = AbortSignal.any([
          operation.signal,
          hostControl.getTrustSignal(),
          destination.getTrustSignal(),
        ]);
        try {
          await destination.waitUntilReady(undefined, signal);
          const home = await destination.home({ signal });
          return await hostControl.transferFileTo(
            destination,
            entry.path,
            destDir === "~" ? home.home_dir : destDir,
            false,
            signal,
          );
        } finally {
          transferControllersRef.current.delete(operation);
          destination.close();
        }
      })();
    },
    onSuccess: (result) => setStatus(`Sent to ${result.path ?? "destination host"}`),
    onError: (err) => setStatus(errorMessage(err)),
  });

  useEffect(() => {
    return () => {
      for (const controller of transferControllersRef.current) {
        controller.abort(new DOMException("File explorer unmounted", "AbortError"));
      }
      transferControllersRef.current.clear();
    };
  }, []);

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
      if (path === resolvedRoot) return ".";
      if (path.startsWith(`${resolvedRoot}/`)) return path.slice(resolvedRoot.length + 1);
      return path;
    },
    [resolvedRoot],
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
      if (row.entry.is_dir) toggleDir(row.entry.path);
      else void download(row.entry);
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
    setSelected(entry.path);
    setMenu({ x: event.clientX, y: event.clientY, entry, parentDir });
  };

  const rowActions = (entry: HostDirEntry, parentDir: string) => (
    <>
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

  const rootBusy = rootQ.isLoading;
  const label = rootLabel ?? (resolvedRoot ? baseName(resolvedRoot) : "files");

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* Header */}
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
      </div>

      {/* Tree */}
      <div
        ref={containerRef}
        role="tree"
        aria-label="Files"
        tabIndex={0}
        onKeyDown={onRowKeyDown}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring",
          dropDir && resolvedRoot === dropDir && "bg-primary/5",
        )}
        {...(resolvedRoot ? dropProps(resolvedRoot) : {})}
      >
        {rootBusy && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading...
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
                onClick={() => {
                  setSelected(entry.path);
                  if (isDir && !isRenaming) toggleDir(entry.path);
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
                    <FolderOpen className="z-10 size-4 shrink-0 text-sky-400" aria-hidden />
                  ) : (
                    <Folder className="z-10 size-4 shrink-0 text-sky-400" aria-hidden />
                  )
                ) : (
                  <File className="z-10 size-4 shrink-0 text-muted-foreground" aria-hidden />
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
                        const name = renameDraft.trim();
                        if (name && name !== entry.name) {
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
                        props.onClick();
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

      {/* Right-click context menu */}
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/40"
          style={{
            left: Math.min(
              menu.x,
              typeof window !== "undefined" ? window.innerWidth - 200 : menu.x,
            ),
            top: Math.min(
              menu.y,
              typeof window !== "undefined" ? window.innerHeight - 240 : menu.y,
            ),
          }}
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
}

function NewFolderRow({
  depth,
  draft,
  setDraft,
  pending,
  onSubmit,
  onCancel,
}: {
  depth: number;
  draft: string;
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
      <Folder className="size-4 shrink-0 text-sky-400" aria-hidden />
      <input
        ref={(el) => el?.focus()}
        aria-label="Folder name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) onSubmit(draft.trim());
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
