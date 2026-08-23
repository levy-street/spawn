"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type PointerEvent as ReactPointerEvent, useMemo, useState } from "react";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
import { LegionStrip } from "@/components/legion/LegionStrip";
import { SidebarArchivedSection } from "@/components/nav/SidebarArchivedSection";
import { SidebarWorkspaceRow } from "@/components/nav/SidebarWorkspaceRow";
import {
  SidebarIconSlot,
  SidebarNoMatches,
  SidebarRowLabel,
  SidebarSearch,
  sidebarRowClass,
} from "@/components/nav/sidebar-parts";
import { openProfile } from "@/components/profile/profile-dialog-store";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { RailTooltip } from "@/components/ui/tooltip";
import { NewWorkspaceMenu } from "@/components/workspace/new-workspace-menu";
import { hosts, sessions, type Workspace, workspaces } from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  filterWorkspacesByName,
  workspaceAttentionCount,
  workspaceLiveSessionCount,
} from "@/lib/workspaces";

export function Sidebar({
  pathname,
  collapsed,
  onToggle,
  onNavigate,
  showCollapseControl = true,
}: {
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  showCollapseControl?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    refetchInterval: 5_000,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    refetchInterval: 30_000,
  });
  // Its own key: the archived list must never leak into ["workspaces"], which
  // seven other surfaces read as "the workspaces I have".
  const archivedQ = useQuery({
    queryKey: ["workspaces", "archived"],
    queryFn: () => workspaces.list({ archived: true }),
    staleTime: 30_000,
  });
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    refetchInterval: 30_000,
  });

  const orderedWorkspaces = useMemo(
    () => [...(workspacesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [workspacesQ.data],
  );
  // What the tree actually renders. Reordering is disabled while a search is
  // narrowing the list: a drop index counted over visible rows would mean
  // something different from the position the server writes.
  const visibleWorkspaces = useMemo(
    () => filterWorkspacesByName(orderedWorkspaces, query),
    [orderedWorkspaces, query],
  );
  const searching = query.trim().length > 0;
  const sessionsById = useMemo(
    () => new Map((sessionsQ.data ?? []).map((session) => [session.id, session])),
    [sessionsQ.data],
  );
  const onlineHosts = (hostsQ.data ?? []).filter((host) => host.status === "online");
  const currentWorkspaceId = /^\/w\/([^/?]+)/u.exec(pathname)?.[1] ?? null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    // Matches ["workspaces"] and ["workspaces", "archived"] both: archiving
    // moves a row from one list to the other, so they always move together.
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    // The singular key the workspace page reads is a different cache entry —
    // and it is the one that decides whether that page draws a live canvas or
    // an archived snapshot.
    queryClient.invalidateQueries({ queryKey: ["workspace"] });
    queryClient.invalidateQueries({ queryKey: ["hosts"] });
  };

  const renameWorkspaceM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => workspaces.update(id, { name }),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const iconWorkspaceM = useMutation({
    // "custom" whichever way it went: a mark chosen here, and initials chosen
    // here, are both the owner's answer — the folder scan must not undo it.
    mutationFn: ({ id, icon }: { id: string; icon: string | null }) =>
      workspaces.update(id, { icon, icon_source: "custom" }),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const reorderWorkspaceM = useMutation({
    // The server reorders by removal + reinsertion, so a single position
    // write is a proper insert-at-index for the drag drop.
    mutationFn: ({ id, position }: { id: string; position: number }) =>
      workspaces.update(id, { position }),
    // Optimistic: the drop lands instantly instead of snapping back for a
    // round-trip; refresh reconciles either way.
    onMutate: ({ id, position }) => {
      queryClient.setQueryData<Workspace[]>(["workspaces"], (current) => {
        if (!current) return current;
        const ordered = [...current].sort((a, b) => a.position - b.position);
        const moving = ordered.find((workspace) => workspace.id === id);
        if (!moving) return current;
        const without = ordered.filter((workspace) => workspace.id !== id);
        without.splice(position, 0, moving);
        return without.map((workspace, index) => ({ ...workspace, position: index }));
      });
    },
    onSuccess: refresh,
    onError: (error) => {
      refresh();
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });
  const deleteWorkspaceM = useMutation({
    mutationFn: (id: string) => workspaces.remove(id),
    onSuccess: (_result, id) => {
      setActionError(null);
      refresh();
      if (currentWorkspaceId === id) router.push("/app");
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const archiveWorkspaceM = useMutation({
    mutationFn: ({ id }: { id: string; name: string; nextId: string | null }) =>
      workspaces.archive(id),
    onSuccess: (_result, { id, name, nextId }) => {
      setActionError(null);
      refresh();
      // Said out loud, because the row leaves the list under your cursor and
      // the only other evidence is a drawer that is probably closed.
      toast(`Archived ${name}`);
      // And carry on next door: the workspace you were looking at is stopped
      // now, so the useful place to be is the one that took its slot.
      if (currentWorkspaceId === id) {
        router.push(nextId ? `/w/${nextId}` : "/app");
        onNavigate?.();
      }
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const unarchiveWorkspaceM = useMutation({
    mutationFn: (id: string) => workspaces.unarchive(id),
    onSuccess: (workspace) => {
      setActionError(null);
      refresh();
      router.push(`/w/${workspace.id}`);
      onNavigate?.();
    },
    // Restoring is a deliberate act with its own outcome, and the sidebar's
    // inline error sits above a list the restored row is not in yet.
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const workspaceBusy =
    renameWorkspaceM.isPending ||
    iconWorkspaceM.isPending ||
    reorderWorkspaceM.isPending ||
    deleteWorkspaceM.isPending ||
    archiveWorkspaceM.isPending ||
    unarchiveWorkspaceM.isPending;

  /**
   * Drag a workspace row up or down to reorder. Pointer-based with a small
   * threshold, so a plain click still navigates: past the threshold the row
   * translates with the pointer, the drop index is the number of other rows
   * whose midpoint sits above the release point, and the click that follows
   * a real drag is swallowed.
   */
  const startWorkspaceDrag = (workspaceId: string, event: ReactPointerEvent<HTMLLIElement>) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    if ((event.target as Element).closest?.("button, input, [role='menu']")) return;
    const rowElement = event.currentTarget;
    const startY = event.clientY;
    const startX = event.clientX;
    let dragging = false;
    // Geometry is captured up front: rows shift with transforms mid-drag, so
    // both the target index and the shift math must use the resting rects.
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-workspace-row]"));
    const restingRects = rows.map((row) => row.getBoundingClientRect());
    const from = rows.indexOf(rowElement);
    const fromRect = restingRects[from];
    const rowStride = (fromRect?.height ?? 36) + 8; // + the list's space-y-2
    let lastTarget = from;

    const targetIndexFor = (clientY: number) => {
      let target = 0;
      for (const [index, row] of rows.entries()) {
        const rect = restingRects[index];
        if (row === rowElement || !rect) continue;
        if (clientY > rect.top + rect.height / 2) target += 1;
      }
      return target;
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientY - startY) < 5 && Math.abs(moveEvent.clientX - startX) < 5) {
          return;
        }
        dragging = true;
        rowElement.style.zIndex = "10";
        rowElement.style.position = "relative";
        rowElement.style.background = "var(--shell)";
        rowElement.style.borderRadius = "0.5rem";
        rowElement.style.boxShadow = "0 6px 16px rgb(0 0 0 / 0.35)";
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      moveEvent.preventDefault();
      rowElement.style.transform = `translateY(${moveEvent.clientY - startY}px)`;
      // Everything between the old and prospective slot slides one stride to
      // make room, so the drop target is always visible.
      const target = targetIndexFor(moveEvent.clientY);
      if (target === lastTarget) return;
      lastTarget = target;
      rows.forEach((row, index) => {
        if (row === rowElement) return;
        let shift = 0;
        if (from < target && index > from && index <= target) shift = -rowStride;
        if (from > target && index < from && index >= target) shift = rowStride;
        row.style.transition = "transform 150ms var(--ease-swift, ease-out)";
        row.style.transform = shift === 0 ? "" : `translateY(${shift}px)`;
      });
    };
    const finish = (commit: boolean, clientY: number) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointercancel", onCancel);
      for (const row of rows) {
        row.style.transform = "";
        row.style.transition = "";
      }
      rowElement.style.zIndex = "";
      rowElement.style.position = "";
      rowElement.style.background = "";
      rowElement.style.borderRadius = "";
      rowElement.style.boxShadow = "";
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (!dragging) return;
      const swallowClick = (clickEvent: Event) => {
        clickEvent.stopPropagation();
        clickEvent.preventDefault();
      };
      document.addEventListener("click", swallowClick, { capture: true, once: true });
      window.setTimeout(
        () => document.removeEventListener("click", swallowClick, { capture: true }),
        0,
      );
      if (!commit) return;
      const target = targetIndexFor(clientY);
      if (target !== from) reorderWorkspaceM.mutate({ id: workspaceId, position: target });
    };
    const onUp = (upEvent: PointerEvent) => finish(true, upEvent.clientY);
    const onCancel = () => finish(false, startY);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.addEventListener("pointercancel", onCancel);
  };

  /**
   * Archiving stops the work and keeps everything else, so it only stops to
   * ask when there is work to stop: a workspace of stopped windows archives
   * on the click. The destructive copy stays on Delete, which keeps nothing.
   */
  const requestWorkspaceArchive = async (workspace: Workspace) => {
    const live = workspaceLiveSessionCount(workspace, sessionsById);
    if (live > 0) {
      const accepted = await confirm({
        title: `Archive ${workspace.name}?`,
        body: `${live} running ${live === 1 ? "session" : "sessions"} will be stopped. The layout is kept — restore it any time from Archived and every window starts again where it is.`,
        confirmLabel: "Archive workspace",
      });
      if (!accepted) return;
    }
    archiveWorkspaceM.mutate({
      id: workspace.id,
      name: workspace.name,
      // The row that will sit where this one did — or the one above it when
      // this was the last, and nothing at all when it was the only one.
      nextId: (() => {
        const index = orderedWorkspaces.findIndex((row) => row.id === workspace.id);
        if (index < 0) return null;
        return (orderedWorkspaces[index + 1] ?? orderedWorkspaces[index - 1])?.id ?? null;
      })(),
    });
  };

  const requestArchivedDelete = async (workspace: Workspace) => {
    const accepted = await confirm({
      title: `Delete ${workspace.name} forever?`,
      body: "Its layout is discarded. This cannot be undone.",
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (accepted) deleteWorkspaceM.mutate(workspace.id);
  };

  const requestWorkspaceDelete = async (workspace: Workspace) => {
    const accepted = await confirm({
      title: `Delete ${workspace.name}?`,
      body: "Every session in this workspace will be closed and its process will be killed.",
      confirmLabel: "Delete workspace",
      destructive: true,
    });
    if (accepted) deleteWorkspaceM.mutate(workspace.id);
  };

  const newWorkspaceButton = (
    // Dressed exactly like the workspace rows below it.
    <button
      type="button"
      onClick={
        onlineHosts.length > 0
          ? undefined
          : () => {
              onNavigate?.();
              openSettings("hosts");
            }
      }
      className={cn(sidebarRowClass(false), "group/new")}
    >
      <SidebarIconSlot>
        <Plus className="size-4 transition-transform duration-150 group-hover/new:rotate-90" />
      </SidebarIconSlot>
      <SidebarRowLabel collapsed={collapsed}>New workspace</SidebarRowLabel>
    </button>
  );

  return (
    <div className="group/rail flex h-full min-h-0 flex-col bg-shell">
      {/* h-9, not the --row-h nav rhythm: this row holds the 36px trident
       * plate and nothing that has to line up with the tree below it, so the
       * lockup sits tighter to the top edge than a nav row would. */}
      <div className="px-2.5 pb-1.5 pt-2.5">
        <div className="flex h-9 items-center">
          {/* The whole lockup goes home, not just the trident: the wordmark
           * carries a second link to the same place, hovering either lights
           * the trident's plate, and only the trident is in the tab order and
           * the accessibility tree — two stops reading "spawnd home" back to
           * back is noise, and the wordmark is the redundant one. */}
          <div className="group/home flex min-w-0 flex-1 items-center">
            {collapsed ? (
              <RailTooltip label="Expand sidebar">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Expand sidebar"
                  onClick={onToggle}
                  className="size-9 shrink-0"
                >
                  {/* Anywhere on the rail, not just this button: reaching for
                   * the sidebar at all is the intent, and the swap tells you
                   * the mark is a door back before you get to it. */}
                  <Trident className="size-5.5 group-hover/rail:hidden" />
                  <PanelLeftOpen
                    className="hidden size-4.5 text-muted-foreground group-hover/rail:block"
                    aria-hidden
                  />
                </Button>
              </RailTooltip>
            ) : (
              <Link
                href="/"
                onClick={onNavigate}
                className="grid size-9 shrink-0 place-items-center rounded-lg text-foreground transition-colors group-hover/home:bg-accent/50"
                aria-label="spawnd home"
              >
                <Trident className="size-5.5" />
              </Link>
            )}
            {/* The lockup, not two marks: `flex items-center` centres the
             * wordmark on the trident's axis (left to itself the mask is an
             * inline-block and sits on the row's text baseline, 3px high), and
             * hellfire is the brand ink the trident is drawn in — the chrome
             * accent would swap it to the dark-theme ember and split the pair. */}
            <SidebarRowLabel collapsed={collapsed} className="ml-1.5 flex items-center">
              <Link
                href="/"
                onClick={onNavigate}
                aria-hidden
                tabIndex={-1}
                className={cn(
                  "flex items-center text-hellfire",
                  // Faded out on the rail, so it must not still be a target
                  // sitting in the empty space beside the trident.
                  collapsed && "pointer-events-none",
                )}
              >
                <Wordmark className="h-[17px]" />
              </Link>
            </SidebarRowLabel>
          </div>
          {showCollapseControl ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Collapse sidebar"
              aria-hidden={collapsed}
              tabIndex={collapsed ? -1 : 0}
              onClick={onToggle}
              className={cn(
                // Muted like the expand control it mirrors: chrome, not a
                // destination.
                "size-7 shrink-0 text-muted-foreground hover:text-foreground",
                collapsed
                  ? "pointer-events-none opacity-0 duration-100"
                  : "opacity-100 delay-75 duration-150",
              )}
            >
              <PanelLeftClose className="size-4" aria-hidden />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close sidebar"
              onClick={onNavigate}
              className="size-8 shrink-0"
            >
              <X className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      <div className="border-y border-border px-2.5 py-2">
        <RailTooltip label="New workspace" disabled={!collapsed}>
          {onlineHosts.length > 0 ? (
            <NewWorkspaceMenu
              trigger={newWorkspaceButton}
              onCreated={({ workspaceId, focusSessionId }) => {
                refresh();
                router.push(
                  focusSessionId
                    ? `/w/${workspaceId}?focus=${focusSessionId}`
                    : `/w/${workspaceId}`,
                );
                onNavigate?.();
              }}
            />
          ) : (
            newWorkspaceButton
          )}
        </RailTooltip>
      </div>

      <nav aria-label="Workspaces" className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-2.5">
        {actionError && !collapsed && (
          <p className="px-1.5 pb-2 text-xs text-destructive" role="alert">
            {actionError}
          </p>
        )}
        {!collapsed && orderedWorkspaces.length > 1 && (
          // Full-bleed rule under the box, matching the section rules above
          // and below the tree: the search is chrome, the list beneath it is
          // the content it filters.
          <div className="-mx-2.5 mb-2.5 border-b border-border px-2.5 pb-2.5">
            <SidebarSearch value={query} onChange={setQuery} label="Search workspaces" />
          </div>
        )}
        {!collapsed && !workspacesQ.isLoading && orderedWorkspaces.length === 0 && (
          <p className="px-2 py-4 text-xs leading-5 text-muted-foreground">
            Your workspaces will appear here.
          </p>
        )}
        {!collapsed && searching && visibleWorkspaces.length === 0 && (
          <SidebarNoMatches query={query.trim()} />
        )}
        <ul className="space-y-2">
          {visibleWorkspaces.map((workspace) => {
            return (
              <SidebarWorkspaceRow
                key={workspace.id}
                workspace={workspace}
                active={currentWorkspaceId === workspace.id}
                collapsed={collapsed}
                attentionCount={workspaceAttentionCount(workspace, sessionsById)}
                busy={workspaceBusy}
                onNavigate={onNavigate}
                onRename={(name) => renameWorkspaceM.mutate({ id: workspace.id, name })}
                onIcon={(icon) => iconWorkspaceM.mutate({ id: workspace.id, icon })}
                onArchive={() => void requestWorkspaceArchive(workspace)}
                onDelete={() => void requestWorkspaceDelete(workspace)}
                onRowPointerDown={
                  searching ? undefined : (event) => startWorkspaceDrag(workspace.id, event)
                }
              />
            );
          })}
        </ul>
      </nav>

      <SidebarArchivedSection
        workspaces={archivedQ.data ?? []}
        collapsed={collapsed}
        busy={workspaceBusy}
        currentWorkspaceId={currentWorkspaceId}
        onNavigate={onNavigate}
        onRestore={(workspace) => unarchiveWorkspaceM.mutate(workspace.id)}
        onDelete={(workspace) => void requestArchivedDelete(workspace)}
      />

      {/* Below Archived and above Settings: the machines you own are footer
       * furniture like the drawer over them, not a live ticker competing with
       * the workspace tree. Fed from the queries above rather than its own —
       * the section must not cost a request, and its counts must never
       * disagree with the rows it sits under. */}
      <LegionStrip
        hosts={hostsQ.data ?? []}
        sessions={sessionsQ.data ?? []}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />

      <div className="border-y border-border px-2.5 py-2">
        <RailTooltip label="Settings" disabled={!collapsed}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onNavigate?.();
              openSettings("account");
            }}
            className={cn(sidebarRowClass(false), "justify-start px-0")}
          >
            <SidebarIconSlot>
              <Settings className="size-4" aria-hidden />
            </SidebarIconSlot>
            <SidebarRowLabel collapsed={collapsed}>Settings</SidebarRowLabel>
          </Button>
        </RailTooltip>

        <DropdownMenu
          side="top"
          align="start"
          className="block w-full"
          renderTrigger={(props) => (
            <RailTooltip label={user?.email ?? "Account"} disabled={!collapsed}>
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Account menu"
                className={cn(sidebarRowClass(false), "h-11 justify-start px-0")}
              >
                <SidebarIconSlot>
                  <span className="grid size-6 place-items-center rounded-full bg-secondary text-[11px] font-semibold uppercase text-secondary-foreground">
                    {(user?.email ?? "?").slice(0, 1)}
                  </span>
                </SidebarIconSlot>
                <SidebarRowLabel collapsed={collapsed} className="text-xs">
                  {user?.email ?? "—"}
                </SidebarRowLabel>
              </Button>
            </RailTooltip>
          )}
        >
          <DropdownMenuItem
            onSelect={() => {
              onNavigate?.();
              openProfile();
            }}
          >
            <UserRound className="size-4" aria-hidden />
            Profile
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Settings has its own rail row above; Access keeps the one-click
              reach the v5 Access UX asks for (docs/TRUST_UX.md). */}
          <DropdownMenuItem onSelect={() => openSettings("access")}>
            <ShieldCheck className="size-4" aria-hidden />
            Access
          </DropdownMenuItem>
          <DropdownMenuItem
            destructive
            onSelect={() => {
              void logout();
            }}
          >
            <LogOut className="size-4" aria-hidden />
            Log out
          </DropdownMenuItem>
        </DropdownMenu>
      </div>
    </div>
  );
}
