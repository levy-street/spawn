"use client";

import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { SidebarIconSlot, SidebarRowLabel, sidebarRowClass } from "@/components/nav/sidebar-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  type DropdownMenuHandle,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RailTooltip } from "@/components/ui/tooltip";
import type { Workspace } from "@/lib/api";
import { cn } from "@/lib/utils";

function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    (words.length > 1
      ? `${words[0]?.[0]}${words[1]?.[0]}`
      : words[0]?.slice(0, 2)
    )?.toUpperCase() || "W"
  );
}

export function SidebarWorkspaceRow({
  workspace,
  active,
  collapsed,
  expanded,
  attentionCount,
  busy,
  canMoveUp,
  canMoveDown,
  onNavigate,
  onToggle,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
  children,
}: {
  workspace: Workspace;
  active: boolean;
  collapsed: boolean;
  expanded: boolean;
  attentionCount: number;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onNavigate?: () => void;
  onToggle: () => void;
  onRename: (name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  children?: ReactNode;
}) {
  const menuRef = useRef<DropdownMenuHandle>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workspace.name);

  useEffect(() => {
    if (!editing) setDraft(workspace.name);
  }, [editing, workspace.name]);

  const submitRename = (event?: FormEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next && next !== workspace.name) onRename(next);
    setEditing(false);
  };

  if (collapsed) {
    return (
      <li className="flex justify-center py-0.5">
        <RailTooltip
          label={`${workspace.name}${attentionCount > 0 ? ` · ${attentionCount} need attention` : ""}`}
        >
          <Link
            href={`/w/${workspace.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative grid size-9 place-items-center rounded-lg border text-[11px] font-semibold tracking-tight transition-colors",
              active
                ? "border-foreground/20 bg-accent text-accent-foreground"
                : "border-border bg-muted/50 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {workspaceInitials(workspace.name)}
            {attentionCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-warning" />
            )}
          </Link>
        </RailTooltip>
      </li>
    );
  }

  return (
    <li className="group/workspace relative">
      <div>
        {editing ? (
          <form onSubmit={submitRename} className="flex h-(--row-h) items-center gap-1 px-1">
            <Input
              autoFocus
              aria-label={`Rename ${workspace.name}`}
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
            href={`/w/${workspace.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(sidebarRowClass(active), "pr-14")}
          >
            <SidebarIconSlot>
              <span className="grid size-6 place-items-center rounded-md border border-border bg-muted/50 text-[10px] font-semibold text-muted-foreground">
                {workspaceInitials(workspace.name)}
              </span>
            </SidebarIconSlot>
            <SidebarRowLabel collapsed={false} className="font-medium">
              {workspace.name}
            </SidebarRowLabel>
            {attentionCount > 0 && (
              <Badge variant="warning" className="mr-1 px-1.5 py-0 text-[10px]">
                {attentionCount}
              </Badge>
            )}
          </Link>
        )}

        {!editing && (
          <>
            <DropdownMenu
              ref={menuRef}
              className="absolute right-7 top-1/2 -translate-y-1/2"
              menuClassName="w-44"
              renderTrigger={(props) => (
                <Button
                  {...props}
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`${workspace.name} actions`}
                  className="size-6 opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
                >
                  <MoreHorizontal className="size-3.5" aria-hidden />
                </Button>
              )}
            >
              <DropdownMenuItem disabled={busy} onSelect={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy || !canMoveUp} onSelect={onMoveUp}>
                <ArrowUp className="size-4" aria-hidden />
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy || !canMoveDown} onSelect={onMoveDown}>
                <ArrowDown className="size-4" aria-hidden />
                Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive disabled={busy} onSelect={onDelete}>
                <Trash2 className="size-4" aria-hidden />
                Delete
              </DropdownMenuItem>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={expanded ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
              aria-expanded={expanded}
              onClick={onToggle}
              className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground"
            >
              {expanded ? (
                <ChevronDown className="size-3.5" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden />
              )}
            </Button>
          </>
        )}
      </div>
      {expanded && <ul className="space-y-0.5 pb-1">{children}</ul>}
    </li>
  );
}
