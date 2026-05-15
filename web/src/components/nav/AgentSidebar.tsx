"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil, Pin, PinOff, Plus, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { Button } from "@/components/ui/button";
import { agentActivityDetail, agentActivityLabel, agentCommand, agentTitle } from "@/lib/agents";
import { type Agent, agents } from "@/lib/api";
import { cn } from "@/lib/utils";

const ACTION_TOOLBAR_BOUNDARY_OVERLAP = 8;

export function AgentSidebar({
  pathname,
  collapsed = false,
}: {
  pathname: string;
  collapsed?: boolean;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({
    queryKey: ["agents"],
    queryFn: () => agents.list(),
    refetchInterval: 5_000,
  });
  const [actionTarget, setActionTarget] = useState<{
    agentId: string;
    left: number;
    top: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeActionsTimer = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const suppressClickAgentId = useRef<string | null>(null);

  const visible = useMemo(() => sortAgentsByPinnedLastInput(q.data ?? []), [q.data]);
  const actionAgent = actionTarget
    ? (visible.find((agent) => agent.id === actionTarget.agentId) ?? null)
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

  const actionToolbar = actionAgent ? (
    <div
      role="toolbar"
      aria-label={`${agentTitle(actionAgent)} actions`}
      className="fixed z-40 flex -translate-y-1/2 items-center rounded-md border border-border bg-card/95 p-0.5 shadow-md backdrop-blur"
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
  ) : null;

  if (collapsed) {
    return (
      <section className="mt-5 min-h-0 px-1">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="mb-2 size-10"
          aria-label="New agent"
          title="New agent"
        >
          <Link href="/agents">
            <Plus className="size-4" />
          </Link>
        </Button>
        <ul className="max-h-[48vh] space-y-1 overflow-y-auto">
          {visible.map((agent, index) => {
            const active = pathname === `/agents/${agent.id}`;
            return (
              <Fragment key={agent.id}>
                {shouldShowPinnedDivider(visible, index) && <PinnedDivider collapsed />}
                <li
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
                  <Link
                    href={`/agents/${agent.id}`}
                    aria-current={active ? "page" : undefined}
                    title={`${agentTitle(agent)} · ${agentCommand(agent)} · ${agentActivityDetail(agent)} · ${agent.cwd}`}
                    onClick={(event) => onAgentClick(agent, event)}
                    className={cn(
                      "relative flex size-10 items-center justify-center rounded-md transition-colors",
                      active ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <AgentKindIcon agent={agent} className="size-8" iconClassName="size-4" />
                    <AgentStatusDot agent={agent} className="absolute bottom-1 right-1" />
                  </Link>
                </li>
              </Fragment>
            );
          })}
        </ul>
        {actionToolbar}
      </section>
    );
  }

  return (
    <section className="mt-5 min-h-0 px-2">
      <div className="mb-2 flex items-center justify-between px-2">
        <h2 className="text-[11px] font-medium uppercase text-muted-foreground">Agents</h2>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="New agent"
          title="New agent"
        >
          <Link href="/agents">
            <Plus className="size-4" />
          </Link>
        </Button>
      </div>
      {actionError && <p className="mb-2 px-2 text-[11px] text-destructive">{actionError}</p>}
      <ul className="max-h-[48vh] space-y-1 overflow-y-auto pr-1">
        {visible.map((agent, index) => {
          const active = pathname === `/agents/${agent.id}`;
          return (
            <Fragment key={agent.id}>
              {shouldShowPinnedDivider(visible, index) && <PinnedDivider />}
              <li
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
                <Link
                  href={`/agents/${agent.id}`}
                  aria-current={active ? "page" : undefined}
                  title={`${agentTitle(agent)} · ${agentCommand(agent)} · ${agentActivityDetail(agent)} · ${agent.cwd}`}
                  onClick={(event) => onAgentClick(agent, event)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <div className="relative shrink-0">
                    <AgentKindIcon agent={agent} />
                    <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5" />
                  </div>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{agentTitle(agent)}</span>
                    <span className="block truncate text-[10px] opacity-70">
                      {agentActivityDetail(agent)}
                    </span>
                  </span>
                </Link>
              </li>
            </Fragment>
          );
        })}
        {!q.isLoading && visible.length === 0 && (
          <li className="px-2 py-1 text-xs text-muted-foreground">No agents</li>
        )}
      </ul>
      {actionToolbar}
    </section>
  );
}

function shouldShowPinnedDivider(agentList: Agent[], index: number): boolean {
  if (index === 0) return false;
  return Boolean(agentList[index - 1]?.pinned_at) && !agentList[index]?.pinned_at;
}

function PinnedDivider({ collapsed = false }: { collapsed?: boolean }) {
  if (collapsed) {
    return (
      <li aria-hidden="true" className="py-1">
        <div className="mx-auto h-px w-8 bg-border" />
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span>Recent</span>
      <span className="h-px flex-1 bg-border" />
    </li>
  );
}

function sortAgentsByPinnedLastInput(agentList: Agent[]): Agent[] {
  return [...agentList].sort((a, b) => {
    if (Boolean(a.pinned_at) !== Boolean(b.pinned_at)) return a.pinned_at ? -1 : 1;
    const byInput = lastInputTime(b) - lastInputTime(a);
    if (byInput !== 0) return byInput;
    return agentTitle(a).localeCompare(agentTitle(b));
  });
}

function lastInputTime(agent: Agent): number {
  const value = agent.last_input_at ?? agent.started_at;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function AgentStatusDot({ agent, className }: { agent: Agent; className?: string }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full border border-card",
        agent.activity_state === "active"
          ? "bg-green-500"
          : agent.activity_state === "waiting"
            ? "bg-sky-500"
            : agent.activity_state === "input_sent"
              ? "bg-violet-500"
              : agent.activity_state === "starting"
                ? "bg-yellow-500"
                : agent.activity_state === "quiet"
                  ? "bg-zinc-400"
                  : "bg-zinc-600",
        className,
      )}
      role="img"
      aria-label={agentActivityLabel(agent)}
      title={agentActivityDetail(agent)}
    />
  );
}
