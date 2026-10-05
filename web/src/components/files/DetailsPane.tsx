"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, Files, Folder, X } from "lucide-react";
import { useEffect, useState } from "react";
import { FileIcon } from "@/components/files/file-icon";
import { itemCount } from "@/lib/files/copy";
import { formatSize, formatTimestamp } from "@/lib/files/format";
import { displayPath } from "@/lib/files/navigation";
import { kindLabel, typeLabel } from "@/lib/files/sort";
import type { HostControlClient, HostDirEntry } from "@/lib/hostControl";
import type { PathFlavor } from "@/lib/paths";
import { cn } from "@/lib/utils";

/**
 * The details pane (⌘I / Ctrl+I): what the selection is. One item is looked
 * up with `fs.stat` where the host offers it, so the pane says what the host
 * says now rather than what the listing said a poll ago; several items are
 * counted and their file sizes added up.
 *
 * The look-up waits for the selection to rest: holding ↓ through a folder
 * would otherwise send the host one request per row passed, ahead of the
 * listing polls on the same channel. Meanwhile the pane shows the listing.
 */

/** How long a single selection has to rest before the host is asked about it. */
export const STAT_SETTLE_MS = 250;

function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
export function DetailsPane({
  hostId,
  client,
  canStat,
  entries,
  folderName,
  folderCount,
  homeDir,
  flavor,
  onCopyPath,
  onClose,
  className,
}: {
  hostId: string;
  client: HostControlClient | null;
  canStat: boolean;
  /** The selection, in display order. */
  entries: readonly HostDirEntry[];
  /** With nothing selected the pane describes the folder itself. */
  folderName: string;
  folderCount: number;
  homeDir: string;
  flavor: PathFlavor;
  onCopyPath: (path: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const only = entries.length === 1 ? entries[0] : undefined;
  const settledPath = useSettled(only?.path ?? null, STAT_SETTLE_MS);
  const statQ = useQuery({
    queryKey: ["host-file-stat", hostId, only?.path ?? ""],
    queryFn: () => client!.stat(only!.path),
    enabled: Boolean(only && client && canStat && settledPath === only.path),
    staleTime: 5_000,
    gcTime: 30_000,
    retry: false,
  });
  const stat = only && statQ.data?.path === only.path ? statQ.data : null;

  const rows: Array<[string, string]> = [];
  let title = folderName;
  let icon = <Folder className="size-10 text-info" aria-hidden />;
  if (only) {
    title = only.name;
    icon = only.is_dir ? (
      <Folder className="size-10 text-info" aria-hidden />
    ) : (
      <FileIcon name={only.name} kind={only.kind} className="size-10 text-muted-foreground" />
    );
    rows.push(["Kind", kindLabel(only)]);
    if (!only.is_dir) {
      const size = stat?.size ?? only.size;
      if (size != null)
        rows.push(["Size", `${formatSize(size)} (${size.toLocaleString("en-US")} bytes)`]);
    }
    const modified = stat?.modified_at ?? only.modified_at;
    if (modified != null) rows.push(["Modified", formatTimestamp(modified)]);
    const type = typeLabel(only, stat);
    if (type) rows.push(["Type", type]);
    rows.push(["Where", displayPath(only.path, homeDir, flavor)]);
  } else if (entries.length > 1) {
    title = `${itemCount(entries.length)} selected`;
    icon = <Files className="size-10 text-muted-foreground" aria-hidden />;
    const files = entries.filter((entry) => !entry.is_dir);
    const bytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    rows.push(["Files", String(files.length)]);
    rows.push(["Folders", String(entries.length - files.length)]);
    if (files.length > 0) {
      rows.push([
        "Size",
        entries.length > files.length ? `${formatSize(bytes)} in files` : formatSize(bytes),
      ]);
    }
  } else {
    rows.push(["Contains", itemCount(folderCount)]);
  }

  return (
    <aside
      aria-label="Details"
      className={cn("flex min-h-0 w-72 shrink-0 flex-col border-l border-border", className)}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Details
        </span>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-2 pb-4 text-center">
          {icon}
          <p className="w-full break-words text-sm font-medium">{title}</p>
        </div>
        <dl className="space-y-2 text-xs">
          {rows.map(([term, value]) => (
            <div key={term} className="grid grid-cols-[5rem_1fr] gap-2">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
        {statQ.isError && only && (
          <p className="mt-3 text-xs text-muted-foreground">
            The host couldn't say more about this item right now.
          </p>
        )}
        {only && (
          <button
            type="button"
            onClick={() => onCopyPath(only.path)}
            className="mt-4 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Copy className="size-3.5" aria-hidden />
            Copy path
          </button>
        )}
      </div>
    </aside>
  );
}
