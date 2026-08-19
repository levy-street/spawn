"use client";

import {
  ChevronsDownUp,
  Ellipsis,
  FolderPlus,
  FolderTree,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import { FileExplorer, type FileExplorerHandle } from "@/components/files/FileExplorer";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Tile, TileWidget } from "@/lib/grid";
import { basename } from "@/lib/paths";
import { cn } from "@/lib/utils";

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
  onFocus,
  onToggleZoom,
  onMoveStart,
  onRemove,
}: {
  tile: Tile;
  widget: TileWidget;
  focused: boolean;
  paneCount: number;
  canDrag: boolean;
  onFocus: (tileId: string) => void;
  onToggleZoom: (tileId: string) => void;
  onMoveStart: (tileId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onRemove: (tileId: string) => void;
}) {
  const id = tile.session_id;
  const title = widgetTitle(widget);
  const explorerRef = useRef<FileExplorerHandle>(null);
  return (
    <section
      aria-label={title}
      onPointerDownCapture={() => onFocus(id)}
      className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    >
      {/* Same focus language as session panes: the focused pane is untouched,
          every other one is washed down — black in dark, toward the near-black
          foreground in light — so it recedes. */}
      {!focused && paneCount > 1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 bg-foreground/[0.035] dark:bg-black/25"
        />
      )}
      <header
        role="toolbar"
        aria-label={`${title} pane controls`}
        title={canDrag ? "Drag to move" : undefined}
        className={cn(
          "flex h-9 shrink-0 items-center gap-2 border-b border-pane-divider bg-card/75 px-2 select-none",
          canDrag && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={(event) => {
          if ((event.target as Element).closest?.("button, input, a")) return;
          onMoveStart(id, event);
        }}
        onDoubleClick={() => onToggleZoom(id)}
      >
        <FolderTree className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {widget.path}
        </span>
        <DropdownMenu
          align="end"
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`${title} options`}
              onDoubleClick={(event) => event.stopPropagation()}
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
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => onRemove(id)}>
            <Trash2 className="size-4" aria-hidden />
            Close
          </DropdownMenuItem>
        </DropdownMenu>
      </header>

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
