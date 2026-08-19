"use client";

import { Pin } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { YoloBadge } from "@/components/agents/YoloBadge";
import { type AgentConnState, useAgentConnState } from "@/components/terminal/LiveTerminalProvider";
import { AgentStatusDot } from "@/components/ui/status";
import {
  agentActivityDetail,
  agentActivityLabel,
  agentNeedsAttention,
  agentTitle,
  isYoloArgv,
} from "@/lib/agents";
import type { Agent } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Live connection indicator, distinct from the activity dot. Shared across the
 *  agents list, dashboard, and the in-session switcher so "connected" reads the
 *  same everywhere. */
export function AgentConnPip({ state, className }: { state: AgentConnState; className?: string }) {
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
      className={cn("size-2 shrink-0 rounded-full", cls, className)}
    />
  );
}

/** Amber pulse when an agent is waiting on input, red when it has exited. */
export function AgentAttentionDot({ agent }: { agent: Agent }) {
  const attention = agentNeedsAttention(agent);
  if (!attention) return null;
  return (
    <span
      role="img"
      title={attention === "dead" ? "Agent exited" : "Awaiting input"}
      aria-label={attention === "dead" ? "Agent exited" : "Awaiting input"}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        attention === "dead" ? "bg-red-500" : "animate-pulse bg-amber-400",
      )}
    />
  );
}

/**
 * One agent as a mobile-first list row: kind icon + activity dot, title with
 * attention/pin/status badges, and a meta line that keeps the live connection
 * pip, host, and activity visible at every width (the previous list hid host
 * and activity below `sm`). Whole row links to the agent; `trailing` carries a
 * row-specific control (e.g. the actions menu) outside the link.
 */
export function AgentListRow({
  agent,
  href,
  trailing,
  badges,
}: {
  agent: Agent;
  href: string;
  trailing?: ReactNode;
  badges?: ReactNode;
}) {
  const conn = useAgentConnState(agent.id);
  return (
    <li className="group flex items-center border-b border-border transition-colors last:border-b-0 hover:bg-accent/40">
      <Link
        href={href}
        aria-label={`Open ${agentTitle(agent)}`}
        className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-3 pr-1"
      >
        <span className="relative shrink-0">
          <AgentKindIcon agent={agent} className="size-9" iconClassName="size-4.5" />
          <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{agentTitle(agent)}</span>
            <AgentAttentionDot agent={agent} />
            {agent.pinned_at && (
              <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
            )}
            {isYoloArgv(agent.argv) && <YoloBadge />}
            {badges}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <AgentConnPip state={conn} />
            <span className="truncate">
              {`${agent.host_name ?? "?"} · ${agentActivityDetail(agent)}`}
            </span>
          </span>
          <span className="sr-only">{agentActivityLabel(agent)}</span>
        </span>
      </Link>
      {trailing}
    </li>
  );
}
