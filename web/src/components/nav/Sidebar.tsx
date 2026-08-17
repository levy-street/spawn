"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  LayoutGrid,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Settings,
  ShieldCheck,
  SquarePen,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { NAV } from "@/components/nav/BottomTabs";
import { ScreenIcon } from "@/components/screens/ScreenIcon";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { type AgentConnState, useAgentConnState } from "@/components/terminal/LiveTerminalProvider";
import {
  DropdownMenu,
  type DropdownMenuHandle,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { AgentStatusDot } from "@/components/ui/status";
import { RailTooltip } from "@/components/ui/tooltip";
import { agentActivityDetail, agentTitle } from "@/lib/agents";
import { type Agent, agents, type Screen, screens } from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";
import { setAgentDragData } from "@/lib/dnd";
import { screenAttentionCount, screenPaneCount, screenRecency } from "@/lib/screens";
import { cn } from "@/lib/utils";

export const SIDEBAR_RAIL_WIDTH = 56;

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
            spawnd
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
          <DropdownMenuItem onSelect={() => openSettings("account")}>
            <Settings className="size-4" aria-hidden />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openSettings("trust")}>
            <ShieldCheck className="size-4" aria-hidden />
            Device trust
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

function AgentTree({ pathname, collapsed }: { pathname: string; collapsed: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => agents.list(),
    refetchInterval: 5_000,
  });

  const screensQ = useQuery({
    queryKey: ["screens"],
    queryFn: screens.list,
    refetchInterval: 30_000,
  });
  const allScreens = screensQ.data ?? [];
  const currentScreenId = /^\/screens\/([^/?]+)/.exec(pathname)?.[1] ?? null;
  const agentsById = useMemo(
    () => new Map((agentsQ.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQ.data],
  );

  // Recents: agents and screens as one recency-sorted list (pinned agents
  // float to the top), so the sidebar has a single mental model instead of
  // "agents grouped by host" plus a separate "screens" shelf.
  // Pinned agents render in their own group above the "Recents" label; the
  // rest sort by recency. Recency keys off last *input* (and screen edits),
  // not output, so a chattering agent doesn't reshuffle the list every tick.
  const { pinnedItems, recentItems } = useMemo(() => {
    const agentItems: RecentItem[] = (agentsQ.data ?? []).map((agent) => ({
      kind: "agent",
      id: agent.id,
      recency: agentRecency(agent),
      pinned: Boolean(agent.pinned_at),
      agent,
    }));
    const screenItems: RecentItem[] = allScreens.map((item) => ({
      kind: "screen",
      id: item.id,
      recency: screenRecency(item, agentsById),
      pinned: Boolean(item.pinned_at),
      screen: item,
    }));
    const all = [...agentItems, ...screenItems];
    const byRecency = (a: RecentItem, b: RecentItem) => b.recency - a.recency;
    return {
      pinnedItems: all.filter((item) => item.pinned).sort(byRecency),
      recentItems: all.filter((item) => !item.pinned).sort(byRecency),
    };
  }, [agentsQ.data, allScreens, agentsById]);

  const [actionError, setActionError] = useState<string | null>(null);

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
      setActionError(null);
      invalidate(id);
      if (pathname === `/agents/${id}`) router.push("/agents");
    },
    onError: (err) => setActionError(String(err)),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => agents.remove(id),
    onSuccess: (_result, id) => {
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
  const deleteScreenM = useMutation({
    mutationFn: (screenId: string) => screens.remove(screenId),
    onSuccess: (_result, screenId) => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["screens"] });
      if (pathname === `/screens/${screenId}`) router.push("/agents");
    },
    onError: (err) => setActionError(String(err)),
  });
  const pinScreenM = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => screens.update(id, { pinned }),
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["screens"] });
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
  const screenBusy = deleteScreenM.isPending || pinScreenM.isPending;

  const promptRename = (agent: Agent) => {
    const next = prompt("Rename agent", agent.name ?? agentTitle(agent));
    if (next === null) return;
    const name = next.trim();
    if (!name || name === agent.name) return;
    renameM.mutate({ id: agent.id, name });
  };

  const renderItem = (item: RecentItem) =>
    item.kind === "screen" ? (
      <ScreenRow
        key={`screen-${item.id}`}
        screen={item.screen}
        agentsById={agentsById}
        collapsed={collapsed}
        active={currentScreenId === item.id}
        busy={screenBusy}
        onPin={() => pinScreenM.mutate({ id: item.id, pinned: !item.screen.pinned_at })}
        onDelete={() => {
          if (confirm(`Delete screen ${item.screen.name}?`)) deleteScreenM.mutate(item.id);
        }}
      />
    ) : (
      <AgentRow
        key={`agent-${item.id}`}
        agent={item.agent}
        collapsed={collapsed}
        active={pathname === `/agents/${item.id}`}
        // Always open the full agent view — even when the agent is a pane on
        // the screen you're viewing. To jump back into the screen, use the
        // membership chip in the agent header or the pane itself.
        href={`/agents/${item.id}`}
        busy={busy}
        onRename={() => promptRename(item.agent)}
        onPin={() => pinM.mutate({ id: item.id, pinned: !item.agent.pinned_at })}
        onRestart={() => {
          if (confirm(`Restart ${agentTitle(item.agent)}?`)) restartM.mutate(item.id);
        }}
        onArchive={() => archiveM.mutate(item.id)}
        onDelete={() => {
          if (confirm(`Delete ${agentTitle(item.agent)}?`)) deleteM.mutate(item.id);
        }}
      />
    );

  return (
    <section
      aria-label="Recents"
      className="mt-4 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-2"
    >
      {actionError && !collapsed && (
        <p className="mb-1 px-1.5 text-[11px] text-destructive">{actionError}</p>
      )}
      {pinnedItems.length > 0 && (
        <ul className="mb-1">
          <SidebarSectionLabel collapsed={collapsed}>Pinned</SidebarSectionLabel>
          {pinnedItems.map(renderItem)}
        </ul>
      )}
      <ul>
        <SidebarSectionLabel collapsed={collapsed}>Recents</SidebarSectionLabel>
        {recentItems.map(renderItem)}
        {!agentsQ.isLoading &&
          recentItems.length === 0 &&
          pinnedItems.length === 0 &&
          !collapsed && <li className="px-1.5 py-1 text-xs text-muted-foreground">Nothing yet</li>}
      </ul>
    </section>
  );
}

type AgentItem = { kind: "agent"; id: string; recency: number; pinned: boolean; agent: Agent };
type ScreenItem = { kind: "screen"; id: string; recency: number; pinned: boolean; screen: Screen };
type RecentItem = AgentItem | ScreenItem;

function SidebarSectionLabel({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return (
    <li aria-hidden={collapsed}>
      <span
        className={cn(
          "flex items-center overflow-hidden whitespace-nowrap px-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-all",
          collapsed ? "h-4 opacity-0 duration-100" : "h-7 opacity-100 delay-75 duration-150",
        )}
      >
        {children}
      </span>
    </li>
  );
}

function agentRecency(agent: Agent): number {
  // Last *input* (or start), not output — user-driven order that doesn't
  // churn while an agent streams.
  const value = agent.last_input_at ?? agent.started_at;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

const CONN_LABEL: Record<Exclude<AgentConnState, "off">, string> = {
  connected: "Connected",
  warm: "Warm — connected in the background",
  connecting: "Connecting…",
};

/**
 * Whether this browser holds a live connection to the agent, as an edge marker
 * on the row rather than a dot on the icon.
 *
 * The icon already carries the activity dot, and two 8px circles stacked on one
 * 16px glyph read as a single smudge — worse, they encode unrelated things
 * (what the agent is doing vs whether we are attached to it) in the same shape
 * and nearly the same colour. A bar on the row edge is a different axis
 * entirely, so neither has to be told apart from the other.
 */
function PoolConnMarker({ state }: { state: Exclude<AgentConnState, "off"> }) {
  return (
    <span
      aria-hidden
      title={CONN_LABEL[state]}
      className={cn(
        "pointer-events-none absolute left-0 top-1/2 w-[3px] -translate-y-1/2 rounded-r-full transition-all",
        state === "connecting" ? "h-3 animate-pulse bg-amber-400" : "h-5",
        state === "connected" && "bg-emerald-500",
        state === "warm" && "bg-emerald-500/45",
      )}
    />
  );
}

function AgentRow({
  agent,
  collapsed,
  active,
  href,
  busy,
  onRename,
  onPin,
  onRestart,
  onArchive,
  onDelete,
}: {
  agent: Agent;
  collapsed: boolean;
  active: boolean;
  href: string;
  busy: boolean;
  onRename: () => void;
  onPin: () => void;
  onRestart: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const menuHandle = useRef<DropdownMenuHandle>(null);
  const conn = useAgentConnState(agent.id);
  const attached = conn === "connected" || conn === "warm";
  return (
    <li
      className="group/agentrow relative my-0.5"
      onContextMenu={
        collapsed
          ? undefined
          : (event) => {
              event.preventDefault();
              menuHandle.current?.openAt(event.clientX, event.clientY);
            }
      }
    >
      <RailTooltip
        label={`${agentTitle(agent)} · ${agentActivityDetail(agent)}${
          conn === "off" ? "" : ` · ${CONN_LABEL[conn]}`
        }`}
        disabled={!collapsed}
      >
        <Link
          href={href}
          aria-current={active ? "page" : undefined}
          draggable
          onDragStart={(event) => {
            setAgentDragData(event.dataTransfer, agent.id, agentTitle(agent));
          }}
          className={cn(
            rowClass(active),
            "h-10",
            !collapsed && "pr-7",
            // An attached agent is one you are already holding open; let it
            // read at full strength instead of the resting muted tone.
            attached && !active && "text-foreground",
          )}
        >
          <IconSlot>
            <span className="relative">
              <AgentKindIcon agent={agent} />
              <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5" />
            </span>
          </IconSlot>
          <RowLabel collapsed={collapsed}>
            <span className="flex items-center gap-1 text-xs font-medium leading-4">
              <span className="truncate">{agentTitle(agent)}</span>
              {agent.pinned_at && (
                <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
              )}
            </span>
            <span className="block truncate text-[10px] leading-3 opacity-70">
              {agentActivityDetail(agent)}
            </span>
          </RowLabel>
        </Link>
      </RailTooltip>
      {conn !== "off" && <PoolConnMarker state={conn} />}
      {!collapsed && (
        <DropdownMenu
          ref={menuHandle}
          className="absolute right-1 top-1/2 -translate-y-1/2"
          menuClassName="w-44"
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`${agentTitle(agent)} actions`}
              className={cn(
                "grid size-6 place-items-center rounded-md text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground",
                "opacity-0 focus-visible:opacity-100 group-hover/agentrow:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100",
              )}
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </button>
          )}
        >
          <DropdownMenuItem disabled={busy} onSelect={onRename}>
            <Pencil className="size-4" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onPin}>
            {agent.pinned_at ? (
              <PinOff className="size-4" aria-hidden />
            ) : (
              <Pin className="size-4" aria-hidden />
            )}
            {agent.pinned_at ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onRestart}>
            <RotateCcw className="size-4" aria-hidden />
            Restart
          </DropdownMenuItem>
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
      )}
    </li>
  );
}

function ScreenRow({
  screen,
  agentsById,
  collapsed,
  active,
  busy,
  onPin,
  onDelete,
}: {
  screen: Screen;
  agentsById: Map<string, Agent>;
  collapsed: boolean;
  active: boolean;
  busy: boolean;
  onPin: () => void;
  onDelete: () => void;
}) {
  const paneCount = screenPaneCount(screen);
  const attention = screenAttentionCount(screen, agentsById);
  const menuHandle = useRef<DropdownMenuHandle>(null);
  return (
    <li
      className="group/agentrow relative my-0.5"
      onContextMenu={
        collapsed
          ? undefined
          : (event) => {
              event.preventDefault();
              menuHandle.current?.openAt(event.clientX, event.clientY);
            }
      }
    >
      <RailTooltip label={`${screen.name} · ${paneCount} panes`} disabled={!collapsed}>
        <Link
          href={`/screens/${screen.id}`}
          aria-current={active ? "page" : undefined}
          className={cn(rowClass(active), "h-10", !collapsed && "pr-7")}
        >
          <IconSlot>
            <span className="relative">
              <ScreenIcon paneCount={paneCount} />
              {attention > 0 && (
                <span className="absolute -right-1 -top-1 size-2 rounded-full bg-amber-400" />
              )}
            </span>
          </IconSlot>
          <RowLabel collapsed={collapsed}>
            <span className="flex items-center gap-1 text-xs font-medium leading-4">
              <span className={cn("truncate", screen.ephemeral && "italic opacity-80")}>
                {screen.name}
              </span>
              {screen.pinned_at && (
                <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
              )}
              {attention > 0 && (
                <span className="shrink-0 rounded-full bg-amber-400/20 px-1 text-[9px] font-semibold text-amber-500">
                  {attention}
                </span>
              )}
            </span>
            <span className="block truncate text-[10px] leading-3 opacity-70">
              {paneCount} {paneCount === 1 ? "pane" : "panes"}
              {screen.ephemeral ? " · temporary" : ""}
            </span>
          </RowLabel>
        </Link>
      </RailTooltip>
      {!collapsed && (
        <DropdownMenu
          ref={menuHandle}
          className="absolute right-1 top-1/2 -translate-y-1/2"
          menuClassName="w-44"
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`${screen.name} actions`}
              className={cn(
                "grid size-6 place-items-center rounded-md text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground",
                "opacity-0 focus-visible:opacity-100 group-hover/agentrow:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100",
              )}
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </button>
          )}
        >
          <DropdownMenuItem href={`/screens/${screen.id}`}>
            <LayoutGrid className="size-4" aria-hidden />
            Open screen
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onPin}>
            {screen.pinned_at ? (
              <PinOff className="size-4" aria-hidden />
            ) : (
              <Pin className="size-4" aria-hidden />
            )}
            {screen.pinned_at ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={busy} onSelect={onDelete}>
            <Trash2 className="size-4" aria-hidden />
            Delete screen
          </DropdownMenuItem>
        </DropdownMenu>
      )}
    </li>
  );
}
