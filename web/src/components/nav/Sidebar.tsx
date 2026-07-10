"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Settings,
  SquarePen,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { NAV } from "@/components/nav/BottomTabs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { AgentStatusDot, hostStatusTone, StatusDot } from "@/components/ui/status";
import { RailTooltip } from "@/components/ui/tooltip";
import { agentActivityDetail, agentTitle } from "@/lib/agents";
import { type Agent, agents, type Host, hosts } from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const SIDEBAR_RAIL_WIDTH = 56;

const ACTION_TOOLBAR_BOUNDARY_OVERLAP = 8;

/**
 * Geometry contract that keeps collapse/expand smooth: every row is a fixed
 * `h-9` flex with a `size-9` icon slot whose left edge never moves (constant
 * `px-2.5` gutter). Only the aside width animates; labels stay mounted and
 * fade/clip, so icons hold their exact position through the transition.
 */
function rowClass(active: boolean): string {
  return cn(
    "group/row flex h-9 w-full items-center rounded-lg text-sm transition-colors",
    active
      ? "bg-accent text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );
}

function IconSlot({ children }: { children: ReactNode }) {
  return <span className="grid size-9 shrink-0 place-items-center">{children}</span>;
}

function RowLabel({
  collapsed,
  className,
  children,
}: {
  collapsed: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden={collapsed}
      className={cn(
        "min-w-0 flex-1 truncate whitespace-nowrap pr-1 text-left transition-opacity",
        collapsed ? "opacity-0 duration-100" : "opacity-100 delay-75 duration-150",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Sidebar({
  pathname,
  collapsed,
  onToggle,
}: {
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { user } = useAuth();
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Brand / toggle header */}
      <div className="px-2.5 pb-1 pt-3">
        <div className="flex h-9 items-center">
          {collapsed ? (
            <RailTooltip label="Expand sidebar">
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={onToggle}
                className="group/brand grid size-9 shrink-0 place-items-center rounded-lg text-foreground transition-colors hover:bg-accent/50"
              >
                <SquareTerminal className="size-4.5 group-hover/brand:hidden" aria-hidden />
                <PanelLeftOpen
                  className="hidden size-4.5 text-muted-foreground group-hover/brand:block"
                  aria-hidden
                />
              </button>
            </RailTooltip>
          ) : (
            <Link
              href="/"
              className="grid size-9 shrink-0 place-items-center rounded-lg text-foreground transition-colors hover:bg-accent/50"
              aria-label="Dashboard"
            >
              <SquareTerminal className="size-4.5" aria-hidden />
            </Link>
          )}
          <RowLabel collapsed={collapsed} className="text-base font-semibold tracking-tight">
            spawn
          </RowLabel>
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-hidden={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={onToggle}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-opacity hover:bg-accent/50 hover:text-foreground",
              collapsed
                ? "pointer-events-none opacity-0 duration-100"
                : "opacity-100 delay-75 duration-150",
            )}
          >
            <PanelLeftClose className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* Primary nav */}
      <nav aria-label="Primary" className="px-2.5">
        <ul className="space-y-0.5">
          <li className="pb-1.5">
            <RailTooltip label="New agent" disabled={!collapsed}>
              {/* Inverted primary row — the one call-to-action in the rail. */}
              <Link
                href="/agents/new"
                className={cn(
                  "group/new flex h-9 w-full items-center rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-sm transition-[background-color,box-shadow]",
                  "hover:bg-primary/90 hover:shadow-md",
                  pathname === "/agents/new" && "ring-2 ring-ring/40",
                )}
              >
                <IconSlot>
                  <SquarePen
                    className="size-4 transition-transform duration-150 group-hover/new:scale-110"
                    aria-hidden
                  />
                </IconSlot>
                <RowLabel collapsed={collapsed}>New agent</RowLabel>
              </Link>
            </RailTooltip>
          </li>
          {NAV.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <RailTooltip label={item.label} disabled={!collapsed}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={rowClass(active)}
                  >
                    <IconSlot>
                      <Icon className="size-4" aria-hidden />
                    </IconSlot>
                    <RowLabel collapsed={collapsed}>{item.label}</RowLabel>
                  </Link>
                </RailTooltip>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Host -> agent tree */}
      <AgentTree pathname={pathname} collapsed={collapsed} />

      {/* Account footer */}
      <div className="border-t border-border px-2.5 py-2">
        <DropdownMenu
          side="top"
          align="start"
          className="block w-full"
          menuClassName="w-56"
          renderTrigger={(props) => (
            <RailTooltip label={user?.email ?? "Account"} disabled={!collapsed}>
              <button
                type="button"
                {...props}
                aria-label="Account menu"
                className={cn(rowClass(false), "h-11")}
              >
                <IconSlot>
                  <span className="grid size-6 place-items-center rounded-full bg-secondary text-[11px] font-semibold uppercase text-secondary-foreground">
                    {(user?.email ?? "?").slice(0, 1)}
                  </span>
                </IconSlot>
                <RowLabel collapsed={collapsed} className="text-xs">
                  {user?.email ?? "—"}
                </RowLabel>
              </button>
            </RailTooltip>
          )}
        >
          <DropdownMenuLabel className="truncate">{user?.email ?? "—"}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem href="/settings">
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

type HostGroup = {
  hostId: string;
  hostName: string;
  host: Host | undefined;
  agents: Agent[];
};

function AgentTree({ pathname, collapsed }: { pathname: string; collapsed: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => agents.list(),
    refetchInterval: 5_000,
  });
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    refetchInterval: 30_000,
  });

  const groups = useMemo(
    () => groupAgentsByHost(agentsQ.data ?? [], hostsQ.data ?? []),
    [agentsQ.data, hostsQ.data],
  );

  const [actionTarget, setActionTarget] = useState<{
    agentId: string;
    left: number;
    top: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeActionsTimer = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const suppressClickAgentId = useRef<string | null>(null);

  const allAgents = useMemo(() => groups.flatMap((group) => group.agents), [groups]);
  const actionAgent = actionTarget
    ? (allAgents.find((agent) => agent.id === actionTarget.agentId) ?? null)
    : null;

  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["hosts"] });
    if (id) qc.invalidateQueries({ queryKey: ["agent", id] });
  };

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => agents.rename(id, name),
    onSuccess: (_agent, vars) => {
      setActionError(null);
      invalidate(vars.id);
    },
    onError: (err) => setActionError(String(err)),
  });
  const archiveM = useMutation({
    mutationFn: (id: string) => agents.archive(id),
    onSuccess: (_agent, id) => {
      setActionTarget(null);
      setActionError(null);
      invalidate(id);
      if (pathname === `/agents/${id}`) router.push("/agents");
    },
    onError: (err) => setActionError(String(err)),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => agents.remove(id),
    onSuccess: (_result, id) => {
      setActionTarget(null);
      setActionError(null);
      invalidate(id);
      if (pathname === `/agents/${id}`) router.push("/agents");
    },
    onError: (err) => setActionError(String(err)),
  });
  const restartM = useMutation({
    mutationFn: (id: string) => agents.restart(id),
    onSuccess: (_agent, id) => {
      setActionError(null);
      invalidate(id);
    },
    onError: (err) => setActionError(String(err)),
  });
  const pinM = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      pinned ? agents.pin(id) : agents.unpin(id),
    onSuccess: (_agent, vars) => {
      setActionError(null);
      invalidate(vars.id);
    },
    onError: (err) => setActionError(String(err)),
  });

  const busy =
    renameM.isPending ||
    archiveM.isPending ||
    deleteM.isPending ||
    restartM.isPending ||
    pinM.isPending;

  useEffect(() => {
    if (actionTarget && !actionAgent) setActionTarget(null);
  }, [actionAgent, actionTarget]);

  useEffect(() => {
    return () => {
      if (closeActionsTimer.current) window.clearTimeout(closeActionsTimer.current);
      if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    };
  }, []);

  const cancelCloseActions = () => {
    if (!closeActionsTimer.current) return;
    window.clearTimeout(closeActionsTimer.current);
    closeActionsTimer.current = null;
  };
  const scheduleCloseActions = () => {
    cancelCloseActions();
    closeActionsTimer.current = window.setTimeout(() => {
      setActionTarget(null);
      closeActionsTimer.current = null;
    }, 140);
  };
  const cancelLongPress = () => {
    if (!longPressTimer.current) return;
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  const openActions = (agent: Agent, element: HTMLElement) => {
    cancelCloseActions();
    const rowRect = element.getBoundingClientRect();
    const asideRect = element.closest("aside")?.getBoundingClientRect();
    setActionTarget({
      agentId: agent.id,
      left: (asideRect?.right ?? rowRect.right) - ACTION_TOOLBAR_BOUNDARY_OVERLAP,
      top: Math.min(Math.max(rowRect.top + rowRect.height / 2, 36), window.innerHeight - 36),
    });
  };
  const onRowPointerEnter = (agent: Agent, event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    openActions(agent, event.currentTarget);
  };
  const onRowPointerDown = (agent: Agent, event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return;
    const element = event.currentTarget;
    cancelLongPress();
    longPressTimer.current = window.setTimeout(() => {
      suppressClickAgentId.current = agent.id;
      openActions(agent, element);
      longPressTimer.current = null;
    }, 500);
  };
  const onAgentClick = (agent: Agent, event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (suppressClickAgentId.current !== agent.id) return;
    suppressClickAgentId.current = null;
    event.preventDefault();
    event.stopPropagation();
  };
  const promptRename = (agent: Agent) => {
    const next = prompt("Rename agent", agent.name ?? agentTitle(agent));
    if (next === null) return;
    const name = next.trim();
    if (!name || name === agent.name) return;
    renameM.mutate({ id: agent.id, name });
  };

  return (
    <section
      aria-label="Agents by host"
      className="mt-4 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-2"
    >
      {actionError && !collapsed && (
        <p className="mb-1 px-1.5 text-[11px] text-destructive">{actionError}</p>
      )}
      <ul>
        {groups.map((group) => (
          <Fragment key={group.hostId}>
            <li aria-hidden={collapsed} className="relative">
              {/* Host header cross-fades into a rail divider when collapsed. */}
              <Link
                href={group.host ? `/hosts/${group.hostId}` : "/hosts"}
                tabIndex={collapsed ? -1 : 0}
                className={cn(
                  "flex items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-all hover:text-foreground",
                  collapsed
                    ? "pointer-events-none h-4 opacity-0 duration-100"
                    : "h-7 opacity-100 delay-75 duration-150",
                )}
              >
                <StatusDot
                  tone={hostStatusTone(group.host?.status ?? "offline")}
                  className="size-1.5"
                />
                <span className="truncate">{group.hostName}</span>
                <span className="font-normal normal-case">{group.agents.length}</span>
              </Link>
              <span
                aria-hidden
                className={cn(
                  "absolute left-1/2 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 bg-border transition-opacity",
                  collapsed ? "opacity-100 delay-75 duration-150" : "opacity-0 duration-100",
                )}
              />
            </li>
            {group.agents.map((agent) => {
              const active = pathname === `/agents/${agent.id}`;
              return (
                <li
                  key={agent.id}
                  className="my-0.5"
                  onPointerEnter={(event) => onRowPointerEnter(agent, event)}
                  onPointerLeave={(event) => {
                    if (event.pointerType !== "touch") scheduleCloseActions();
                  }}
                  onPointerDown={(event) => onRowPointerDown(agent, event)}
                  onPointerUp={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onFocus={(event) => openActions(agent, event.currentTarget)}
                  onBlur={scheduleCloseActions}
                >
                  <RailTooltip
                    label={`${agentTitle(agent)} · ${agentActivityDetail(agent)}`}
                    disabled={!collapsed}
                  >
                    <Link
                      href={`/agents/${agent.id}`}
                      aria-current={active ? "page" : undefined}
                      onClick={(event) => onAgentClick(agent, event)}
                      className={cn(rowClass(active), "h-10")}
                    >
                      <IconSlot>
                        <span className="relative">
                          <AgentKindIcon agent={agent} />
                          <AgentStatusDot
                            agent={agent}
                            className="absolute -bottom-0.5 -right-0.5"
                          />
                        </span>
                      </IconSlot>
                      <RowLabel collapsed={collapsed}>
                        <span className="block truncate text-xs font-medium leading-4">
                          {agentTitle(agent)}
                        </span>
                        <span className="block truncate text-[10px] leading-3 opacity-70">
                          {agentActivityDetail(agent)}
                        </span>
                      </RowLabel>
                    </Link>
                  </RailTooltip>
                </li>
              );
            })}
          </Fragment>
        ))}
        {!agentsQ.isLoading && allAgents.length === 0 && !collapsed && (
          <li className="px-1.5 py-1 text-xs text-muted-foreground">No agents yet</li>
        )}
      </ul>

      {actionAgent && (
        <div
          role="toolbar"
          aria-label={`${agentTitle(actionAgent)} actions`}
          className="fixed z-40 flex -translate-y-1/2 items-center rounded-lg border border-border bg-popover/95 p-0.5 shadow-lg shadow-black/40 backdrop-blur animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ left: actionTarget?.left, top: actionTarget?.top }}
          onPointerEnter={cancelCloseActions}
          onPointerLeave={scheduleCloseActions}
          onFocus={cancelCloseActions}
          onBlur={scheduleCloseActions}
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`Rename ${agentTitle(actionAgent)}`}
            title="Rename agent"
            disabled={busy}
            onClick={() => promptRename(actionAgent)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-7", actionAgent.pinned_at && "text-primary")}
            aria-label={`${actionAgent.pinned_at ? "Unpin" : "Pin"} ${agentTitle(actionAgent)}`}
            title={actionAgent.pinned_at ? "Unpin agent" : "Pin agent"}
            disabled={busy}
            onClick={() => pinM.mutate({ id: actionAgent.id, pinned: !actionAgent.pinned_at })}
          >
            {actionAgent.pinned_at ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`Restart ${agentTitle(actionAgent)}`}
            title="Restart agent"
            disabled={busy}
            onClick={() => {
              if (confirm(`Restart ${agentTitle(actionAgent)}?`)) restartM.mutate(actionAgent.id);
            }}
          >
            <RotateCcw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`Archive ${agentTitle(actionAgent)}`}
            title="Archive agent"
            disabled={busy}
            onClick={() => archiveM.mutate(actionAgent.id)}
          >
            <Archive className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-destructive hover:text-destructive"
            aria-label={`Delete ${agentTitle(actionAgent)}`}
            title="Delete agent"
            disabled={busy}
            onClick={() => {
              if (confirm(`Delete ${agentTitle(actionAgent)}?`)) deleteM.mutate(actionAgent.id);
            }}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      )}
    </section>
  );
}

function groupAgentsByHost(agentList: Agent[], hostList: Host[]): HostGroup[] {
  const hostsById = new Map(hostList.map((host) => [host.id, host]));
  const byHost = new Map<string, Agent[]>();
  for (const agent of agentList) {
    const list = byHost.get(agent.host_id) ?? [];
    list.push(agent);
    byHost.set(agent.host_id, list);
  }
  const groups: HostGroup[] = [];
  for (const [hostId, list] of byHost) {
    const host = hostsById.get(hostId);
    groups.push({
      hostId,
      hostName: host?.name ?? list[0]?.host_name ?? "unknown host",
      host,
      agents: list.sort(compareAgents),
    });
  }
  return groups.sort((a, b) => {
    const aOnline = a.host?.status === "online" ? 0 : 1;
    const bOnline = b.host?.status === "online" ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return a.hostName.localeCompare(b.hostName);
  });
}

function compareAgents(a: Agent, b: Agent): number {
  if (Boolean(a.pinned_at) !== Boolean(b.pinned_at)) return a.pinned_at ? -1 : 1;
  const byInput = lastInputTime(b) - lastInputTime(a);
  if (byInput !== 0) return byInput;
  return agentTitle(a).localeCompare(agentTitle(b));
}

function lastInputTime(agent: Agent): number {
  const value = agent.last_input_at ?? agent.started_at;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}
