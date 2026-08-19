"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  CornerLeftUp,
  Ellipsis,
  Folder,
  FolderPlus,
  Home,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useHostControl } from "@/hooks/useHostControl";
import type { Host } from "@/lib/api";
import type { HostControlClient } from "@/lib/hostControl";
import { normalizeCwdForHost, parentDir } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { breadcrumbParts, joinDirectory, visibleDirectories } from "./folder-picker-helpers";

const SHOW_HIDDEN_KEY = "spawn.folderPicker.showHidden";

export function FolderPickerDialog({
  open,
  host,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  host: Host | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const { client, state } = useHostControl(host?.id ?? null, open && host?.status === "online");
  const [path, setPath] = useState("~");
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Read after mount rather than in the initial state so a server render and
  // the first client render agree.
  useEffect(() => {
    setShowHidden(window.localStorage.getItem(SHOW_HIDDEN_KEY) === "true");
  }, []);

  const toggleHidden = () => {
    setShowHidden((value) => {
      window.localStorage.setItem(SHOW_HIDDEN_KEY, String(!value));
      return !value;
    });
    setSelectedIndex(0);
  };

  const homeQ = useQuery({
    queryKey: ["host-home", host?.id],
    queryFn: () => client!.home(),
    enabled: open && state === "ready" && client !== null,
    staleTime: 5 * 60_000,
  });
  const homeDir = homeQ.data?.home_dir ?? null;

  useEffect(() => {
    if (!open || !homeDir || path !== "~") return;
    setPath(normalizeCwdForHost("~", homeDir));
  }, [homeDir, open, path]);

  const resolvedPath = homeDir && path.startsWith("~") ? normalizeCwdForHost(path, homeDir) : path;
  const dirsQ = useQuery({
    queryKey: ["host-folders", host?.id, resolvedPath],
    queryFn: () => client!.list(resolvedPath),
    enabled:
      open &&
      state === "ready" &&
      client !== null &&
      Boolean(homeDir) &&
      resolvedPath.startsWith("/"),
    staleTime: 5_000,
  });

  const directories = useMemo(
    () => visibleDirectories(dirsQ.data?.entries, { filter, showHidden }),
    [dirsQ.data?.entries, filter, showHidden],
  );

  const hiddenCount = useMemo(
    () =>
      showHidden
        ? 0
        : (dirsQ.data?.entries ?? []).filter((entry) => entry.is_dir && entry.name.startsWith("."))
            .length,
    [dirsQ.data?.entries, showHidden],
  );

  const navigate = (value: string) => {
    if (!homeDir) return;
    setPath(normalizeCwdForHost(value, homeDir));
    setFilter("");
    setSelectedIndex(0);
  };

  const selectIndex = (index: number) => {
    setSelectedIndex(index);
    requestAnimationFrame(() => selectedRef.current?.scrollIntoView({ block: "nearest" }));
  };

  const mkdirM = useMutation({
    mutationFn: (name: string) => client!.mkdir(joinDirectory(resolvedPath, name)),
    onSuccess: (_, name) => {
      setCreatingFolder(false);
      setFolderName("");
      void dirsQ.refetch();
      requestAnimationFrame(() => {
        const index = directories.findIndex((entry) => entry.name === name);
        if (index >= 0) setSelectedIndex(index);
      });
    },
  });

  const submitFolder = () => {
    const name = folderName.trim();
    if (!name || name === "." || name === ".." || name.includes("/")) return;
    mkdirM.mutate(name);
  };

  const loading = state !== "ready" || homeQ.isLoading || dirsQ.isLoading;
  const breadcrumbs = breadcrumbParts(resolvedPath.startsWith("/") ? resolvedPath : "/");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="full-mobile"
        className="min-h-0"
        // The breadcrumb and options menus render in a body portal, so Radix
        // sees them as "outside" the dialog; without this, picking from one
        // would dismiss the picker.
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[role='menu']")) event.preventDefault();
        }}
        // Escape with a menu open closes the menu, not the picker.
        onEscapeKeyDown={(event) => {
          if (document.querySelector("[role='menu']")) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Select a folder on {host?.name ?? "host"}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-3">
          <div className="flex min-h-9 shrink-0 items-center rounded-md border border-border bg-muted/35 pr-1">
            <nav
              aria-label="Folder breadcrumbs"
              className="flex min-w-0 flex-1 items-center overflow-x-auto px-1"
            >
              {breadcrumbs.map((item, index) => (
                <span key={item.path} className="inline-flex shrink-0 items-center">
                  <button
                    type="button"
                    onClick={() => navigate(item.path)}
                    className="inline-flex h-8 max-w-40 items-center gap-1 truncate rounded px-2 text-xs hover:bg-accent"
                  >
                    {index === 0 && <Home className="size-3" aria-hidden />}
                    {item.label}
                  </button>
                  <CrumbDrillMenu
                    hostId={host?.id ?? null}
                    client={state === "ready" ? client : null}
                    dirPath={item.path}
                    activeChild={breadcrumbs[index + 1]?.path ?? null}
                    showHidden={showHidden}
                    onNavigate={navigate}
                  />
                </span>
              ))}
            </nav>
            <DropdownMenu
              className="shrink-0"
              renderTrigger={(props) => (
                <Button
                  {...props}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Folder list options"
                >
                  <Ellipsis className="size-4" aria-hidden />
                </Button>
              )}
            >
              <DropdownMenuItem checked={showHidden} onSelect={toggleHidden}>
                Show hidden folders
              </DropdownMenuItem>
            </DropdownMenu>
          </div>

          <div className="relative shrink-0">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              aria-label="Filter folders"
              placeholder="Filter folders"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setSelectedIndex(0);
              }}
              className="h-9 pl-9"
            />
          </div>

          <div
            role="listbox"
            aria-label={`Folders in ${resolvedPath}`}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                selectIndex(Math.min(directories.length - 1, selectedIndex + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                selectIndex(Math.max(0, selectedIndex - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const selected = directories[selectedIndex];
                if (selected) navigate(selected.path);
              } else if (event.key === "Backspace" && filter === "") {
                event.preventDefault();
                navigate(dirsQ.data?.parent ?? parentDir(resolvedPath));
              }
            }}
            className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card/35 p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {loading ? (
              <div className="space-y-1 p-1">
                {["one", "two", "three", "four", "five", "six", "seven"].map((key) => (
                  <Skeleton key={key} className="h-10 w-full" />
                ))}
              </div>
            ) : dirsQ.isError ? (
              <div className="grid min-h-36 place-items-center p-6 text-center text-sm text-destructive">
                {dirsQ.error instanceof Error ? dirsQ.error.message : "Could not list this folder."}
              </div>
            ) : directories.length === 0 ? (
              <>
                {resolvedPath !== "/" && filter === "" && (
                  <ParentFolderRow
                    onNavigate={() => navigate(dirsQ.data?.parent ?? parentDir(resolvedPath))}
                  />
                )}
                <div className="grid min-h-36 place-items-center p-6 text-center text-sm text-muted-foreground">
                  {filter
                    ? "No folders match this filter."
                    : hiddenCount > 0
                      ? `Only hidden folders here — turn on “Show hidden folders” to see ${hiddenCount === 1 ? "it" : "them"}.`
                      : "This folder has no subfolders."}
                </div>
              </>
            ) : (
              <>
                {resolvedPath !== "/" && filter === "" && (
                  <ParentFolderRow
                    onNavigate={() => navigate(dirsQ.data?.parent ?? parentDir(resolvedPath))}
                  />
                )}
                {directories.map((entry, index) => (
                  <button
                    key={entry.path}
                    ref={index === selectedIndex ? selectedRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    onMouseMove={() => selectIndex(index)}
                    onClick={() => navigate(entry.path)}
                    className={cn(
                      "flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
                      index === selectedIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/60",
                    )}
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <ChevronRight
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground",
                        index === selectedIndex ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </button>
                ))}
              </>
            )}
          </div>

          {creatingFolder && (
            <form
              className="flex shrink-0 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submitFolder();
              }}
            >
              <Input
                autoFocus
                aria-label="New folder name"
                placeholder="New folder name"
                value={folderName}
                disabled={mkdirM.isPending}
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setCreatingFolder(false);
                }}
              />
              <Button type="submit" disabled={!folderName.trim() || mkdirM.isPending}>
                Create
              </Button>
            </form>
          )}
          {mkdirM.isError && (
            <p className="text-xs text-destructive" role="alert">
              {mkdirM.error instanceof Error
                ? mkdirM.error.message
                : "Could not create the folder."}
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-border pt-3">
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            disabled={!client || state !== "ready"}
            onClick={() => setCreatingFolder((value) => !value)}
          >
            <FolderPlus className="size-4" aria-hidden />
            New folder
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!homeDir || !resolvedPath.startsWith("/")}
            onClick={() => {
              onSelect(resolvedPath);
              onOpenChange(false);
            }}
          >
            Select this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DrillProps = {
  hostId: string | null;
  client: HostControlClient | null;
  dirPath: string;
  activeChild: string | null;
  showHidden: boolean;
  onNavigate: (path: string) => void;
};

/**
 * The chevron after each breadcrumb: opens that crumb's subfolders so you can
 * descend from any level of the path, Finder-style, without walking back down
 * through the list.
 */

/** The ".." row: always first in the list, steps up to the parent folder. */
function ParentFolderRow({ onNavigate }: { onNavigate: () => void }) {
  return (
    <button
      type="button"
      aria-label="Parent folder"
      onClick={onNavigate}
      className="flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
    >
      <CornerLeftUp className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">..</span>
    </button>
  );
}

function CrumbDrillMenu({ dirPath, client, ...rest }: DrillProps) {
  return (
    <DropdownMenu
      align="start"
      className="shrink-0"
      menuClassName="max-h-72 min-w-52 max-w-72 overflow-y-auto"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          disabled={!client}
          aria-label={`Browse ${dirPath}`}
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none"
        >
          <ChevronRight className="size-3" aria-hidden />
        </button>
      )}
    >
      <CrumbDrillItems dirPath={dirPath} client={client} {...rest} />
    </DropdownMenu>
  );
}

/** Only mounted while the menu is open, so the listing is fetched on demand. */
function CrumbDrillItems({
  hostId,
  client,
  dirPath,
  activeChild,
  showHidden,
  onNavigate,
}: DrillProps) {
  const foldersQ = useQuery({
    queryKey: ["host-folders", hostId, dirPath],
    queryFn: () => client!.list(dirPath),
    enabled: client !== null,
    staleTime: 5_000,
  });
  const folders = visibleDirectories(foldersQ.data?.entries, { showHidden });

  if (foldersQ.isPending) {
    return (
      <div className="flex h-9 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (foldersQ.isError) {
    return <p className="px-2 py-1.5 text-xs text-destructive">Could not list this folder.</p>;
  }
  if (folders.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No subfolders</p>;
  }
  return (
    <>
      {folders.map((entry) => (
        <DropdownMenuItem key={entry.path} onSelect={() => onNavigate(entry.path)}>
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {entry.path === activeChild && <Check className="size-3.5 shrink-0" aria-hidden />}
        </DropdownMenuItem>
      ))}
    </>
  );
}
