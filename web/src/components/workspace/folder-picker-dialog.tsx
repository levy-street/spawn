"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderPlus, Home, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useHostControl } from "@/hooks/useHostControl";
import type { Host } from "@/lib/api";
import { normalizeCwdForHost, parentDir } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { breadcrumbParts, joinDirectory } from "./folder-picker-helpers";

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
  const [pathDraft, setPathDraft] = useState("~");
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const selectedRef = useRef<HTMLButtonElement>(null);

  const homeQ = useQuery({
    queryKey: ["host-home", host?.id],
    queryFn: () => client!.home(),
    enabled: open && state === "ready" && client !== null,
    staleTime: 5 * 60_000,
  });
  const homeDir = homeQ.data?.home_dir ?? null;

  useEffect(() => {
    if (!open || !homeDir || path !== "~") return;
    const resolved = normalizeCwdForHost("~", homeDir);
    setPath(resolved);
    setPathDraft(resolved);
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

  const directories = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return (dirsQ.data?.entries ?? [])
      .filter((entry) => entry.is_dir)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .filter((entry) => !needle || entry.name.toLocaleLowerCase().includes(needle));
  }, [dirsQ.data?.entries, filter]);

  const navigate = (value: string) => {
    if (!homeDir) return;
    const next = normalizeCwdForHost(value, homeDir);
    setPath(next);
    setPathDraft(next);
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
      <DialogContent size="full-mobile" className="min-h-0">
        <DialogHeader>
          <DialogTitle>Select a folder on {host?.name ?? "host"}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-3">
          <nav
            aria-label="Folder breadcrumbs"
            className="flex min-h-9 shrink-0 items-center overflow-x-auto rounded-md border border-border bg-muted/35 px-1"
          >
            {breadcrumbs.map((item, index) => (
              <span key={item.path} className="inline-flex shrink-0 items-center">
                {index > 0 && <ChevronRight className="size-3 text-muted-foreground" aria-hidden />}
                <button
                  type="button"
                  onClick={() => navigate(item.path)}
                  className="inline-flex h-8 max-w-40 items-center gap-1 truncate rounded px-2 text-xs hover:bg-accent"
                >
                  {index === 0 && <Home className="size-3" aria-hidden />}
                  {item.label}
                </button>
              </span>
            ))}
          </nav>

          <form
            className="flex shrink-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(pathDraft);
            }}
          >
            <Input
              aria-label="Folder path"
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Button type="submit" variant="outline" disabled={!homeDir}>
              Go
            </Button>
          </form>

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
              <div className="grid min-h-36 place-items-center p-6 text-center text-sm text-muted-foreground">
                {filter ? "No folders match this filter." : "This folder has no subfolders."}
              </div>
            ) : (
              directories.map((entry, index) => (
                <button
                  key={entry.path}
                  ref={index === selectedIndex ? selectedRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseMove={() => selectIndex(index)}
                  onDoubleClick={() => navigate(entry.path)}
                  onClick={() => selectIndex(index)}
                  className={cn(
                    "flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
                    index === selectedIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
              ))
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
