"use client";

import { FileExplorer } from "@/components/files/FileExplorer";
import { AgentIcon } from "@/components/icons/AgentIcon";
import type { Session } from "@/lib/api";
import { sessionTitle } from "@/lib/sessions";
import { cn } from "@/lib/utils";

export function SessionFilesPanel({
  session,
  className,
}: {
  session: Session;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-col bg-background", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card/70 px-2.5">
        <AgentIcon command={session.foreground_command} size={20} className="rounded-md" />
        <span className="min-w-0 truncate text-xs font-medium">{sessionTitle(session)}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted-foreground">
          {session.cwd}
        </span>
      </div>
      <FileExplorer
        key={`${session.host_id}:${session.cwd}`}
        hostId={session.host_id}
        rootPath={session.cwd}
        dense
        className="min-h-0 flex-1"
      />
    </div>
  );
}

export function SessionFilesAside({ session }: { session: Session }) {
  return (
    <aside
      aria-label={`Files for ${sessionTitle(session)}`}
      className="hidden w-72 shrink-0 border-l border-border md:block"
    >
      <SessionFilesPanel session={session} className="size-full" />
    </aside>
  );
}
