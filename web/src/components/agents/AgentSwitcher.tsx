"use client";

import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { type AgentConnState, useAgentConnState } from "@/components/terminal/LiveTerminalProvider";
import { BottomSheet } from "@/components/ui/sheet";
import { AgentStatusDot } from "@/components/ui/status";
import {
  agentActivityDetail,
  agentNeedsAttention,
  agentTitle,
  isAgentArchived,
} from "@/lib/agents";
import type { Agent } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Recency-ordered live agents plus the current agent's position and its
 * swipe neighbours. `prevId` is the more-recent agent (swipe right), `nextId`
 * the older one (swipe left) — matching a left-to-right recency carousel.
 */
export function useAgentSwitcher(agents: Agent[] | undefined, currentId: string | undefined) {
  return useMemo(() => {
    const list = (agents ?? [])
      .filter((a) => !isAgentArchived(a))
      .sort((a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""));
    const index = list.findIndex((a) => a.id === currentId);
    const prevId = index > 0 ? list[index - 1].id : null;
    const nextId = index >= 0 && index < list.length - 1 ? list[index + 1].id : null;
    return { list, index, prevId, nextId };
  }, [agents, currentId]);
}

/** A live per-agent connection indicator (distinct from the activity dot). */
function ConnPip({ state }: { state: AgentConnState }) {
  const style: Record<AgentConnState, [string, string]> = {
    connected: ["bg-emerald-500", "Connected"],
    warm: ["bg-sky-500", "Warm — connected in the background"],
    connecting: ["bg-amber-400 animate-pulse", "Connecting"],
    off: ["bg-muted-foreground/40", "Not connected"],
  };
  const [cls, label] = style[state];
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={cn("size-2 shrink-0 rounded-full", cls)}
    />
  );
}

function AgentSwitchRow({
  agent,
  active,
  onPick,
}: {
  agent: Agent;
  active: boolean;
  onPick: () => void;
}) {
  const conn = useAgentConnState(agent.id);
  const attention = agentNeedsAttention(agent);
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
          active ? "bg-accent" : "hover:bg-accent/50",
        )}
      >
        <span className="relative shrink-0">
          <AgentKindIcon agent={agent} className="size-7" />
          <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {agentTitle(agent)}
            </span>
            {attention && (
              <span
                title={attention === "dead" ? "Agent exited" : "Awaiting input"}
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  attention === "dead" ? "bg-red-500" : "animate-pulse bg-amber-400",
                )}
              />
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {`${agent.host_name ?? "?"} · ${agentActivityDetail(agent)}`}
          </span>
        </span>
        <ConnPip state={conn} />
      </button>
    </li>
  );
}

/**
 * The bottom-sheet agent switcher: a searchable, recency-ordered list of live
 * agents with activity/attention/connection at a glance. Picking one switches
 * in place (the caller navigates; the warm pool means no reconnect). Doubles as
 * mobile's route to "all agents" / "new agent" without the back-to-list dance.
 */
export function AgentSwitchSheet({
  open,
  onClose,
  list,
  currentId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  list: Agent[];
  currentId: string | undefined;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((a) =>
      `${agentTitle(a)} ${a.host_name ?? ""} ${a.cwd ?? ""}`.toLowerCase().includes(needle),
    );
  }, [query, list]);

  return (
    <BottomSheet open={open} onClose={onClose} ariaLabel="Switch agent" title="Switch agent">
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents"
            aria-label="Search agents"
            className="h-10 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <ul>
        {filtered.map((agent) => (
          <AgentSwitchRow
            key={agent.id}
            agent={agent}
            active={agent.id === currentId}
            onPick={() => {
              onClose();
              if (agent.id !== currentId) onPick(agent.id);
            }}
          />
        ))}
        {filtered.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            No agents match “{query}”
          </li>
        )}
      </ul>
      <div className="mt-1 border-t border-border px-3 py-2">
        <Link
          href="/agents/new"
          onClick={onClose}
          className="flex items-center gap-2 rounded-lg px-2 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
        >
          <Plus className="size-4" aria-hidden /> New agent
        </Link>
      </div>
    </BottomSheet>
  );
}
