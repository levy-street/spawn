"use client";

import { Archive, ImagePlus, MoreHorizontal, Pencil, Trash2, Unlink } from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SidebarIconSlot,
  SidebarRowLabel,
  sidebarRowClass,
  WorkspaceAvatar,
} from "@/components/nav/sidebar-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  type DropdownMenuHandle,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RailTooltip } from "@/components/ui/tooltip";
import { WorkspaceIconDialog } from "@/components/workspace/workspace-icon-dialog";
import type { Workspace } from "@/lib/api";
import type { SplitSide } from "@/lib/split-store";
import { cn } from "@/lib/utils";

export function SidebarWorkspaceRow({
  workspace,
  active,
  beside = false,
  collapsed,
  attentionCount,
  busy,
  onNavigate,
  onRename,
  onIcon,
  onArchive,
  onDelete,
  onRowPointerDown,
}: {
  workspace: Workspace;
  active: boolean;
  /**
   * Shown in the other half of a split. On screen just as much as the active
   * row, so it cannot look unvisited — but it is not what the URL is about,
   * so it does not wear the full selection either.
   */
  beside?: boolean;
  collapsed: boolean;
  attentionCount: number;
  busy: boolean;
  onNavigate?: () => void;
  onRename: (name: string) => void;
  /** Null sets it back to the initials. */
  onIcon: (icon: string | null) => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Arms the sidebar's drag-to-reorder; a plain click still navigates. */
  onRowPointerDown?: (event: ReactPointerEvent<HTMLLIElement>) => void;
}) {
  const menuRef = useRef<DropdownMenuHandle>(null);
  const [editing, setEditing] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [draft, setDraft] = useState(workspace.name);

  useEffect(() => {
    if (!editing) setDraft(workspace.name);
  }, [editing, workspace.name]);

  const submitRename = (event?: FormEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next && next !== workspace.name) onRename(next);
    setEditing(false);
  };

  if (collapsed) {
    return (
      <li className="flex justify-center py-1">
        <RailTooltip
          label={`${workspace.name}${attentionCount > 0 ? ` · ${attentionCount} need attention` : ""}`}
        >
          <Link
            href={`/w/${workspace.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : beside ? "true" : undefined}
            className="relative"
          >
            <WorkspaceAvatar
              name={workspace.name}
              icon={workspace.icon}
              rail
              className={cn(
                "transition-colors",
                // Selection has to be a ring, not a border: a workspace with a
                // custom icon renders no border of its own (WorkspaceAvatar
                // leaves that to us), and a ring also sits outside the tile
                // instead of eating 2px of the artwork.
                active
                  ? "border-foreground/20 bg-accent text-accent-foreground ring-1 ring-foreground"
                  : beside
                    ? // The same ring, half lit: the same fact, said quieter.
                      "border-foreground/20 bg-accent/50 text-foreground ring-1 ring-foreground/40"
                    : "border-border bg-muted/50 text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            />
            {attentionCount > 0 && (
              // Astride the tile's top-right corner, ringed in the rail's own
              // ground (bg-shell, not card) so the gap reads as the sidebar
              // showing through — an inset dot, not a haloed one.
              <span className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-shell bg-warning" />
            )}
          </Link>
        </RailTooltip>
      </li>
    );
  }

  return (
    <li
      data-workspace-row={workspace.id}
      // The workspaces this row holds. One, here — but the drag reads it off
      // every row uniformly to turn a row index into stored positions, and a
      // paired row holds two.
      data-row-ids={workspace.id}
      onPointerDown={editing ? undefined : onRowPointerDown}
      // The row wraps an anchor, whose native HTML5 drag would otherwise
      // hijack the pointer and freeze the reorder gesture.
      onDragStart={(event) => event.preventDefault()}
    >
      <div className="group/workspace relative">
        {editing ? (
          // The row itself, with the name made writable: the same shape, the
          // same mark, and the label swapped for a field that is nothing but
          // the text with a faint rule under it — the tab strip's rename,
          // drawn a row wide.
          <form
            onSubmit={submitRename}
            className={cn(sidebarRowClass(active), "pr-3 text-foreground")}
          >
            <SidebarIconSlot>
              <WorkspaceAvatar name={workspace.name} icon={workspace.icon} />
            </SidebarIconSlot>
            <input
              // biome-ignore lint/a11y/noAutofocus: the field replaces the name of the row that was just asked to rename itself — landing in it is the gesture, not a surprise.
              autoFocus
              aria-label={`Rename ${workspace.name}`}
              className={cn(
                "mt-0.5 h-auto min-w-0 flex-1 border-0 border-b bg-transparent p-0 pb-0.5 text-sm font-medium leading-5 text-inherit outline-none",
                "border-current/15 focus:border-current/30 disabled:opacity-50",
              )}
              value={draft}
              disabled={busy}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={() => submitRename()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
            />
          </form>
        ) : (
          <Link
            href={`/w/${workspace.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : beside ? "true" : undefined}
            className={cn(
              sidebarRowClass(active),
              // Between rest and selection, and not a hover state: the row is
              // held there whether or not the pointer is anywhere near it.
              !active && beside && "bg-accent/50 text-foreground",
              "pr-10 [@media(pointer:coarse)]:pr-16",
            )}
          >
            <SidebarIconSlot>
              <WorkspaceAvatar name={workspace.name} icon={workspace.icon} />
            </SidebarIconSlot>
            <SidebarRowLabel collapsed={false} className="font-medium">
              {workspace.name}
            </SidebarRowLabel>
          </Link>
        )}

        {!editing && (
          <>
            {/* The attention badge and the actions kebab share one right-edge
                slot: the badge holds it at rest, hovering the row swaps in the
                kebab. Coarse pointers cannot hover, so there the badge steps
                one slot left and the kebab stays put. */}
            {attentionCount > 0 && (
              <Badge
                variant="warning"
                className={cn(
                  "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 px-2 py-0 text-[11px] transition-opacity",
                  "group-hover/workspace:opacity-0 group-focus-within/workspace:opacity-0",
                  "[@media(pointer:coarse)]:right-10 [@media(pointer:coarse)]:opacity-100",
                )}
              >
                {attentionCount}
              </Badge>
            )}
            <DropdownMenu
              ref={menuRef}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              menuClassName="w-44"
              renderTrigger={(props) => (
                <Button
                  {...props}
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`${workspace.name} actions`}
                  className="size-7 opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
                >
                  <MoreHorizontal className="size-4" aria-hidden />
                </Button>
              )}
            >
              <DropdownMenuItem disabled={busy} onSelect={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden />
                Rename
              </DropdownMenuItem>
              {/* Directly under Rename: both answer "what is this workspace
                  called", one in letters and one in a picture. */}
              <DropdownMenuItem disabled={busy} onSelect={() => setIconOpen(true)}>
                <ImagePlus className="size-4" aria-hidden />
                Change icon…
              </DropdownMenuItem>
              {/* Above the separator: archiving is the reversible one. */}
              <DropdownMenuItem disabled={busy} onSelect={onArchive}>
                <Archive className="size-4" aria-hidden />
                Archive
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive disabled={busy} onSelect={onDelete}>
                <Trash2 className="size-4" aria-hidden />
                Delete
              </DropdownMenuItem>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* Mounted only while open: the dialog holds a host connection of its
          own, and a sidebar of thirty workspaces must not carry thirty of
          them idling. The panel has no exit animation, so unmounting on close
          looks exactly like closing. */}
      {iconOpen && (
        <WorkspaceIconDialog
          open
          onOpenChange={setIconOpen}
          name={workspace.name}
          icon={workspace.icon}
          hostId={workspace.host_id}
          cwd={workspace.cwd}
          busy={busy}
          onSelect={onIcon}
        />
      )}
    </li>
  );
}

/**
 * One half of a paired row. A real `<button>`, not a link: what pressing one
 * means depends on where you already are. With the pair on screen both
 * workspaces are in front of you, so it is a request to work in that half;
 * with the pair parked behind some other workspace it is a navigation, and
 * arriving at either member is what puts the split back up. The row's owner
 * decides which — this only reports that a half was pressed.
 */
function SidebarPairHalf({
  workspace,
  side,
  active,
  attentionCount,
  onOpen,
}: {
  workspace: Workspace;
  side: SplitSide;
  active: boolean;
  attentionCount: number;
  onOpen: (side: SplitSide, workspaceId: string) => void;
}) {
  return (
    <button
      type="button"
      // Read by the drag: which half was pressed decides which workspace is
      // carried out to the canvas, while the row as a whole is what reorders.
      data-pair-half={workspace.id}
      aria-pressed={active}
      title={workspace.name}
      onClick={() => onOpen(side, workspace.id)}
      className={cn(
        "flex h-full min-w-0 flex-1 items-center gap-1.5 text-sm transition-colors",
        // The outer edge keeps the row's own inset; the inner one stands off
        // the control riding the seam, which is out of flow and would
        // otherwise sit on top of whichever name reached it first.
        side === "primary" ? "pl-1.5 pr-4" : "pl-4 pr-1.5",
        // No ground of its own — the row is one plate, and a half that tinted
        // itself would put the seam back. Which half owns the keyboard is
        // said in the ink instead: lit against muted, the same pair of weights
        // an ordinary row uses for visited against not.
        // Hover lifts the ink and nothing else: a wash over one half would
        // draw an edge down the middle of the plate, which is the seam this
        // row exists to not have.
        active ? "text-accent-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="relative shrink-0">
        <WorkspaceAvatar name={workspace.name} icon={workspace.icon} />
        {/* The pip sits on the mark rather than beside it: a paired row has no
            width to spare for a badge, and the mark is what the eye is
            scanning for anyway. The count itself goes into the button's name,
            where it is a fact rather than a coloured dot. */}
        {attentionCount > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-shell bg-warning"
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-left font-medium">{workspace.name}</span>
      {attentionCount > 0 && <span className="sr-only">{attentionCount} need attention</span>}
    </button>
  );
}

/**
 * A split, as one row holding both of its workspaces side by side in the
 * order they are arranged in.
 *
 * Two separate rows would say the workspaces are two independent
 * destinations, which once they are split they are not: one window holds
 * both, and opening either brings up the pair. Drawing them joined, in the
 * same left-to-right order as the halves themselves, is what makes the rail a
 * picture of the window rather than a list that happens to contain it — and
 * the row outlives being looked at, so a split you have navigated away from is
 * still visibly a split waiting for you.
 *
 * Expanded rail only. Collapsed, the two keep their own tiles: two containers
 * and a control between them do not survive a 56px column, and no drag starts
 * from there anyway.
 */
export function SidebarWorkspacePair({
  primary,
  secondary,
  activeSide,
  primaryAttention,
  secondaryAttention,
  onOpen,
  onUnsplit,
  onRowPointerDown,
}: {
  primary: Workspace;
  secondary: Workspace;
  /**
   * Which half is the window you are working in, or null when the pair is
   * parked — listed as a split, but not what is on screen.
   */
  activeSide: SplitSide | null;
  primaryAttention: number;
  secondaryAttention: number;
  /** A half was pressed: work in it, or go to it. */
  onOpen: (side: SplitSide, workspaceId: string) => void;
  /** Back to one workspace, keeping the left one. */
  onUnsplit: () => void;
  onRowPointerDown?: (event: ReactPointerEvent<HTMLLIElement>) => void;
}) {
  return (
    <li
      // The anchor id, as every row carries; `data-row-ids` is what the drag
      // reads to turn a row index into the positions the server stores, which
      // for this row is two of them.
      data-workspace-row={primary.id}
      data-row-ids={`${primary.id} ${secondary.id}`}
      onPointerDown={onRowPointerDown}
    >
      {/* One plate, not two tiles: the window these workspaces are in is a
          single thing, so the row that stands for it is a single thing too —
          one ground, running edge to edge, with no slot of rail showing
          through the middle to say otherwise. The control rides the seam
          rather than taking a column of its own: out of flow, both halves
          keep half the width each, and the icon reads as the join it undoes
          instead of as a third thing in a row of three. */}
      <div
        className={cn(
          "relative flex h-(--row-h) items-center overflow-hidden rounded-lg transition-colors",
          // The whole row carries the state, because the whole row is the
          // window: lit when it is the one you are looking at, and held at
          // half strength while it is parked behind some other workspace —
          // still visibly an arrangement, just not this one.
          activeSide === null ? "bg-accent/50" : "bg-accent",
        )}
      >
        <SidebarPairHalf
          workspace={primary}
          side="primary"
          active={activeSide === "primary"}
          attentionCount={primaryAttention}
          onOpen={onOpen}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // Between the halves in the markup as well as on screen, though it
          // is out of flow and could sit anywhere: reading order is the only
          // thing its position here still decides.
          //
          // Names what survives, because the control cannot: the icon says
          // "separate these", not which of the two you keep.
          aria-label={`Unsplit, keep ${primary.name}`}
          title={`Unsplit, keep ${primary.name}`}
          onClick={onUnsplit}
          className={cn(
            // Both halves are flex-1, so half the row is exactly the seam.
            "absolute left-1/2 top-1/2 z-10 size-7 -translate-x-1/2 -translate-y-1/2",
            // No plate at rest: the mark alone sits on the row's own ground,
            // marking the join without cutting it. A wash only appears under
            // the pointer, where it is answering a hover rather than drawing
            // a seam that is not there.
            "rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
          )}
        >
          <Unlink className="size-3.5" aria-hidden />
        </Button>
        <SidebarPairHalf
          workspace={secondary}
          side="secondary"
          active={activeSide === "secondary"}
          attentionCount={secondaryAttention}
          onOpen={onOpen}
        />
      </div>
    </li>
  );
}
