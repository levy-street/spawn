"use client";

import { ChevronsDownUp, Ellipsis, FolderPlus, RefreshCw, Upload } from "lucide-react";
import { useRef } from "react";
import { FileExplorer, type FileExplorerHandle } from "@/components/files/FileExplorer";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
  const explorerRef = useRef<FileExplorerHandle>(null);
  return (
    <div className={cn("flex min-h-0 flex-col bg-background", className)}>
      {/* One row carries everything: identity, the working path, and the
          explorer's actions folded into a menu — no second toolbar. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card/70 px-2.5">
        <AgentIcon command={session.foreground_command} size={20} className="rounded-md" />
        <span className="min-w-0 truncate text-xs font-medium">{sessionTitle(session)}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted-foreground">
          {session.cwd}
        </span>
        <DropdownMenu
          align="end"
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label="File actions"
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Ellipsis className="size-4" aria-hidden />
            </button>
          )}
        >
          <DropdownMenuItem onSelect={() => explorerRef.current?.newFolder()}>
            <FolderPlus className="size-4" aria-hidden />
            New folder
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => explorerRef.current?.upload()}>
            <Upload className="size-4" aria-hidden />
            Upload files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => explorerRef.current?.refresh()}>
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => explorerRef.current?.collapseAll()}>
            <ChevronsDownUp className="size-4" aria-hidden />
            Collapse all
          </DropdownMenuItem>
        </DropdownMenu>
      </div>
      <FileExplorer
        ref={explorerRef}
        key={`${session.host_id}:${session.cwd}`}
        hostId={session.host_id}
        rootPath={session.cwd}
        dense
        hideHeader
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
