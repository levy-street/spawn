"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Ellipsis,
  ExternalLink,
  GripVertical,
  Pencil,
  RotateCcw,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { useLiveTerminal } from "@/components/terminal/LiveTerminalProvider";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SessionStatusDot } from "@/components/ui/status";
import { type Session, sessions } from "@/lib/api";
import { highlightStore, useHighlightedSession } from "@/lib/highlight-store";
import { sessionNeedsAttention, sessionTitle } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { ShortcutBar } from "./shortcut-bar";

export type PaneSlotTarget = { el: HTMLElement; stacked: boolean };
export type PaneResizeEdge = "east" | "south" | "southeast";

function writeSessionToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  session: Session,
): void {
  queryClient.setQueryData(["session", session.id], session);
  queryClient.setQueryData<Session[]>(["sessions"], (current) =>
    current?.map((item) => (item.id === session.id ? session : item)),
  );
}

export function SessionPane({
  sessionId,
  session,
  slot,
  focused,
  zoomed,
  paneCount,
  canDrag,
  canMoveUp,
  canMoveDown,
  onFocus,
  onToggleZoom,
  onMoveStart,
  onResizeStart,
  onMoveUp,
  onMoveDown,
  onRemoveFromWorkspace,
  registerHandle,
  onError,
}: {
  sessionId: string;
  session?: Session;
  slot?: PaneSlotTarget;
  focused: boolean;
  zoomed: boolean;
  paneCount: number;
  canDrag: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onFocus: (sessionId: string) => void;
  onToggleZoom: (sessionId: string) => void;
  onMoveStart: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onResizeStart: (
    sessionId: string,
    edge: PaneResizeEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onMoveUp: (sessionId: string) => void;
  onMoveDown: (sessionId: string) => void;
  onRemoveFromWorkspace: (sessionId: string) => void;
  registerHandle: (sessionId: string, getHandle: () => TerminalHandle | null) => void;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const highlighted = useHighlightedSession();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalSurfaceRef = useRef<HTMLDivElement>(null);
  const { attach, getHandle, promptState, subscribeCursorMove } = useLiveTerminal(
    session ? sessionId : null,
  );
  const foregroundCommand = session?.foreground_command;

  useEffect(() => {
    registerHandle(sessionId, getHandle);
    return () => registerHandle(sessionId, () => null);
  }, [getHandle, registerHandle, sessionId]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host && slot?.el && host.parentElement !== slot.el) slot.el.appendChild(host);
  }, [slot]);

  useEffect(
    () => () => {
      hostRef.current?.parentElement?.removeChild(hostRef.current);
      if (highlightStore.get() === sessionId) highlightStore.clear();
    },
    [sessionId],
  );

  useEffect(() => {
    if (foregroundCommand === undefined) return;
    const frame = requestAnimationFrame(() => getHandle()?.resetPromptState());
    return () => cancelAnimationFrame(frame);
  }, [foregroundCommand, getHandle]);

  const renameM = useMutation({
    mutationFn: (name: string | null) => sessions.update(sessionId, { name }),
    onSuccess: (saved) => {
      writeSessionToCache(queryClient, saved);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setEditingName(false);
      onError(null);
    },
    onError: (error) => onError(String(error)),
  });
  const restartM = useMutation({
    mutationFn: () => sessions.restart(sessionId),
    onSuccess: (saved) => {
      writeSessionToCache(queryClient, saved);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onError(null);
      requestAnimationFrame(() => getHandle()?.focus());
    },
    onError: (error) => onError(String(error)),
  });
  const closeM = useMutation({
    mutationFn: () => sessions.remove(sessionId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["session", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onRemoveFromWorkspace(sessionId);
      onError(null);
    },
    onError: (error) => onError(String(error)),
  });

  const closeSession = async () => {
    if (!session) return;
    const accepted = await confirm({
      title: `Close ${sessionTitle(session)}?`,
      body: "This kills the shell process and permanently removes the session.",
      confirmLabel: "Close session",
      destructive: true,
    });
    if (accepted) closeM.mutate();
  };

  const submitRename = () => {
    if (!session) return;
    const next = draftName.trim() || null;
    if (next === session.name) {
      setEditingName(false);
      return;
    }
    renameM.mutate(next);
  };

  const sectionCleanupRef = useRef<(() => void) | null>(null);
  const sectionRef = useCallback(
    (element: HTMLElement | null) => {
      sectionCleanupRef.current?.();
      sectionCleanupRef.current = null;
      if (!element) return;
      const focus = () => onFocus(sessionId);
      const enter = () => highlightStore.set(sessionId);
      const leave = () => {
        if (highlightStore.get() === sessionId) highlightStore.clear();
      };
      element.addEventListener("focusin", focus);
      element.addEventListener("pointerdown", focus, true);
      element.addEventListener("pointerenter", enter);
      element.addEventListener("pointerleave", leave);
      sectionCleanupRef.current = () => {
        element.removeEventListener("focusin", focus);
        element.removeEventListener("pointerdown", focus, true);
        element.removeEventListener("pointerenter", enter);
        element.removeEventListener("pointerleave", leave);
      };
    },
    [onFocus, sessionId],
  );

  if (!hostRef.current && typeof document !== "undefined") {
    const host = document.createElement("div");
    host.style.display = "contents";
    hostRef.current = host;
  }
  if (!hostRef.current) return null;

  const title = session ? sessionTitle(session) : "Missing session";
  const attention = session ? sessionNeedsAttention(session) : "dead";
  const stacked = slot?.stacked ?? false;

  return createPortal(
    <section
      ref={sectionRef}
      aria-label={title}
      className={cn(
        "relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background",
        focused && paneCount > 1 && "ring-1 ring-inset ring-ring/70",
        highlighted === sessionId && "ring-2 ring-ring",
      )}
    >
      {attention && <span aria-hidden className="absolute inset-x-0 top-0 z-30 h-px bg-warning" />}
      <header
        role="toolbar"
        aria-label={`${title} pane controls`}
        className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-card/75 px-1.5 select-none"
        onDoubleClick={() => !stacked && onToggleZoom(sessionId)}
      >
        <button
          type="button"
          aria-label={`Move ${title}`}
          title={canDrag ? "Drag to move" : "Pane order"}
          tabIndex={canDrag ? 0 : -1}
          disabled={!canDrag}
          onPointerDown={(event) => onMoveStart(sessionId, event)}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded text-muted-foreground",
            canDrag && "cursor-grab hover:bg-accent hover:text-foreground active:cursor-grabbing",
          )}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        <AgentIcon command={session?.foreground_command} size={22} className="rounded-md" />
        {editingName && session ? (
          <Input
            autoFocus
            aria-label="Session name"
            value={draftName}
            disabled={renameM.isPending}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitRename();
              if (event.key === "Escape") setEditingName(false);
            }}
            className="h-7 min-w-0 flex-1 px-2 text-xs"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        )}
        {session && <SessionStatusDot session={session} />}
        <DropdownMenu
          align="end"
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`${title} options`}
              onDoubleClick={(event) => event.stopPropagation()}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Ellipsis className="size-4" aria-hidden />
            </button>
          )}
        >
          {session && (
            <DropdownMenuItem href={`/sessions/${sessionId}`}>
              <ExternalLink className="size-4" aria-hidden />
              Open full screen
            </DropdownMenuItem>
          )}
          {session && (
            <DropdownMenuItem
              onSelect={() => {
                setDraftName(session.name ?? title);
                setEditingName(true);
              }}
            >
              <Pencil className="size-4" aria-hidden />
              Rename
            </DropdownMenuItem>
          )}
          {session && (
            <DropdownMenuItem disabled={restartM.isPending} onSelect={() => restartM.mutate()}>
              <RotateCcw className="size-4" aria-hidden />
              Restart
            </DropdownMenuItem>
          )}
          {stacked && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMoveUp(sessionId)}>
                <ArrowUp className="size-4" aria-hidden />
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMoveDown(sessionId)}>
                <ArrowDown className="size-4" aria-hidden />
                Move down
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          {session && (
            <DropdownMenuItem destructive disabled={closeM.isPending} onSelect={closeSession}>
              <Trash2 className="size-4" aria-hidden />
              Close session
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => onRemoveFromWorkspace(sessionId)}>
            <Unlink className="size-4" aria-hidden />
            Remove from workspace
          </DropdownMenuItem>
        </DropdownMenu>
      </header>

      {session ? (
        <div ref={terminalSurfaceRef} className="relative min-h-0 flex-1 @container/term">
          <div ref={attach} className="size-full" />
          <ShortcutBar
            session={session}
            promptState={promptState}
            containerRef={terminalSurfaceRef}
            getHandle={getHandle}
            subscribeCursorMove={subscribeCursorMove}
          />
          {(session.status === "exited" || session.status === "killed") && (
            <div className="absolute inset-0 z-20 grid place-items-center bg-background/75 backdrop-blur-[2px]">
              <div className="flex max-w-xs flex-col items-center gap-3 rounded-lg border border-border bg-popover p-4 text-center shadow-lg">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Shell exited</p>
                  <p className="text-xs text-muted-foreground">
                    {session.exit_code === null
                      ? "The session stopped."
                      : `Exit code ${session.exit_code}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={restartM.isPending}
                    onClick={() => restartM.mutate()}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    {restartM.isPending ? "Restarting…" : "Restart"}
                  </button>
                  <button
                    type="button"
                    disabled={closeM.isPending}
                    onClick={closeSession}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent disabled:opacity-50"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
          This session no longer exists. Remove it from the workspace.
        </div>
      )}

      {canDrag && !zoomed && (
        <>
          <button
            type="button"
            aria-label={`Resize ${title} horizontally`}
            onPointerDown={(event) => onResizeStart(sessionId, "east", event)}
            className="absolute inset-y-10 right-0 z-20 w-2 cursor-col-resize touch-none opacity-0"
          />
          <button
            type="button"
            aria-label={`Resize ${title} vertically`}
            onPointerDown={(event) => onResizeStart(sessionId, "south", event)}
            className="absolute inset-x-0 bottom-0 z-20 h-2 cursor-row-resize touch-none opacity-0"
          />
          <button
            type="button"
            aria-label={`Resize ${title}`}
            onPointerDown={(event) => onResizeStart(sessionId, "southeast", event)}
            className="absolute bottom-0 right-0 z-30 size-4 cursor-nwse-resize touch-none"
          >
            <span className="absolute bottom-1 right-1 size-2 border-b border-r border-muted-foreground/70" />
          </button>
        </>
      )}
    </section>,
    hostRef.current,
  );
}
