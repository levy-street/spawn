"use client";

import { Archive, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SidebarIconSlot,
  SidebarRowLabel,
  sidebarRowClass,
  WorkspaceAvatar,
} from "@/components/nav/sidebar-parts";
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

export function SidebarWorkspaceRow({
  workspace,
  active,
  collapsed,
  attentionCount,
  busy,
  onNavigate,
  onRename,
  onArchive,
  onDelete,
  onRowPointerDown,
}: {
  workspace: Workspace;
  active: boolean;
  collapsed: boolean;
  attentionCount: number;
  busy: boolean;
  onNavigate?: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Arms the sidebar's drag-to-reorder; a plain click still navigates. */
  onRowPointerDown?: (event: ReactPointerEvent<HTMLLIElement>) => void;
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
      <li className="flex justify-center py-1">
        <RailTooltip
          label={`${workspace.name}${attentionCount > 0 ? ` · ${attentionCount} need attention` : ""}`}
        >
          <Link
            href={`/w/${workspace.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className="relative"
          >
            <WorkspaceAvatar
              name={workspace.name}
              rail
              className={cn(
                "transition-colors",
                active
                  ? "border-foreground/20 bg-accent text-accent-foreground"
                  : "border-border bg-muted/50 text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            />
            {attentionCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-warning" />
            )}
          </Link>
        </RailTooltip>
      </li>
    );
  }

  return (
    <li
      data-workspace-row={workspace.id}
      onPointerDown={editing ? undefined : onRowPointerDown}
      // The row wraps an anchor, whose native HTML5 drag would otherwise
      // hijack the pointer and freeze the reorder gesture.
      onDragStart={(event) => event.preventDefault()}
    >
      <div className="group/workspace relative">
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
            className={cn(sidebarRowClass(active), "pr-10 [@media(pointer:coarse)]:pr-16")}
          >
            <SidebarIconSlot>
              <WorkspaceAvatar name={workspace.name} />
            </SidebarIconSlot>
            <SidebarRowLabel collapsed={false} className="font-medium">
              {workspace.name}
            </SidebarRowLabel>
          </Link>
        )}

        {!editing && (
          <>
            {/* The attention badge and the actions kebab share one right-edge
                slot: the badge holds it at rest, hovering the row swaps in the
                kebab. Coarse pointers cannot hover, so there the badge steps
                one slot left and the kebab stays put. */}
            {attentionCount > 0 && (
              <Badge
                variant="warning"
                className={cn(
                  "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 px-2 py-0 text-[11px] transition-opacity",
                  "group-hover/workspace:opacity-0 group-focus-within/workspace:opacity-0",
                  "[@media(pointer:coarse)]:right-10 [@media(pointer:coarse)]:opacity-100",
                )}
              >
                {attentionCount}
              </Badge>
            )}
            <DropdownMenu
              ref={menuRef}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              menuClassName="w-44"
              renderTrigger={(props) => (
                <Button
                  {...props}
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`${workspace.name} actions`}
                  className="size-7 opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
                >
                  <MoreHorizontal className="size-4" aria-hidden />
                </Button>
              )}
            >
              <DropdownMenuItem disabled={busy} onSelect={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden />
                Rename
              </DropdownMenuItem>
              {/* Above the separator: archiving is the reversible one. */}
              <DropdownMenuItem disabled={busy} onSelect={onArchive}>
                <Archive className="size-4" aria-hidden />
                Archive
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive disabled={busy} onSelect={onDelete}>
                <Trash2 className="size-4" aria-hidden />
                Delete
              </DropdownMenuItem>
            </DropdownMenu>
          </>
        )}
      </div>
    </li>
  );
}
