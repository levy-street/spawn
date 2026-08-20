"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, PanelLeftClose, PanelLeftOpen, Plus, Settings, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type PointerEvent as ReactPointerEvent, useMemo, useState } from "react";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
import { SidebarWorkspaceRow } from "@/components/nav/SidebarWorkspaceRow";
import { SidebarIconSlot, SidebarRowLabel, sidebarRowClass } from "@/components/nav/sidebar-parts";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RailTooltip } from "@/components/ui/tooltip";
import { NewWorkspaceMenu } from "@/components/workspace/new-workspace-menu";
import { hosts, sessions, type Workspace, workspaces } from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { workspaceAttentionCount } from "@/lib/workspaces";

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

  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    refetchInterval: 5_000,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaces.list,
    refetchInterval: 30_000,
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
  const sessionsById = useMemo(
    () => new Map((sessionsQ.data ?? []).map((session) => [session.id, session])),
    [sessionsQ.data],
  );
  const onlineHosts = (hostsQ.data ?? []).filter((host) => host.status === "online");
  const currentWorkspaceId = /^\/w\/([^/?]+)/u.exec(pathname)?.[1] ?? null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    queryClient.invalidateQueries({ queryKey: ["hosts"] });
  };

  const renameWorkspaceM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => workspaces.update(id, { name }),
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
  const workspaceBusy =
    renameWorkspaceM.isPending || reorderWorkspaceM.isPending || deleteWorkspaceM.isPending;

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
      <div className="px-2.5 pb-1 pt-3">
        <div className="flex h-(--row-h) items-center">
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
        <RailTooltip label="New workspace" disabled={!collapsed} className="[&>span]:w-full">
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
        {!collapsed && !workspacesQ.isLoading && orderedWorkspaces.length === 0 && (
          <p className="px-2 py-4 text-xs leading-5 text-muted-foreground">
            Your workspaces will appear here.
          </p>
        )}
        <ul className="space-y-2">
          {orderedWorkspaces.map((workspace) => {
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
                onDelete={() => void requestWorkspaceDelete(workspace)}
                onRowPointerDown={(event) => startWorkspaceDrag(workspace.id, event)}
              />
            );
          })}
        </ul>
      </nav>

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
          menuClassName="w-56"
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
