"use client";

import {
  Archive,
  ChevronRight,
  ChevronUp,
  List,
  MoreHorizontal,
  RotateCcw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  SidebarIconSlot,
  SidebarNoMatches,
  SidebarRowLabel,
  SidebarSearch,
  sidebarRowClass,
  WorkspaceAvatar,
} from "@/components/nav/sidebar-parts";
import { useArmedMotion } from "@/components/ui/armed-motion";
import { Button } from "@/components/ui/button";
import { CascadeMenu } from "@/components/ui/cascade-menu";
import { Collapse } from "@/components/ui/collapse";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RailTooltip } from "@/components/ui/tooltip";
import type { Workspace } from "@/lib/api";
import { relativeTime } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { filterWorkspacesByName, workspaceTileCount } from "@/lib/workspaces";

const OPEN_KEY = "spawn.sidebar.archivedOpen";
const LAST_OPENED_KEY = "spawn.sidebar.archivedLastOpened";
/** How many put-away workspaces the drawer shows before deferring to the
 *  dialog: enough to reach the recent ones, short enough to stay a drawer. */
const DRAWER_LIMIT = 5;

/**
 * Whether the drawer is open, for the length of the tab. `AppShell` keeps one
 * of these for the rail and for the same reason: this shell remounts on every
 * route change, and a component that starts closed and learns better from an
 * effect renders shut for a frame each time — which the disclosure then
 * animates, replaying itself on every workspace switch.
 */
const remembered: { open: boolean | null } = { open: null };

/** "Archived 3d ago · 2 windows" — read off the workspace's own layout, which
 *  archiving leaves exactly as it was. */
function archivedDetail(workspace: Workspace): string {
  const parts: string[] = [];
  const when = relativeTime(workspace.archived_at);
  if (when) parts.push(`Archived ${when}`);
  const windows = workspaceTileCount(workspace);
  if (windows > 0) parts.push(`${windows} ${windows === 1 ? "window" : "windows"}`);
  return parts.join(" · ");
}

/**
 * The put-away workspaces, as a disclosure directly above Settings.
 *
 * Collapsed by default and hidden entirely when nothing is archived: the
 * point of archiving is a quieter sidebar, so the feature must not itself
 * take up a permanent row. Rows are dressed exactly like the live workspaces
 * above — same mark, same height, same kebab slot — because a workspace put
 * away is still the same workspace, and opening one opens it: archived is a
 * state you can look at, not a door that has to be unlocked first. What they
 * are deliberately *not* part of is the drag-reorder model: they carry no
 * `data-workspace-row`, which is what `Sidebar` collects to compute drop
 * indices, since an archived workspace has left the sidebar's ordering and
 * comes back at the end.
 *
 * Only the most recent few live in the drawer. The rest are one "View all"
 * away, in a dialog that carries the search — a sidebar list you have to
 * search is a list that stopped being a sidebar.
 */
export function SidebarArchivedSection({
  workspaces,
  collapsed,
  busy,
  currentWorkspaceId,
  onNavigate,
  onRestore,
  onDelete,
}: {
  workspaces: Workspace[];
  collapsed: boolean;
  busy: boolean;
  /** The workspace on screen — an archived one still gets the active row. */
  currentWorkspaceId: string | null;
  onNavigate?: () => void;
  onRestore: (workspace: Workspace) => void;
  onDelete: (workspace: Workspace) => void;
}) {
  const [open, setOpen] = useState(remembered.open ?? false);
  const armed = useArmedMotion();
  const [showAll, setShowAll] = useState(false);
  const [lastOpenedId, setLastOpenedId] = useState<string | null>(null);

  // Only the first mount reads the open flag from storage; after that
  // `remembered` is the fresher of the two. The mobile drawer mounts a second
  // Sidebar, and both read the same value.
  useEffect(() => {
    if (remembered.open === null) {
      const stored = window.localStorage.getItem(OPEN_KEY) === "true";
      remembered.open = stored;
      setOpen(stored);
    }
    setLastOpenedId(window.localStorage.getItem(LAST_OPENED_KEY));
  }, []);

  // Opening an archived workspace — from the drawer, from the dialog, or by
  // landing on its URL — is what makes it the one the drawer keeps in reach.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    if (!workspaces.some((workspace) => workspace.id === currentWorkspaceId)) return;
    window.localStorage.setItem(LAST_OPENED_KEY, currentWorkspaceId);
    setLastOpenedId(currentWorkspaceId);
  }, [currentWorkspaceId, workspaces]);

  /**
   * The most recently archived, in that order — plus, held at the top, the
   * last workspace opened *from the dialog*: one that the recency cut would
   * otherwise hide again the moment you went looking for it. A row already in
   * this list stays exactly where it is when you open it; nothing reorders
   * under a click you just made.
   */
  const drawerRows = useMemo(() => {
    const natural = workspaces.slice(0, DRAWER_LIMIT);
    const pinned = natural.some((workspace) => workspace.id === lastOpenedId)
      ? undefined
      : workspaces.find((workspace) => workspace.id === lastOpenedId);
    return pinned ? [pinned, ...natural.slice(0, DRAWER_LIMIT - 1)] : natural;
  }, [workspaces, lastOpenedId]);

  const toggle = () => {
    setOpen((current) => {
      remembered.open = !current;
      window.localStorage.setItem(OPEN_KEY, String(!current));
      return !current;
    });
  };

  if (workspaces.length === 0) return null;

  return (
    <div className="border-t border-border px-2.5 py-2">
      <RailTooltip label={`Archived (${workspaces.length})`} disabled={!collapsed}>
        <button
          type="button"
          // On the rail there is no room for a list, so the whole archive
          // opens where it can be read: the same dialog "View all" opens,
          // just reached from the one row the rail has space for.
          onClick={collapsed ? () => setShowAll(true) : toggle}
          // On the rail the label is hidden and the count is not drawn, so the
          // row would otherwise have no name at all.
          aria-label={collapsed ? `Archived (${workspaces.length})` : undefined}
          aria-expanded={collapsed ? undefined : open}
          className={cn(sidebarRowClass(false), "group/archived")}
        >
          <SidebarIconSlot>
            <Archive className="size-4" aria-hidden />
          </SidebarIconSlot>
          <SidebarRowLabel collapsed={collapsed}>Archived</SidebarRowLabel>
          {!collapsed && (
            <span className="flex shrink-0 items-center gap-1.5 pr-2 text-xs tabular-nums">
              {workspaces.length}
              {/* Points up while closed — the list unfolds downward from here. */}
              <ChevronUp
                aria-hidden
                className={cn(
                  "size-3.5",
                  // Armed after the first paint: a chevron that mounts already
                  // turned must not re-spin on every workspace switch.
                  armed && "transition-transform duration-150",
                  open && "rotate-180",
                )}
              />
            </span>
          )}
        </button>
      </RailTooltip>

      {/* Glides open rather than appearing. The rows stay mounted so the
       * drawer has a height to animate to, and Collapse makes the clipped
       * content inert so a shut drawer holds nothing focusable. */}
      <Collapse open={open && !collapsed}>
        <div className="space-y-1 pt-1">
          <ul className="space-y-1">
            {drawerRows.map((workspace) => (
              <ArchivedRow
                key={workspace.id}
                workspace={workspace}
                active={currentWorkspaceId === workspace.id}
                busy={busy}
                onNavigate={onNavigate}
                onRestore={onRestore}
                onDelete={onDelete}
              />
            ))}
          </ul>
          {workspaces.length > DRAWER_LIMIT && (
            // Dressed as the Archived row it sits under, and pointing the way
            // it leads: sideways, out of the sidebar, into the full list.
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className={sidebarRowClass(false)}
            >
              <SidebarIconSlot>
                <List className="size-4" aria-hidden />
              </SidebarIconSlot>
              <SidebarRowLabel collapsed={false}>View all ({workspaces.length})</SidebarRowLabel>
              <ChevronRight className="mr-3 size-3.5 shrink-0" aria-hidden />
            </button>
          )}
        </div>
      </Collapse>

      <ArchivedDialog
        open={showAll}
        onOpenChange={setShowAll}
        workspaces={workspaces}
        currentWorkspaceId={currentWorkspaceId}
        busy={busy}
        onNavigate={onNavigate}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    </div>
  );
}

/**
 * One put-away workspace: a link to it, like every other row in the sidebar.
 *
 * Opening it changes nothing — the page shows the snapshot the server kept —
 * so the two acts that *do* change something, restoring and deleting, stay
 * behind the kebab where the live rows keep theirs.
 */
function ArchivedRow({
  workspace,
  active,
  busy,
  onNavigate,
  onRestore,
  onDelete,
  onActed,
}: {
  workspace: Workspace;
  active: boolean;
  busy: boolean;
  onNavigate?: () => void;
  onRestore: (workspace: Workspace) => void;
  onDelete: (workspace: Workspace) => void;
  /** Called once an action has been taken from this row — the dialog uses it
   *  to get out of the way, while the sidebar has nowhere to go. */
  onActed?: () => void;
}) {
  const restore = () => {
    onRestore(workspace);
    onActed?.();
  };

  return (
    <li className="group/archived-row relative">
      <Link
        href={`/w/${workspace.id}`}
        onClick={onNavigate}
        title={archivedDetail(workspace)}
        className={cn(sidebarRowClass(active), "pr-10 [@media(pointer:coarse)]:pr-16")}
      >
        <SidebarIconSlot>
          <WorkspaceAvatar name={workspace.name} icon={workspace.icon} className="opacity-70" />
        </SidebarIconSlot>
        <SidebarRowLabel collapsed={false}>{workspace.name}</SidebarRowLabel>
      </Link>
      {/* Shares the right edge with the kebab exactly as the attention badge
          does on a live row: at rest it says how long ago, hovering swaps in
          the actions. */}
      <span
        className={cn(
          "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-muted-foreground transition-opacity",
          "group-hover/archived-row:opacity-0 group-focus-within/archived-row:opacity-0",
          "[@media(pointer:coarse)]:right-10 [@media(pointer:coarse)]:opacity-100",
        )}
      >
        {relativeTime(workspace.archived_at)}
      </span>
      <CascadeMenu
        align="end"
        sheetTitle={workspace.name}
        className="absolute right-1.5 top-1/2 -translate-y-1/2"
        menuClassName="w-44"
        renderTrigger={(props) => (
          <Button
            {...props}
            type="button"
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={`${workspace.name} archived actions`}
            className="size-7 opacity-0 group-hover/archived-row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        )}
        root={{
          id: `archived-${workspace.id}`,
          items: [
            { key: "restore", icon: <RotateCcw />, label: "Restore", onSelect: restore },
            {
              key: "delete",
              icon: <Trash2 />,
              label: "Delete forever",
              destructive: true,
              onSelect: () => {
                onDelete(workspace);
                onActed?.();
              },
            },
          ],
        }}
      />
    </li>
  );
}

/**
 * Every archived workspace, searchable.
 *
 * The drawer holds the few you are likely to want; this is where the rest
 * are, and so this is where the search lives. Rows are the drawer's rows,
 * kebab and all — the dialog is a longer view of the same list, not a
 * read-only index you have to leave to act on anything.
 */
function ArchivedDialog({
  open,
  onOpenChange,
  workspaces,
  currentWorkspaceId,
  busy,
  onNavigate,
  onRestore,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  busy: boolean;
  onNavigate?: () => void;
  onRestore: (workspace: Workspace) => void;
  onDelete: (workspace: Workspace) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterWorkspacesByName(workspaces, query), [workspaces, query]);

  /**
   * Acting on a row closes the list: a restore navigates into the workspace
   * and a delete asks for confirmation in a dialog of its own, so whatever
   * comes next belongs somewhere other than on top of this. A restore that
   * still needs a host is the exception — the row's picker is inside this
   * dialog, and closing would take the question away with it.
   */

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <DialogContent
        size="sm"
        className="p-0"
        // The scrim dismisses; a row's own menu — portaled to the body, and so
        // technically "outside" — does not. Without this, opening the kebab
        // would close the list the kebab belongs to.
        onPointerDownOutside={(event) => {
          const target = event.detail.originalEvent.target as Element | null;
          if (!target?.closest?.("[data-dialog-overlay]")) event.preventDefault();
        }}
        onFocusOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="pb-3">
          <DialogTitle>Archived</DialogTitle>
        </DialogHeader>
        <div className="border-b border-border px-3 pb-3">
          <SidebarSearch value={query} onChange={setQuery} label="Search archived workspaces" />
        </div>
        {matches.length === 0 ? (
          <div className="px-3">
            <SidebarNoMatches query={query.trim()} />
          </div>
        ) : (
          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {matches.map((workspace) => (
              <ArchivedRow
                key={workspace.id}
                workspace={workspace}
                active={currentWorkspaceId === workspace.id}
                busy={busy}
                onNavigate={() => {
                  onOpenChange(false);
                  onNavigate?.();
                }}
                onRestore={onRestore}
                onDelete={onDelete}
                onActed={() => onOpenChange(false)}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
