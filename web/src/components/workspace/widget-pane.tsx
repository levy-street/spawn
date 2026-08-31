"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronsDownUp,
  Copy,
  Ellipsis,
  Folder,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { FileExplorer, type FileExplorerHandle } from "@/components/files/FileExplorer";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { hosts } from "@/lib/api";
import type { Tile, TileWidget } from "@/lib/grid";
import { basename } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { FolderPicker } from "./folder-picker";

export function widgetTitle(widget: TileWidget): string {
  return `Files — ${basename(widget.path) || widget.path}`;
}

/**
 * A non-session pane: same chrome as a shell pane (drag the title bar, the
 * grid's edge resize handles, remove from the menu) wrapped around widget
 * content.
 */
export function WidgetPane({
  tile,
  widget,
  focused,
  paneCount,
  canDrag,
  canDuplicate = false,
  onFocus,
  onMoveStart,
  onExpand,
  onDuplicate,
  onChangePath,
  onRemove,
}: {
  tile: Tile;
  widget: TileWidget;
  focused: boolean;
  paneCount: number;
  canDrag: boolean;
  /** False when the tab is full. */
  canDuplicate?: boolean;
  onFocus: (tileId: string) => void;
  onMoveStart: (tileId: string, event: ReactPointerEvent<HTMLElement>) => void;
  /** Fill the empty grid space around this pane (desktop grid only). */
  onExpand?: (tileId: string) => void;
  /** Add a second explorer on the same host and path. */
  onDuplicate?: (tileId: string) => void;
  /** Re-root this explorer at another folder on the same host. */
  onChangePath?: (tileId: string, path: string) => void;
  onRemove: (tileId: string) => void;
}) {
  const id = tile.session_id;
  const title = widgetTitle(widget);
  const explorerRef = useRef<FileExplorerHandle>(null);
  const folderChipRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 30_000 });
  const paneHost = (hostsQ.data ?? []).find((host) => host.id === widget.host_id) ?? null;
  return (
    <section
      aria-label={title}
      onPointerDownCapture={() => onFocus(id)}
      className="relative isolate flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    >
      {/* Same focus language as session panes: the focused pane is untouched,
          every other one has its ground blended halfway toward `--shell` while
          its content keeps its contrast — see session-pane.tsx. */}
      {!focused && paneCount > 1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 bg-shell/50 mix-blend-darken dark:mix-blend-lighten"
        />
      )}
      <header
        role="toolbar"
        aria-label={`${title} window controls`}
        title={canDrag ? "Drag to move · Double-click to fill empty space" : undefined}
        className={cn(
          "flex h-9 shrink-0 items-center gap-2 border-b border-pane-divider bg-card/75 px-2 select-none",
          canDrag && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={(event) => {
          if ((event.target as Element).closest?.("button, input, a")) return;
          onMoveStart(id, event);
        }}
        onDoubleClick={(event) => {
          if ((event.target as Element).closest?.("button, input, a")) return;
          onExpand?.(id);
        }}
      >
        {/* The pane's folder, as a control — the same chip a shell pane wears,
            so "where am I, and how do I go somewhere else" is answered the same
            way whatever the pane holds. The full path stays in the title. */}
        <button
          ref={folderChipRef}
          type="button"
          aria-label="Change folder"
          aria-expanded={pickerOpen}
          title={widget.path}
          disabled={!onChangePath}
          onClick={() => setPickerOpen((value) => !value)}
          className="mr-auto flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none"
        >
          <Folder className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate font-medium text-foreground">
            {basename(widget.path) || widget.path}
          </span>
          {onChangePath && <ChevronDown className="size-3 shrink-0" aria-hidden />}
        </button>
        <DropdownMenu
          align="end"
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`${title} options`}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Ellipsis className="size-4" aria-hidden />
            </button>
          )}
        >
          <DropdownMenuItem onSelect={() => explorerRef.current?.newFolder()}>
            <FolderPlus className="size-4" aria-hidden />
            New folder
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => explorerRef.current?.upload()}>
            <Upload className="size-4" aria-hidden />
            Upload files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => explorerRef.current?.refresh()}>
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => explorerRef.current?.collapseAll()}>
            <ChevronsDownUp className="size-4" aria-hidden />
            Collapse all
          </DropdownMenuItem>
          {onDuplicate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!canDuplicate} onSelect={() => onDuplicate(id)}>
                <Copy className="size-4" aria-hidden />
                Duplicate
                <span className="ml-auto shrink-0 pl-3 text-xs tracking-wide text-muted-foreground">
                  ⌘/⌥ drag
                </span>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => onRemove(id)}>
            <Trash2 className="size-4" aria-hidden />
            Close
          </DropdownMenuItem>
        </DropdownMenu>
        {/* Closing has its own control, at the far right where a window's
            close has always been — the same cluster a shell pane ends its
            header with. A widget is pure layout with no process to kill, so
            the X needs no ceremony and just takes the pane out. */}
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={() => onRemove(id)}
          className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </header>

      {onChangePath && (
        <FolderPicker
          key={`${widget.host_id}:${pickerOpen ? "open" : "closed"}`}
          open={pickerOpen}
          host={paneHost}
          initialPath={widget.path}
          anchorRef={folderChipRef}
          onOpenChange={setPickerOpen}
          onSelect={(path) => {
            setPickerOpen(false);
            if (path !== widget.path) onChangePath(id, path);
          }}
        />
      )}

      <FileExplorer
        ref={explorerRef}
        key={`${widget.host_id}:${widget.path}`}
        hostId={widget.host_id}
        rootPath={widget.path}
        dense
        hideHeader
        className="min-h-0 flex-1"
      />
    </section>
  );
}
