"use client";

import {
  ChevronsDownUp,
  Ellipsis,
  ExternalLink,
  FilePlus,
  FolderPlus,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { useRef } from "react";
import { FileBrowser, type FileBrowserHandle } from "@/components/files/FileBrowser";
import { useFilePrefs } from "@/components/files/use-file-prefs";
import { useOpenHostFolder } from "@/components/files/use-open-host-folder";
import { AgentIcon } from "@/components/icons/AgentIcon";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Session } from "@/lib/api";
import {
  FILTER_PLACEHOLDER,
  NEW_FILE_LABEL,
  NEW_FOLDER_LABEL,
  SHOW_HIDDEN_LABEL,
  UPLOAD_FILES_LABEL,
} from "@/lib/files/copy";
import { sessionTitle } from "@/lib/sessions";
import { cn } from "@/lib/utils";

export function SessionFilesPanel({
  session,
  className,
}: {
  session: Session;
  className?: string;
}) {
  const browserRef = useRef<FileBrowserHandle>(null);
  const { showHidden } = useFilePrefs("aside");
  const openHostFolder = useOpenHostFolder();
  return (
    <div className={cn("flex min-h-0 flex-col bg-background", className)}>
      {/* One row carries everything: identity, the working path, and the
          browser's actions folded into a menu — no second toolbar. */}
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
          <DropdownMenuItem onSelect={() => browserRef.current?.newFolder()}>
            <FolderPlus className="size-4" aria-hidden />
            {NEW_FOLDER_LABEL}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => browserRef.current?.newFile()}>
            <FilePlus className="size-4" aria-hidden />
            {NEW_FILE_LABEL}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => browserRef.current?.upload()}>
            <Upload className="size-4" aria-hidden />
            {UPLOAD_FILES_LABEL}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => browserRef.current?.focusFilter()}>
            <Search className="size-4" aria-hidden />
            {FILTER_PLACEHOLDER}
          </DropdownMenuItem>
          <DropdownMenuItem
            checked={showHidden}
            onSelect={() => browserRef.current?.toggleHidden()}
          >
            {SHOW_HIDDEN_LABEL}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => browserRef.current?.refresh()}>
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => browserRef.current?.collapseAll()}>
            <ChevronsDownUp className="size-4" aria-hidden />
            Collapse all
          </DropdownMenuItem>
          {/* The folder is handed over in memory, never put in the link. */}
          <DropdownMenuItem onSelect={() => openHostFolder(session.host_id, session.cwd)}>
            <ExternalLink className="size-4" aria-hidden />
            Open in full browser
          </DropdownMenuItem>
        </DropdownMenu>
      </div>
      <FileBrowser
        ref={browserRef}
        key={`${session.host_id}:${session.cwd}`}
        hostId={session.host_id}
        layout="aside"
        rootPath={session.cwd}
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
