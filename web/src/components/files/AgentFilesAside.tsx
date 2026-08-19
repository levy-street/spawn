"use client";

import { FileExplorer } from "@/components/files/FileExplorer";
import { AgentIcon } from "@/components/icons/AgentIcon";

/**
 * Transitional compatibility export for doomed Phase-C callers. New surfaces
 * use SessionFilesAside; keeping this structural avoids importing retired
 * agent helpers from a surviving files component.
 */
export function AgentFilesAside({
  agent,
}: {
  agent: {
    id: string;
    name?: string | null;
    kind?: string | null;
    command?: string | null;
    foreground_command?: string | null;
    host_id?: string;
    cwd?: string;
  };
}) {
  const title = agent.name?.trim() || agent.id.slice(0, 8);
  if (!agent.host_id || !agent.cwd) return null;
  return (
    <aside
      aria-label={`Files panel for ${title}`}
      className="hidden w-72 shrink-0 flex-col border-l border-border md:flex"
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 bg-card/60 px-2">
        <AgentIcon
          kind={agent.kind}
          command={agent.foreground_command ?? agent.command}
          size={20}
          className="rounded-md"
        />
        <span className="min-w-0 truncate text-xs font-medium">{title}</span>
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
