"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { SidebarSessionRow } from "@/components/nav/SidebarSessionRow";
import { SidebarWorkspaceRow } from "@/components/nav/SidebarWorkspaceRow";
import { SidebarIconSlot, SidebarRowLabel, sidebarRowClass } from "@/components/nav/sidebar-parts";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RailTooltip } from "@/components/ui/tooltip";
import { NewSessionMenu } from "@/components/workspace/new-session-menu";
import { hosts, type Session, sessions, type Workspace, workspaces } from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";
import { sessionTitle } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { workspaceAttentionCount, workspaceSessionIds } from "@/lib/workspaces";

const EXPANDED_KEY_PREFIX = "spawn.sidebar.workspace.expanded.";

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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  useEffect(() => {
    if (orderedWorkspaces.length === 0) return;
    setExpanded((current) => {
      const next = { ...current };
      let changed = false;
      for (const workspace of orderedWorkspaces) {
        if (workspace.id in next) continue;
        next[workspace.id] =
          window.localStorage.getItem(`${EXPANDED_KEY_PREFIX}${workspace.id}`) !== "false";
        changed = true;
      }
      return changed ? next : current;
    });
  }, [orderedWorkspaces]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    queryClient.invalidateQueries({ queryKey: ["hosts"] });
  };

  const createWorkspaceM = useMutation({
    mutationFn: (hostId: string) =>
      workspaces.create({ first_session: { host_id: hostId, cwd: "~" } }),
    onSuccess: (result) => {
      setActionError(null);
      refresh();
      router.push(`/w/${result.workspace.id}`);
      onNavigate?.();
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const renameWorkspaceM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => workspaces.update(id, { name }),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const moveWorkspaceM = useMutation({
    mutationFn: ({ workspace, target }: { workspace: Workspace; target: Workspace }) =>
      Promise.all([
        workspaces.update(workspace.id, { position: target.position }),
        workspaces.update(target.id, { position: workspace.position }),
      ]),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const deleteWorkspaceM = useMutation({
    mutationFn: (id: string) => workspaces.remove(id),
    onSuccess: (_result, id) => {
      setActionError(null);
      refresh();
      if (currentWorkspaceId === id) router.push("/");
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const renameSessionM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => sessions.rename(id, name),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const restartSessionM = useMutation({
    mutationFn: (id: string) => sessions.restart(id),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });
  const closeSessionM = useMutation({
    mutationFn: (id: string) => sessions.remove(id),
    onSuccess: refresh,
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
  });

  const workspaceBusy =
    renameWorkspaceM.isPending || moveWorkspaceM.isPending || deleteWorkspaceM.isPending;
  const sessionBusy =
    renameSessionM.isPending || restartSessionM.isPending || closeSessionM.isPending;

  const toggleWorkspace = (id: string) => {
    setExpanded((current) => {
      const value = !(current[id] ?? true);
      window.localStorage.setItem(`${EXPANDED_KEY_PREFIX}${id}`, String(value));
      return { ...current, [id]: value };
    });
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

  const requestSessionClose = async (session: Session) => {
    const accepted = await confirm({
      title: `Close ${sessionTitle(session)}?`,
      body: "Closing this session kills its running process and cannot be undone.",
      confirmLabel: "Close session",
      destructive: true,
    });
    if (accepted) closeSessionM.mutate(session.id);
  };

  const newWorkspaceButton = (
    <Button
      type="button"
      size="sm"
      disabled={createWorkspaceM.isPending}
      onClick={
        onlineHosts.length > 1
          ? undefined
          : () => {
              if (onlineHosts.length === 1 && onlineHosts[0]) {
                createWorkspaceM.mutate(onlineHosts[0].id);
              } else {
                onNavigate?.();
                openSettings("hosts");
              }
            }
      }
      className="group/new h-(--row-h) w-full justify-start px-0"
    >
      <SidebarIconSlot>
        <Plus className="size-4 transition-transform duration-150 group-hover/new:rotate-90" />
      </SidebarIconSlot>
      <SidebarRowLabel collapsed={collapsed}>New workspace</SidebarRowLabel>
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="px-2.5 pb-1 pt-3">
        <div className="flex h-(--row-h) items-center">
          {collapsed ? (
            <RailTooltip label="Expand sidebar">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Expand sidebar"
                onClick={onToggle}
                className="group/brand size-9 shrink-0"
              >
                <SquareTerminal className="size-4.5 group-hover/brand:hidden" aria-hidden />
                <PanelLeftOpen
                  className="hidden size-4.5 text-muted-foreground group-hover/brand:block"
                  aria-hidden
                />
              </Button>
            </RailTooltip>
          ) : (
            <Link
              href="/"
              onClick={onNavigate}
              className="grid size-9 shrink-0 place-items-center rounded-lg text-foreground transition-colors hover:bg-accent/50"
              aria-label="Home"
            >
              <SquareTerminal className="size-4.5" aria-hidden />
            </Link>
          )}
          <SidebarRowLabel collapsed={collapsed} className="text-base font-semibold tracking-tight">
            spawnd
          </SidebarRowLabel>
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
                "size-7 shrink-0",
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

      <div className="px-2.5 pb-2">
        <RailTooltip label="New workspace" disabled={!collapsed} className="[&>span]:w-full">
          {onlineHosts.length > 1 ? (
            <NewSessionMenu
              mode="workspace"
              trigger={newWorkspaceButton}
              onCreated={({ workspaceId }) => {
                refresh();
                router.push(`/w/${workspaceId}`);
                onNavigate?.();
              }}
            />
          ) : (
            newWorkspaceButton
          )}
        </RailTooltip>
      </div>

      <nav aria-label="Workspaces" className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
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
        <ul className="space-y-0.5">
          {orderedWorkspaces.map((workspace, index) => {
            const workspaceSessions = workspaceSessionIds(workspace)
              .map((id) => sessionsById.get(id))
              .filter((session): session is Session => session !== undefined);
            return (
              <SidebarWorkspaceRow
                key={workspace.id}
                workspace={workspace}
                active={currentWorkspaceId === workspace.id}
                collapsed={collapsed}
                expanded={expanded[workspace.id] ?? true}
                attentionCount={workspaceAttentionCount(workspace, sessionsById)}
                busy={workspaceBusy}
                canMoveUp={index > 0}
                canMoveDown={index < orderedWorkspaces.length - 1}
                onNavigate={onNavigate}
                onToggle={() => toggleWorkspace(workspace.id)}
                onRename={(name) => renameWorkspaceM.mutate({ id: workspace.id, name })}
                onMoveUp={() => {
                  const target = orderedWorkspaces[index - 1];
                  if (target) moveWorkspaceM.mutate({ workspace, target });
                }}
                onMoveDown={() => {
                  const target = orderedWorkspaces[index + 1];
                  if (target) moveWorkspaceM.mutate({ workspace, target });
                }}
                onDelete={() => void requestWorkspaceDelete(workspace)}
              >
                {workspaceSessions.map((session) => (
                  <SidebarSessionRow
                    key={session.id}
                    session={session}
                    workspaceId={workspace.id}
                    active={pathname === `/sessions/${session.id}`}
                    busy={sessionBusy}
                    onNavigate={onNavigate}
                    onRename={(name) => renameSessionM.mutate({ id: session.id, name })}
                    onRestart={() => restartSessionM.mutate(session.id)}
                    onClose={() => void requestSessionClose(session)}
                  />
                ))}
                <li className="pl-5 [&>span]:w-full">
                  <NewSessionMenu
                    mode="session"
                    workspaceId={workspace.id}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-full justify-start px-2 text-xs text-muted-foreground"
                      >
                        <Plus className="size-3.5" aria-hidden />
                        add session
                      </Button>
                    }
                    onCreated={({ workspaceId, sessionId }) => {
                      refresh();
                      router.push(`/w/${workspaceId}?focus=${sessionId}`);
                      onNavigate?.();
                    }}
                  />
                </li>
              </SidebarWorkspaceRow>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-border px-2.5 py-2">
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
          <DropdownMenuLabel className="truncate">{user?.email ?? "—"}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              onNavigate?.();
              openSettings("account");
            }}
          >
            <Settings className="size-4" aria-hidden />
            Settings
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
