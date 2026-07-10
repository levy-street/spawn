"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRightLeft,
  ArrowUp,
  Download,
  File,
  Folder,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useRef, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/agents";
import { ApiError, agents, type HostDirEntry, hosts } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function HostFilesPage() {
  return (
    <AuthGate>
      <AppShell>
        <Suspense fallback={null}>
          <HostFiles />
        </Suspense>
      </AppShell>
    </AuthGate>
  );
}

function formatSize(size: number | null | undefined): string {
  if (size == null) return "—";
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

function formatModified(epoch: number | null | undefined): string {
  if (!epoch) return "—";
  return relativeTime(new Date(epoch * 1000).toISOString()) ?? "—";
}

/** Breadcrumb segments for a path, collapsing everything under home to `~`. */
function crumbsFor(path: string, homeDir: string | null | undefined) {
  const crumbs: Array<{ label: string; path: string }> = [];
  let rest = path;
  if (homeDir && (path === homeDir || path.startsWith(`${homeDir}/`))) {
    crumbs.push({ label: "~", path: homeDir });
    rest = path.slice(homeDir.length);
  } else {
    crumbs.push({ label: "/", path: "/" });
  }
  let acc = crumbs[0].path === "/" ? "" : crumbs[0].path;
  for (const part of rest.split("/").filter(Boolean)) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : String(err);
}

function HostFiles() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const searchParams = useSearchParams();
  const path = searchParams?.get("path") ?? undefined;
  const qc = useQueryClient();

  const [status, setStatus] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragDepth, setDragDepth] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hostQ = useQuery({
    queryKey: ["host", id],
    queryFn: () => hosts.get(id as string),
    enabled: !!id,
  });
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const listingQ = useQuery({
    queryKey: ["host-files", id, path ?? ""],
    queryFn: () => hosts.files(id as string, path),
    enabled: !!id,
  });

  const listing = listingQ.data;
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: () => agents.list() });
  const cwd = listing?.path ?? path ?? "";

  const navigate = useCallback(
    (nextPath: string) => {
      setStatus(null);
      router.push(`/hosts/${id}/files?path=${encodeURIComponent(nextPath)}`);
    },
    [id, router],
  );

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["host-files", id] });
  }, [id, qc]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!id || !cwd || files.length === 0) return;
      setStatus(null);
      setUploading((current) => [...current, ...files.map((f) => f.name || "file")]);
      for (const file of files) {
        try {
          const result = await hosts.uploadFile(id, file, { dir: cwd });
          setStatus(`Uploaded ${result.path ?? file.name}`);
        } catch (err) {
          setStatus(`${file.name || "File"}: ${errorMessage(err)}`);
        } finally {
          setUploading((current) => {
            const next = [...current];
            next.splice(next.indexOf(file.name || "file"), 1);
            return next;
          });
        }
      }
      refresh();
    },
    [cwd, id, refresh],
  );

  const mkdirM = useMutation({
    mutationFn: (name: string) => hosts.mkdir(id as string, `${cwd}/${name}`),
    onSuccess: () => {
      setCreatingFolder(false);
      setFolderName("");
      refresh();
    },
    onError: (err) => setStatus(errorMessage(err)),
  });

  const deleteM = useMutation({
    mutationFn: (entry: HostDirEntry) =>
      hosts.deleteFile(id as string, { path: entry.path, recursive: entry.is_dir === true }),
    onSuccess: (_, entry) => {
      setStatus(`Deleted ${entry.name}`);
      refresh();
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
    }) =>
      hosts.transferFile(id as string, {
        path: entry.path,
        dest_host_id: destHostId,
        dest_dir: destDir,
      }),
    onSuccess: (result) => setStatus(`Sent to ${result.path ?? "destination host"}`),
    onError: (err) => setStatus(errorMessage(err)),
  });

  const download = useCallback(
    async (entry: HostDirEntry) => {
      setStatus(`Downloading ${entry.name}...`);
      try {
        const blob = await hosts.downloadFile(id as string, entry.path);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.name;
        a.click();
        URL.revokeObjectURL(url);
        setStatus(null);
      } catch (err) {
        setStatus(`${entry.name}: ${errorMessage(err)}`);
      }
    },
    [id],
  );

  const otherHosts = (hostsQ.data ?? []).filter((h) => h.id !== id);
  const host = hostQ.data;
  const offline = host?.status === "offline";
  const crumbs = listing ? crumbsFor(listing.path, listing.home_dir) : [];
  const agentsHere = (agentsQ.data ?? []).filter(
    (a) => a.host_id === id && a.status === "running" && a.cwd === cwd,
  );

  if (!id) return null;

  return (
    <div className="mx-auto w-full max-w-3xl p-4 @md/shell:p-6">
      <header className="mb-4 flex items-center gap-2">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Back to host"
        >
          <Link href={`/hosts/${id}`}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight">
            Files{host ? ` · ${host.name}` : ""}
          </h1>
        </div>
        {host &&
          (offline ? (
            <Badge variant="outline">offline</Badge>
          ) : (
            <Badge variant="success">online</Badge>
          ))}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Refresh"
          onClick={refresh}
        >
          <RefreshCw className={cn("size-4", listingQ.isFetching && "animate-spin")} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setCreatingFolder(true)}
          disabled={!listing || offline}
        >
          <FolderPlus className="size-4" />
          <span className="hidden sm:inline">New folder</span>
        </Button>
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={!listing || offline}
        >
          <Upload className="size-4" />
          <span className="hidden sm:inline">Upload</span>
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload files"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void uploadFiles(files);
          }}
        />
      </header>

      {/* Breadcrumbs */}
      <nav aria-label="Path" className="mb-3 flex min-w-0 items-center gap-1 text-sm">
        {listing?.parent && listing.parent !== listing.path && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Up one level"
            onClick={() => navigate(listing.parent as string)}
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
        <ol className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-xs">
          {crumbs.map((crumb, i) => (
            <li key={crumb.path} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/50">/</span>}
              <button
                type="button"
                onClick={() => navigate(crumb.path)}
                className={cn(
                  "max-w-40 truncate rounded px-1 py-0.5 hover:bg-accent",
                  i === crumbs.length - 1
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {crumb.label}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {status && (
        <p className="mb-3 break-all text-sm text-muted-foreground" role="status">
          {status}
        </p>
      )}
      {uploading.length > 0 && (
        <p className="mb-3 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Uploading {uploading.join(", ")}...
        </p>
      )}
      {listingQ.error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {errorMessage(listingQ.error)}
        </p>
      )}
      {listing?.error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {listing.error}
        </p>
      )}

      {creatingFolder && (
        <form
          className="mb-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = folderName.trim();
            if (name) mkdirM.mutate(name);
          }}
        >
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Folder name"
            autoFocus
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCreatingFolder(false);
            }}
            placeholder="folder name"
            className="h-8 max-w-56"
            disabled={mkdirM.isPending}
          />
          <Button type="submit" size="sm" disabled={!folderName.trim() || mkdirM.isPending}>
            Create
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCreatingFolder(false)}>
            Cancel
          </Button>
        </form>
      )}

      {listingQ.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      )}

      {listing && (
        <section
          aria-label="Files"
          className={cn(
            "overflow-hidden rounded-xl border border-border",
            dragDepth > 0 && "border-primary bg-primary/5",
          )}
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes("Files")) setDragDepth((d) => d + 1);
          }}
          onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragDepth(0);
            void uploadFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {listing.entries.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Empty directory. Drop files here to upload.
            </div>
          )}
          <ul>
            {listing.entries.map((entry) => {
              const isDir = entry.is_dir === true;
              return (
                <li
                  key={entry.path}
                  className="group/filerow relative border-b border-border last:border-b-0"
                >
                  <div className="flex items-center gap-3 px-3 py-2 pr-11 transition-colors hover:bg-accent/40">
                    {isDir ? (
                      <Folder className="size-4 shrink-0 text-sky-400" aria-hidden />
                    ) : (
                      <File className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    {isDir ? (
                      <button
                        type="button"
                        onClick={() => navigate(entry.path)}
                        className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
                      >
                        {entry.name}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
                    )}
                    <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                      {isDir ? "—" : formatSize(entry.size)}
                    </span>
                    <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:block">
                      {formatModified(entry.modified_at)}
                    </span>
                  </div>
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
                    <DropdownMenu
                      renderTrigger={(props) => (
                        <Button
                          {...props}
                          variant="ghost"
                          size="icon"
                          className="size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/filerow:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
                          aria-label={`${entry.name} actions`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      )}
                    >
                      {!isDir && (
                        <DropdownMenuItem onSelect={() => void download(entry)}>
                          <Download className="size-4" aria-hidden />
                          Download
                        </DropdownMenuItem>
                      )}
                      {!isDir && otherHosts.length > 0 && (
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
                                  destDir: other.home_dir ?? "~",
                                })
                              }
                            >
                              <ArrowRightLeft className="size-4" aria-hidden />
                              {other.name}
                              {other.status !== "online" && (
                                <span className="ml-auto text-[11px] text-muted-foreground">
                                  offline
                                </span>
                              )}
                            </DropdownMenuItem>
                          ))}
                        </>
                      )}
                      {!isDir && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        destructive
                        onSelect={() => {
                          const detail = isDir ? `${entry.name} and everything in it` : entry.name;
                          if (confirm(`Delete ${detail}?`)) deleteM.mutate(entry);
                        }}
                      >
                        <Trash2 className="size-4" aria-hidden />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {agentsHere.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Agents in this directory:{" "}
          {agentsHere.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ", "}
              <Link href={`/agents/${a.id}`} className="underline underline-offset-2">
                {a.name ?? a.tmux_session ?? a.id.slice(0, 8)}
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
