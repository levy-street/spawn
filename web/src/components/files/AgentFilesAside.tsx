"use client";

import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { FileExplorer } from "@/components/files/FileExplorer";
import { agentTitle } from "@/lib/agents";
import type { Agent } from "@/lib/api";

/** Files side panel labeled with the agent it browses — on screens the
 *  focused pane changes underneath it, so the identity line matters. */
export function AgentFilesAside({ agent }: { agent: Agent }) {
  return (
    <aside
      aria-label={`Files panel for ${agentTitle(agent)}`}
      className="hidden w-72 shrink-0 flex-col border-l border-border md:flex"
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 bg-card/60 px-2">
        <AgentKindIcon agent={agent} className="size-5 rounded-md" iconClassName="size-3" />
        <span className="min-w-0 truncate text-xs font-medium">{agentTitle(agent)}</span>
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {agent.cwd}
        </span>
      </div>
      <FileExplorer
        key={`${agent.host_id}:${agent.cwd}`}
        hostId={agent.host_id}
        rootPath={agent.cwd}
        dense
        className="min-h-0 flex-1"
      />
    </aside>
  );
}
