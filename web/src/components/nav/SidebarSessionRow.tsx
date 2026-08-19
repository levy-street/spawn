"use client";

import { ExternalLink, MoreHorizontal, Pencil, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { SidebarIconSlot, SidebarRowLabel, sidebarRowClass } from "@/components/nav/sidebar-parts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  type DropdownMenuHandle,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SessionStatusDot } from "@/components/ui/status";
import type { Session } from "@/lib/api";
import { highlightStore, useHighlightedSession } from "@/lib/highlight-store";
import { sessionTitle } from "@/lib/sessions";
import { cn } from "@/lib/utils";

export function SidebarSessionRow({
  session,
  workspaceId,
  active,
  busy,
  onNavigate,
  onRename,
  onRestart,
  onClose,
}: {
  session: Session;
  workspaceId: string;
  active: boolean;
  busy: boolean;
  onNavigate?: () => void;
  onRename: (name: string) => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<DropdownMenuHandle>(null);
  const highlightedSessionId = useHighlightedSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name ?? sessionTitle(session));

  useEffect(() => {
    if (!editing) setDraft(session.name ?? sessionTitle(session));
  }, [editing, session]);

  const submitRename = (event?: FormEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next && next !== session.name) onRename(next);
    setEditing(false);
  };

  return (
    <li
      className="group/session relative"
      onMouseEnter={() => highlightStore.set(session.id)}
      onMouseLeave={() => highlightStore.clear()}
      onContextMenu={(event) => {
        event.preventDefault();
        menuRef.current?.openAt(event.clientX, event.clientY);
      }}
    >
      {editing ? (
        <form onSubmit={submitRename} className="flex h-(--row-h) items-center gap-1 pl-9 pr-1">
          <Input
            autoFocus
            aria-label={`Rename ${sessionTitle(session)}`}
            className="h-7 min-w-0 flex-1 px-2 text-xs"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => submitRename()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
        </form>
      ) : (
        <Link
          href={`/w/${workspaceId}?focus=${session.id}`}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(
            sidebarRowClass(active),
            "pl-5 pr-7 text-xs",
            highlightedSessionId === session.id && "bg-accent text-accent-foreground",
          )}
        >
          <SidebarIconSlot>
            <span className="relative">
              <AgentIcon command={session.foreground_command} size={20} />
              <SessionStatusDot session={session} className="absolute -bottom-0.5 -right-0.5" />
            </span>
          </SidebarIconSlot>
          <SidebarRowLabel collapsed={false} className="font-medium">
            {sessionTitle(session)}
          </SidebarRowLabel>
        </Link>
      )}

      {!editing && (
        <DropdownMenu
          ref={menuRef}
          className="absolute right-1 top-1/2 -translate-y-1/2"
          menuClassName="w-48"
          renderTrigger={(props) => (
            <Button
              {...props}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${sessionTitle(session)} actions`}
              className="size-6 opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </Button>
          )}
        >
          <DropdownMenuItem href={`/sessions/${session.id}`}>
            <ExternalLink className="size-4" aria-hidden />
            Open full screen
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onRestart}>
            <RotateCcw className="size-4" aria-hidden />
            Restart
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={busy} onSelect={onClose}>
            <Trash2 className="size-4" aria-hidden />
            Close
          </DropdownMenuItem>
        </DropdownMenu>
      )}
    </li>
  );
}
