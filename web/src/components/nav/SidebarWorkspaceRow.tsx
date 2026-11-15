"use client";

import { useQuery } from "@tanstack/react-query";
import { Archive, ImagePlus, MoreHorizontal, Pencil, Trash2, Unlink } from "lucide-react";
import Link from "next/link";
import {
  type CSSProperties,
  type FormEvent,
  Fragment,
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
import { AttentionBadge } from "@/components/ui/attention-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  type DropdownMenuHandle,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RailTooltip } from "@/components/ui/tooltip";
import { WorkspaceIconDialog } from "@/components/workspace/workspace-icon-dialog";
import { sessions, type Workspace } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type AttentionLevel, workspaceFolder } from "@/lib/workspaces";

/**
 * A tile on the collapsed rail, by how much of the window it is: the
 * workspace you are working in, one on screen beside it, or neither.
 *
 * Selection has to be a ring, not a border: a workspace with a custom icon
 * renders no border of its own (WorkspaceAvatar leaves that to us), and a ring
 * also sits outside the tile instead of eating 2px of the artwork.
 */
const RAIL_TILE = {
  active: "border-foreground/20 bg-accent text-accent-foreground ring-1 ring-foreground",
  // The same ring, half lit: the same fact, said quieter.
  shown: "border-foreground/20 bg-accent/50 text-foreground ring-1 ring-foreground/40",
  rest: "border-border bg-muted/50 text-muted-foreground hover:bg-accent hover:text-foreground",
} as const;

/** What a rail tile's tooltip says: the name, and anything waiting on you. */
function railLabel(name: string, attentionCount: number): string {
  return `${name}${attentionCount > 0 ? ` · ${attentionCount} need attention` : ""}`;
}

/**
 * The attention pip, astride a tile's top-right corner and ringed in the
 * rail's own ground (bg-shell, not card) so the gap reads as the sidebar
 * showing through — an inset dot, not a haloed one.
 */
function RailAttentionPip({ level }: { level: AttentionLevel | null | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -right-1 -top-1 size-3 rounded-full border-2 border-shell",
        level === "dead" ? "bg-destructive" : "bg-warning",
      )}
    />
  );
}

export function SidebarWorkspaceRow({
  workspace,
  active,
  beside = false,
  collapsed,
  attentionCount,
  attentionLevel = attentionCount > 0 ? "waiting" : null,
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
   * Shown in another column of a split. On screen just as much as the active
   * row, so it cannot look unvisited — but it is not what the URL is about,
   * so it does not wear the full selection either.
   */
  beside?: boolean;
  collapsed: boolean;
  attentionCount: number;
  /** The most urgent of them: a stopped window outranks a waiting one. */
  attentionLevel?: AttentionLevel | null;
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
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    enabled: iconOpen,
  });
  // The icon dialog looks in the folder the workspace's first window runs in.
  const iconSource = iconOpen ? workspaceFolder(workspace, sessionsQ.data ?? []) : null;
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
      <li
        // The same drag contract as the expanded row: the rail reorders a
        // tile up and down, and carries it out to the canvas past its edge.
        data-workspace-row={workspace.id}
        data-row-ids={workspace.id}
        onPointerDown={onRowPointerDown}
        // The tile is an anchor, whose native HTML5 drag would otherwise
        // hijack the pointer and freeze the gesture.
        onDragStart={(event) => event.preventDefault()}
        className="flex justify-center py-1"
      >
        <RailTooltip label={railLabel(workspace.name, attentionCount)}>
          <Link
            href={`/w/${workspace.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : beside ? "true" : undefined}
            draggable={false}
            className="relative"
          >
            <WorkspaceAvatar
              name={workspace.name}
              icon={workspace.icon}
              rail
              className={cn(
                "transition-colors",
                active ? RAIL_TILE.active : beside ? RAIL_TILE.shown : RAIL_TILE.rest,
              )}
            />
            {attentionCount > 0 && <RailAttentionPip level={attentionLevel} />}
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
      // split's row holds all of its members.
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
            <AttentionBadge
              count={attentionCount}
              level={attentionLevel}
              className={cn(
                "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 transition-opacity",
                "group-hover/workspace:opacity-0 group-focus-within/workspace:opacity-0",
                "[@media(pointer:coarse)]:right-10 [@media(pointer:coarse)]:opacity-100",
              )}
            />
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
          hostId={iconSource?.host_id ?? null}
          cwd={iconSource?.cwd ?? null}
          busy={busy}
          onSelect={onIcon}
        />
      )}
    </li>
  );
}

/**
 * Where one member of a split stands in the window: the column you are
 * working in, a column on screen beside it, or not on screen at all — the
 * group parked behind some other workspace, or folded off a window too narrow
 * to draw all of it.
 */
export type GroupMemberState = "active" | "shown" | "parked";

/**
 * Narrower than this, a member of an expanded split row drops its name and
 * keeps its mark: three or four workspaces share one row, and a name cut to
 * two letters and an ellipsis says less than the mark beside it. Two members
 * keep their names at every width the sidebar can be dragged to.
 */
const MEMBER_NAME_HIDES = "@max-[5.5rem]:hidden";

/**
 * A member that has dropped its name says how much of the window it is with
 * its mark instead: the lit ink that marks the column with the keyboard has
 * nothing left to colour once the name is gone. The same rings the collapsed
 * rail's tiles wear, so a split reads the same on either rail.
 */
const MEMBER_MARK_STATE = {
  active:
    "@max-[5.5rem]:border-foreground/20 @max-[5.5rem]:text-foreground @max-[5.5rem]:ring-1 @max-[5.5rem]:ring-foreground",
  shown: "@max-[5.5rem]:ring-1 @max-[5.5rem]:ring-foreground/40",
  parked: "",
} as const;

/**
 * One member of a split's row. A real `<button>`, not a link: what pressing
 * one means depends on where you already are. With the split on screen every
 * member is in front of you, so it is a request to work in that column; with
 * the split parked behind some other workspace it is a navigation, and
 * arriving at any member is what puts the split back up. The row's owner
 * decides which — this only reports that a member was pressed.
 */
function SidebarGroupMember({
  workspace,
  state,
  collapsed,
  position,
  attentionCount,
  attentionLevel,
  onOpen,
}: {
  workspace: Workspace;
  state: GroupMemberState;
  collapsed: boolean;
  /** Where it sits in the row, which decides which of its edges meet a join. */
  position: "first" | "middle" | "last";
  attentionCount: number;
  attentionLevel: AttentionLevel | null;
  onOpen: (workspaceId: string) => void;
}) {
  // The count goes into the button's name, where it is a fact rather than a
  // coloured dot, and the name is spelled out because the label beside the
  // mark is not always drawn.
  const label = `${workspace.name}${attentionCount > 0 ? `, ${attentionCount} need attention` : ""}`;
  if (collapsed) {
    return (
      <RailTooltip label={railLabel(workspace.name, attentionCount)}>
        <button
          type="button"
          // Read by the drag: which member was pressed decides which
          // workspace is carried out to the canvas, while the row as a whole
          // is what reorders.
          data-split-member={workspace.id}
          aria-pressed={state === "active"}
          aria-label={label}
          onClick={() => onOpen(workspace.id)}
          className="relative block rounded-lg"
        >
          <WorkspaceAvatar
            name={workspace.name}
            icon={workspace.icon}
            rail
            className={cn(
              "transition-colors",
              state === "active"
                ? RAIL_TILE.active
                : state === "shown"
                  ? RAIL_TILE.shown
                  : RAIL_TILE.rest,
            )}
          />
          {attentionCount > 0 && <RailAttentionPip level={attentionLevel} />}
        </button>
      </RailTooltip>
    );
  }
  return (
    <button
      type="button"
      data-split-member={workspace.id}
      aria-pressed={state === "active"}
      aria-label={label}
      title={workspace.name}
      onClick={() => onOpen(workspace.id)}
      className={cn(
        // Its own container, so the name can step aside when the member is
        // too narrow for it — which depends on how many share the row and how
        // wide the sidebar has been dragged, not on the window.
        "@container flex h-full min-w-0 flex-1 text-sm transition-colors",
        // No ground of its own — the row is one plate, and a member that
        // tinted itself would put the seam back. Which column owns the
        // keyboard is said in the ink instead: lit against muted, the same
        // pair of weights an ordinary row uses for visited against not.
        // Hover lifts the ink and nothing else: a wash over one member would
        // draw an edge across the plate, which is the seam this row exists to
        // not have.
        state === "active"
          ? "text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex size-full min-w-0 items-center gap-1.5",
          // The outer edges keep the row's own inset; an edge that meets a
          // join stands off the control riding it, which is out of flow and
          // would otherwise sit on top of whichever name reached it first.
          position === "first" ? "pl-1.5 pr-4" : position === "last" ? "pl-4 pr-1.5" : "px-4",
          // Without its name the mark sits in the middle, clear of the joins
          // either side of it.
          "@max-[5.5rem]:justify-center @max-[5.5rem]:px-0",
        )}
      >
        <span className="relative shrink-0">
          <WorkspaceAvatar
            name={workspace.name}
            icon={workspace.icon}
            className={cn("transition-shadow", MEMBER_MARK_STATE[state])}
          />
          {/* The pip sits on the mark rather than beside it: a split's row
              has no width to spare for a badge, and the mark is what the eye
              is scanning for anyway. */}
          {attentionCount > 0 && (
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-shell",
                attentionLevel === "dead" ? "bg-destructive" : "bg-warning",
              )}
            />
          )}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-left font-medium", MEMBER_NAME_HIDES)}>
          {workspace.name}
        </span>
      </span>
    </button>
  );
}

/**
 * The control on a join between two members: it releases the member after
 * it — the one to its right in the expanded row, below it on the rail. With
 * two members that is the split ending with the first kept, exactly as the
 * pair's single control always did, and it says so in the same words; with
 * more, only that one member steps out and the rest stay split.
 */
function SidebarGroupJoin({
  label,
  collapsed,
  style,
  onRelease,
}: {
  label: string;
  collapsed: boolean;
  style?: CSSProperties;
  onRelease: () => void;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={collapsed ? undefined : label}
      onClick={onRelease}
      style={style}
      className={cn(
        // No plate at rest: the mark alone sits on the row's own ground,
        // marking the join without cutting it. A wash only appears under
        // the pointer, where it is answering a hover rather than drawing a
        // seam that is not there.
        "rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        collapsed
          ? "my-0.5 size-6"
          : // Out of flow and centred on the boundary, so every member keeps
            // an equal share of the row and the icon reads as the join it
            // undoes instead of as another thing in the row.
            "absolute top-1/2 z-10 size-7 -translate-x-1/2 -translate-y-1/2",
      )}
    >
      <Unlink className="size-3.5" aria-hidden />
    </Button>
  );
  return collapsed ? <RailTooltip label={label}>{button}</RailTooltip> : button;
}

/**
 * A split, as one row holding all of its workspaces in the order they are
 * arranged in.
 *
 * Separate rows would say the workspaces are independent destinations, which
 * once they are split they are not: one window holds them all, and opening
 * any of them brings up the whole split. Drawing them joined, in the same
 * order as the columns themselves, is what makes the rail a picture of the
 * window rather than a list that happens to contain it — and the row outlives
 * being looked at, so a split you have navigated away from is still visibly a
 * split waiting for you.
 *
 * Expanded, the members sit side by side like the columns they stand for.
 * Collapsed, the rail is a single column of tiles, so they stack one beneath
 * the other on one plate with the same joins between them — the vertical
 * counterpart of the same row, carrying the same controls and the same drag.
 */
export function SidebarWorkspaceGroup({
  members,
  collapsed,
  onScreen,
  memberState,
  attentionCount,
  attentionLevel,
  onOpen,
  onRelease,
  onRowPointerDown,
}: {
  /** Left to right, as arranged. */
  members: Workspace[];
  collapsed: boolean;
  /**
   * Whether the split is the window in front of you, or parked — listed as a
   * split, but not what is on screen.
   */
  onScreen: boolean;
  memberState: (workspaceId: string) => GroupMemberState;
  attentionCount: (workspace: Workspace) => number;
  attentionLevel: (workspace: Workspace) => AttentionLevel | null;
  /** A member was pressed: work in it, or go to it. */
  onOpen: (workspaceId: string) => void;
  /** A join was pressed: this member steps out of the split. */
  onRelease: (workspaceId: string) => void;
  onRowPointerDown?: (event: ReactPointerEvent<HTMLLIElement>) => void;
}) {
  const first = members[0];
  if (!first) return null;
  const joinLabel = (released: Workspace) =>
    members.length === 2 ? `Unsplit, keep ${first.name}` : `Remove ${released.name} from split`;
  return (
    <li
      // The anchor id, as every row carries; `data-row-ids` is what the drag
      // reads to turn a row index into the positions the server stores, which
      // for this row is one per member.
      data-workspace-row={first.id}
      data-row-ids={members.map(({ id }) => id).join(" ")}
      onPointerDown={onRowPointerDown}
      onDragStart={(event) => event.preventDefault()}
      className={collapsed ? "flex justify-center py-1" : undefined}
    >
      {/* One plate, not separate tiles: the window these workspaces are in is
          a single thing, so the row that stands for it is a single thing too
          — one ground, running end to end, with no slot of rail showing
          through to say otherwise. The whole plate carries the state, because
          the whole plate is the window: lit when it is the one you are looking
          at, and held at half strength while it is parked behind some other
          workspace — still visibly an arrangement, just not this one. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset is a form's grouping, with a form's chrome and semantics; this is a navigation row whose members belong together, which is what the ARIA group role says. */}
      <div
        role="group"
        aria-label={`Split: ${members.map(({ name }) => name).join(", ")}`}
        className={cn(
          "transition-colors",
          collapsed
            ? // Wider than the tiles by its own padding, which the rail's
              // inset has room for: the plate shows around every tile, and the
              // tiles stay exactly where a lone tile would sit.
              "flex flex-col items-center rounded-xl p-1"
            : "relative flex h-(--row-h) items-center overflow-hidden rounded-lg",
          onScreen ? "bg-accent" : "bg-accent/50",
        )}
      >
        {members.map((workspace, index) => (
          <Fragment key={workspace.id}>
            {/* Between the members in the markup as well as on screen, though
                the expanded one is out of flow and could sit anywhere: reading
                order is the only thing its position there still decides. */}
            {index > 0 && (
              <SidebarGroupJoin
                label={joinLabel(workspace)}
                collapsed={collapsed}
                // Every member is flex-1, so a join sits at an even fraction
                // of the row.
                style={collapsed ? undefined : { left: `${(index / members.length) * 100}%` }}
                onRelease={() => onRelease(workspace.id)}
              />
            )}
            <SidebarGroupMember
              workspace={workspace}
              state={memberState(workspace.id)}
              collapsed={collapsed}
              position={index === 0 ? "first" : index === members.length - 1 ? "last" : "middle"}
              attentionCount={attentionCount(workspace)}
              attentionLevel={attentionLevel(workspace)}
              onOpen={onOpen}
            />
          </Fragment>
        ))}
      </div>
    </li>
  );
}
