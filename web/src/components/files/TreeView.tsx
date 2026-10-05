"use client";

import { ChevronRight, Folder, FolderOpen, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type { DragEvent, MouseEvent, ReactNode } from "react";
import { FileIcon } from "@/components/files/file-icon";
import { HighlightedName } from "@/components/files/file-name";
import { formatSize } from "@/lib/files/format";
import type { HostDirEntry } from "@/lib/hostControl";
import { cn } from "@/lib/utils";

export const TREE_INDENT_PX = 12;

/** Decorative guides down the left edge, one per level. */
function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
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
          style={{ width: TREE_INDENT_PX }}
        />
      ))}
    </span>
  );
}

/** One entry of the tree view. */
export function TreeEntryRow({
  id,
  top,
  height,
  depth,
  entry,
  expanded,
  loadingChildren,
  selected,
  focused,
  dropTarget,
  dense,
  query,
  rename,
  menu,
  onClick,
  onDoubleClick,
  onContextMenu,
  onPointerEnter,
  dropProps,
}: {
  id: string;
  top: number;
  height: number;
  depth: number;
  entry: HostDirEntry;
  expanded: boolean;
  loadingChildren: boolean;
  selected: boolean;
  focused: boolean;
  dropTarget: boolean;
  dense: boolean;
  query: string;
  rename: ReactNode | null;
  menu: ReactNode;
  onClick: (event: MouseEvent) => void;
  onDoubleClick: (event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
  onPointerEnter: () => void;
  dropProps?: {
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
}) {
  const isDir = entry.is_dir === true;
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the tree, which names the focused item with aria-activedescendant
    <div
      id={id}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={isDir ? expanded : undefined}
      data-path={entry.path}
      className={cn(
        "group/filerow absolute inset-x-0 flex cursor-default select-none items-center gap-1 pr-8",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
        focused && "outline outline-1 -outline-offset-1 outline-ring/60",
        dropTarget && "bg-primary/10 outline outline-1 outline-primary",
      )}
      style={{ top, height, paddingLeft: 6 + depth * TREE_INDENT_PX }}
      onClick={(event) => {
        // A portalled menu's clicks bubble through the React tree; only a
        // click that physically landed in this row is a click on it.
        if (!event.currentTarget.contains(event.target as Node)) return;
        onClick(event);
      }}
      onDoubleClick={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        onDoubleClick(event);
      }}
      onContextMenu={onContextMenu}
      onPointerEnter={onPointerEnter}
      {...dropProps}
    >
      <IndentGuides depth={depth} />
      {isDir ? (
        <ChevronRight
          className={cn(
            "z-10 size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      ) : (
        <span className="z-10 size-3.5 shrink-0" aria-hidden />
      )}
      {isDir ? (
        expanded ? (
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
      {rename ?? (
        <HighlightedName
          name={entry.name}
          query={query}
          className="z-10 min-w-0 flex-1 text-[13px]"
        />
      )}
      {loadingChildren && (
        <Loader2 className="z-10 size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      )}
      {!dense && !isDir && (
        <span className="z-10 hidden shrink-0 pr-1 text-[11px] tabular-nums text-muted-foreground sm:block">
          {formatSize(entry.size)}
        </span>
      )}
      {menu}
    </div>
  );
}

/**
 * A folder still loading, failed, cut short by the host's cap, or changed on
 * the host in a way its first page cannot show (Refresh reads it again).
 */
export function TreeStatusRow({
  top,
  height,
  depth,
  state,
  message,
  detail,
  onRetry,
}: {
  top: number;
  height: number;
  depth: number;
  state: "loading" | "error" | "truncated" | "changed";
  message: string;
  /** The longer explanation, on hover. */
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="none"
      className={cn(
        "absolute inset-x-0 flex items-center gap-1.5 pr-2 text-xs",
        state === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ top, height, paddingLeft: 20 + depth * TREE_INDENT_PX }}
      title={detail}
    >
      {state === "loading" && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
      {state === "truncated" && (
        <TriangleAlert className="size-3 shrink-0 text-warning" aria-hidden />
      )}
      {state === "changed" && <RefreshCw className="size-3 shrink-0 text-info" aria-hidden />}
      <span className="min-w-0 truncate" role={state === "error" ? "alert" : undefined}>
        {message}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded px-1 font-medium text-foreground underline underline-offset-2 hover:bg-accent"
        >
          {state === "changed" ? "Refresh" : "Retry"}
        </button>
      )}
    </div>
  );
}
