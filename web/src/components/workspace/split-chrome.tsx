"use client";

import {
  Archive,
  ChevronDown,
  ImagePlus,
  PanelLeftClose,
  PanelRightClose,
  Pencil,
  Trash2,
  Unlink,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { WorkspaceAvatar } from "@/components/nav/sidebar-parts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { SplitSide } from "@/lib/split-store";
import { cn } from "@/lib/utils";

/**
 * The two ends a tab strip grows when its window holds two workspaces: which
 * workspace this strip is showing, and the way back to one.
 *
 * Passed as a single optional prop rather than a handful of them so that the
 * ordinary window — the overwhelmingly common one — says nothing about split
 * view at all, and the strip it renders is the strip it has always rendered.
 */
export interface SplitChrome {
  workspaceName: string;
  workspaceIcon: string | null;
  side: SplitSide;
  /** Back to one workspace, keeping the half this strip belongs to. */
  onUnsplit: () => void;
  /** Back to one workspace, keeping the *other* half — this one steps out. */
  onRemoveFromSplit: () => void;
  /**
   * Pick this workspace up off its own name and carry it to a half of the
   * window — the sidebar's carry gesture, started from here, so rearranging a
   * split is the same act wherever a workspace is grabbed from.
   */
  onCarry: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Both ends stay put while the tabs scroll between them, and cover whatever
 * passes underneath.
 *
 * Sticky inside the strip rather than sat outside it, because the strip's box
 * has to keep spanning the same width as the canvas below: the selected tab's
 * connected look is decided by mapping the tab's pixels onto grid columns
 * against the strip's own rect, so a strip narrowed by chrome either side
 * would map every tab onto the wrong columns.
 */
const PINNED = "sticky z-20 shrink-0 bg-shell";

/**
 * How far in from the strip's right edge the pinned controls come to rest.
 *
 * Zero, not the strip's own `pr-1.5`: a sticky inset is measured from the
 * scrollport already reduced by the scroll container's padding, so counting
 * that padding again lands each control 6px left of where the same element
 * sits in flow — and a strip that has not overflowed, where sticky should be
 * doing nothing at all, would quietly shift both of them. Measured in
 * Chromium rather than reasoned about; the two disagreed.
 */
export const PINNED_RIGHT = "right-0";

/**
 * Which workspace this half is, and everything you can do to it from here.
 *
 * Two strips side by side carry tab names that say nothing about whose tabs
 * they are, and this is the only thing on screen that answers that — so it
 * introduces the strip rather than competing with it, and truncates rather
 * than crowding the tabs out. It is also the workspace's own handle in this
 * window: a menu on click, and a grip on drag, which carries the workspace to
 * either half exactly as dragging its row out of the rail does.
 */
export function SplitWorkspaceMenu({
  chrome,
  onRename,
  onChangeIcon,
  onArchive,
  onDelete,
}: {
  chrome: SplitChrome;
  /*
   * The workspace's own actions, which are the strip's already — the ⋯ menu
   * at the far end offers every one of them. They are repeated here because
   * this is where the workspace's *name* is, and a name is what you reach for
   * when you want to rename, re-mark or put away the thing it names.
   */
  onRename: () => void;
  onChangeIcon: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { workspaceName, workspaceIcon, onRemoveFromSplit, onCarry } = chrome;
  return (
    <DropdownMenu
      align="start"
      // Inset from the panel's left edge, so the mark is not sitting on the
      // seam of the window it belongs to.
      className={cn(PINNED, "left-0 flex h-8 items-center pl-2")}
      menuClassName="w-56"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          // A drag off this button is the workspace being carried somewhere;
          // a plain press still opens the menu, because the gesture swallows
          // the click only once it has passed its threshold.
          onPointerDown={onCarry}
          onDragStart={(event) => event.preventDefault()}
          aria-label={`${workspaceName} workspace`}
          title={workspaceName}
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md pl-0.5 pr-1.5 transition-colors",
            "text-muted-foreground hover:bg-accent hover:text-foreground",
            "aria-expanded:bg-accent aria-expanded:text-foreground",
          )}
        >
          <WorkspaceAvatar name={workspaceName} icon={workspaceIcon} />
          <span className="max-w-28 truncate text-xs font-medium">{workspaceName}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
        </button>
      )}
    >
      {/* The split first: it is the only item here that is about the window
          rather than about the workspace, and it is the one this menu grew
          out of. */}
      <DropdownMenuItem onSelect={onRemoveFromSplit}>
        <Unlink className="size-4" aria-hidden />
        Remove from split
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onRename}>
        <Pencil className="size-4" aria-hidden />
        Rename workspace
      </DropdownMenuItem>
      {/* Directly under Rename: both answer "what is this workspace called",
          one in letters and one in a picture. */}
      <DropdownMenuItem onSelect={onChangeIcon}>
        <ImagePlus className="size-4" aria-hidden />
        Change icon…
      </DropdownMenuItem>
      {/* Above the separator: archiving is the reversible one. */}
      <DropdownMenuItem onSelect={onArchive}>
        <Archive className="size-4" aria-hidden />
        Archive
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={onDelete}>
        <Trash2 className="size-4" aria-hidden />
        Delete
      </DropdownMenuItem>
    </DropdownMenu>
  );
}

/**
 * Collapse back to one workspace, keeping this half. Both halves carry one;
 * what each of them does about it is the caller's business.
 */
export function UnsplitButton({
  workspaceName,
  side,
  onUnsplit,
}: {
  workspaceName: string;
  side: SplitSide;
  onUnsplit: () => void;
}) {
  // The icon draws the half that goes, not the half that stays: "keep this
  // one" and "close the other one" are the same act, and only the second has
  // a direction a picture can point in. So the left strip folds the right
  // panel away and the right strip folds the left one.
  const Icon = side === "primary" ? PanelRightClose : PanelLeftClose;
  const label = `Keep only ${workspaceName}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      // A plain title rather than the rail's tooltip plate: on the right-hand
      // strip this button sits against the window's edge, which is exactly
      // where that plate — placed to the right of what it labels — has nowhere
      // to go.
      title={label}
      onClick={onUnsplit}
      className={cn(
        PINNED,
        PINNED_RIGHT,
        "mb-0.5 size-7 text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </Button>
  );
}
