"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Ellipsis,
  ExternalLink,
  Folder,
  Pencil,
  RotateCcw,
  Trash2,
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
import { hosts, type Session, sessions } from "@/lib/api";
import { highlightStore, useHighlightedSession } from "@/lib/highlight-store";
import { basename } from "@/lib/paths";
import { sessionTitle, sessionTitleDetail } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { shellQuote } from "./agent-command";
import { AgentSwitcher } from "./agent-switcher";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { pendingLaunch } from "./pending-launch";
import { runInShell, stillRunningMessage } from "./shell-handoff";

export type PaneSlotTarget = { el: HTMLElement; stacked: boolean };

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
  paneCount,
  canDrag,
  canMoveUp,
  canMoveDown,
  onFocus,
  onToggleZoom,
  onMoveStart,
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
  paneCount: number;
  canDrag: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onFocus: (sessionId: string) => void;
  onToggleZoom: (sessionId: string) => void;
  onMoveStart: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onMoveUp: (sessionId: string) => void;
  onMoveDown: (sessionId: string) => void;
  onRemoveFromWorkspace: (sessionId: string) => void;
  registerHandle: (sessionId: string, getHandle: () => TerminalHandle | null) => void;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const highlighted = useHighlightedSession();
  const [editingName, setEditingName] = useState(false);
  const [selfHovered, setSelfHovered] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 30_000 });
  const paneHost = (hostsQ.data ?? []).find((host) => host.id === session?.host_id) ?? null;
  const [draftName, setDraftName] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { attach, connInfo, getHandle } = useLiveTerminal(session ? sessionId : null);
  const launchedRef = useRef(false);

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

  // An agent picked from the "+" menu starts by being typed into this shell,
  // once its transport can actually carry the keystrokes.
  useEffect(() => {
    if (launchedRef.current || !session || connInfo?.socketState !== "open") return;
    launchedRef.current = true;
    const command = pendingLaunch.take(sessionId);
    if (!command) return;
    const handle = getHandle();
    handle?.sendInput(`${command}\r`);
    requestAnimationFrame(() => handle?.focus());
  }, [connInfo?.socketState, getHandle, session, sessionId]);

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
      /*
       * The pane publishes its own hover so the matching sidebar row lights up,
       * but it must not draw the highlight ring for it — pointing at a terminal
       * is not a question about which terminal this is, and outlining whatever
       * the mouse crosses is pure noise. `selfHovered` suppresses the ring for
       * the hover this pane raised; a highlight from the sidebar still rings.
       */
      const enter = () => {
        setSelfHovered(true);
        highlightStore.set(sessionId);
      };
      const leave = () => {
        setSelfHovered(false);
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
  const stacked = slot?.stacked ?? false;

  return createPortal(
    <section
      ref={sectionRef}
      aria-label={title}
      className={cn(
        "relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        stacked && "rounded-md",
        // Focus is the pane's background, not an outline — see the wash below.
        highlighted === sessionId && !selfHovered && "ring-2 ring-ring",
      )}
    >
      {/*
       * Which pane has focus, read at a glance. xterm paints its own opaque
       * canvas background, so the section's `bg-background` never shows through
       * the terminal itself — the only way to tint a pane is over the top. The
       * focused pane is left exactly as it is (the deepest surface in the
       * stack); every other one is washed toward the foreground, which reads as
       * lighter in dark and greyer in light, i.e. receding in both. Sits under
       * the exited-state scrim (z-20) and the shortcut bar (z-30), and takes no
       * pointer events, so nothing about interacting with the pane changes.
       */}
      {!focused && paneCount > 1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 bg-foreground/[0.035]"
        />
      )}

      <header
        role="toolbar"
        aria-label={`${title} pane controls`}
        title={canDrag ? "Drag to move" : undefined}
        className={cn(
          "group/pane-header flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card/75 px-2 select-none",
          canDrag && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={(event) => {
          // Anywhere on the bar starts a move — except the controls sitting on it.
          if ((event.target as Element).closest?.("button, input, a")) return;
          onMoveStart(sessionId, event);
        }}
        onDoubleClick={() => !stacked && onToggleZoom(sessionId)}
      >
        <span className="relative shrink-0">
          {session ? (
            <AgentSwitcher session={session} getHandle={getHandle} />
          ) : (
            <AgentIcon size={22} className="rounded-md" />
          )}
          {session && (
            <SessionStatusDot
              session={session}
              className="pointer-events-none absolute -right-0.5 -top-0.5"
            />
          )}
        </span>
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
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium"
            title={session ? sessionTitleDetail(session) : undefined}
          >
            {title}
          </span>
        )}
        {session && (
          /* The pane's folder, as a control: pick a directory and the shell
             is sent a `cd` — the terminal changes where it points without
             leaving the keyboard-first flow. */
          <button
            type="button"
            aria-label="Change directory"
            title={session.cwd}
            onClick={() => setCwdPickerOpen(true)}
            onDoubleClick={(event) => event.stopPropagation()}
            className="flex h-7 max-w-40 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Folder className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{basename(session.cwd) || session.cwd}</span>
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          </button>
        )}
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
        </DropdownMenu>
      </header>

      {session ? (
        <div className="relative min-h-0 flex-1 @container/term">
          <div ref={attach} className="size-full" />
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

      <FolderPickerDialog
        key={`${paneHost?.id ?? "none"}:${cwdPickerOpen ? "open" : "closed"}`}
        open={cwdPickerOpen}
        host={paneHost}
        onOpenChange={setCwdPickerOpen}
        onSelect={(path) => {
          if (!session) return;
          const purpose = "Changing this pane's folder";
          void runInShell({
            session,
            handle: getHandle(),
            command: `cd ${shellQuote(path)}`,
            purpose,
            onSession: (fresh) => writeSessionToCache(queryClient, fresh),
          }).then((result) => {
            if (result === "busy") onError(stillRunningMessage(session, purpose));
          });
        }}
      />
    </section>,
    hostRef.current,
  );
}
