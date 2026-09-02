"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  ExternalLink,
  Folder,
  Pencil,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type ReactNode,
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
import { hostStatusTone, SessionStatusDot, StatusDot } from "@/components/ui/status";
import { type Host, hosts, type Session, sessions } from "@/lib/api";
import { highlightStore, useHighlightedSession } from "@/lib/highlight-store";
import { toggleSessionMuted, useSessionMuted } from "@/lib/notify-prefs";
import { basename } from "@/lib/paths";
import { sessionTitle, sessionTitleDetail } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { shellQuote } from "./agent-command";
import { AgentSwitcher } from "./agent-switcher";
import { FolderPicker } from "./folder-picker";
import { pendingLaunch } from "./pending-launch";

/** Trailing shortcut hint in a menu row — the gesture that does the same thing. */
function MenuHint({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto shrink-0 pl-3 text-xs tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

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
  canDuplicate = false,
  canMoveUp,
  canMoveDown,
  onFocus,
  onMoveStart,
  onExpand,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onRemoveFromWorkspace,
  onConvertToFiles,
  onMoveToHost,
  registerHandle,
  onError,
}: {
  sessionId: string;
  session?: Session;
  slot?: PaneSlotTarget;
  focused: boolean;
  paneCount: number;
  canDrag: boolean;
  /** False when the tab is full, or the session has not loaded yet. */
  canDuplicate?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onFocus: (sessionId: string) => void;
  onMoveStart: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  /** Fill the empty grid space around this pane (desktop grid only). */
  onExpand?: (sessionId: string) => void;
  /** Open a second pane on the same host, folder, skills and agent (workspace
   *  grid only — the grid owns placement). */
  onDuplicate?: (sessionId: string) => void;
  onMoveUp: (sessionId: string) => void;
  onMoveDown: (sessionId: string) => void;
  onRemoveFromWorkspace: (sessionId: string) => void;
  /** Replace this pane with a file explorer widget (workspace grid only). */
  onConvertToFiles?: (sessionId: string) => void;
  /** Swap this pane's shell for a fresh one on another host (workspace grid
   *  only — the grid owns the tile swap). */
  onMoveToHost?: (sessionId: string, host: Host) => void;
  registerHandle: (sessionId: string, getHandle: () => TerminalHandle | null) => void;
  onError: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const highlighted = useHighlightedSession();
  const [editingName, setEditingName] = useState(false);
  const [selfHovered, setSelfHovered] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const cwdChipRef = useRef<HTMLButtonElement>(null);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 30_000 });
  const hostList = hostsQ.data ?? [];
  const paneHost = hostList.find((host) => host.id === session?.host_id) ?? null;
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

  // Before the portal-host early return below: hooks must run in the same
  // order on every render, and this component can bail out before painting.
  const muted = useSessionMuted(sessionId);

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
        "relative isolate flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        stacked && "rounded-md",
        // Focus is the pane's background, not an outline — see the wash below.
        highlighted === sessionId && !selfHovered && "ring-2 ring-ring",
      )}
    >
      {/*
       * Which pane has focus, read at a glance. xterm paints its own opaque
       * canvas background, so the section's `bg-background` never shows through
       * the terminal — the only way to tint a pane is over the top, and a plain
       * scrim there greys the terminal's text along with its ground. So the
       * unfocused pane's layer blends instead of covering: `--shell` (the
       * chrome ground) taken as a floor in dark and a ceiling in light, which
       * moves every pixel between it and the pane's ground — the terminal's
       * background, the header, the gutters — while leaving anything with more
       * contrast than the chrome, the output itself, exactly as it was. The
       * pane rises to chrome; its content stays legible. Half strength, so the
       * ground lands midway between the pane's own and the chrome's rather than
       * flush against chrome — enough to read the focus at a glance without
       * washing the unfocused panes out. `isolate` on the section keeps the
       * blend inside the pane. Sits under the exited-state scrim (z-20) and the
       * shortcut bar (z-30), and takes no pointer events, so nothing about
       * interacting with the pane changes.
       */}
      {!focused && paneCount > 1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 bg-shell/50 mix-blend-darken dark:mix-blend-lighten"
        />
      )}

      <header
        role="toolbar"
        aria-label={`${title} window controls`}
        title={canDrag ? "Drag to move · Double-click to fill empty space" : undefined}
        className={cn(
          // Tighter on the right than the left: the bar ends in icon buttons, whose
          // own padding already holds the glyph clear of the edge.
          "group/pane-header @container/pane-header flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card/75 pl-2 pr-1.5 select-none",
          canDrag && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={(event) => {
          // Anywhere on the bar starts a move — except the controls sitting on it.
          if ((event.target as Element).closest?.("button, input, a")) return;
          onMoveStart(sessionId, event);
        }}
        onDoubleClick={(event) => {
          if ((event.target as Element).closest?.("button, input, a")) return;
          onExpand?.(sessionId);
        }}
      >
        <span className="relative shrink-0">
          {session ? (
            <AgentSwitcher
              session={session}
              getHandle={getHandle}
              onConvertToFiles={onConvertToFiles ? () => onConvertToFiles(sessionId) : undefined}
            />
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
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-medium",
              // Dimmed rather than badged: a muted pane should read as turned
              // down, and the whole label carrying the state says that with
              // less furniture than a chip would.
              muted && "text-muted-foreground",
            )}
            title={
              session
                ? `${sessionTitleDetail(session)}${muted ? " · alerts muted" : ""}`
                : undefined
            }
          >
            {muted && (
              <BellOff role="img" aria-label="Alerts muted" className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{title}</span>
          </span>
        )}
        {session && paneHost && hostList.length > 1 && onMoveToHost && (
          /* The pane's host, as a control: with more than one host connected
             this is a dropdown — picking another machine swaps this pane's
             shell for a fresh one over there (the grid confirms first). */
          <DropdownMenu
            align="end"
            renderTrigger={(props) => (
              <button
                {...props}
                type="button"
                aria-label="Change host"
                title={`Running on ${paneHost.name}`}
                className="flex h-7 max-w-36 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <StatusDot tone={hostStatusTone(paneHost.status)} label={paneHost.status} />
                <span className="truncate">{paneHost.name}</span>
                <ChevronDown className="size-3 shrink-0" aria-hidden />
              </button>
            )}
          >
            {hostList.map((host) => (
              <DropdownMenuItem
                key={host.id}
                disabled={host.status !== "online" && host.id !== session.host_id}
                onSelect={() => {
                  if (host.id !== session.host_id) onMoveToHost(sessionId, host);
                }}
              >
                <StatusDot tone={hostStatusTone(host.status)} label={host.status} />
                <span className="min-w-0 flex-1 truncate">{host.name}</span>
                {host.id === session.host_id && <Check className="size-3.5 shrink-0" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenu>
        )}
        {session && (
          /* The pane's folder, as a control: pick a directory and the shell
             is sent a `cd` — the terminal changes where it points without
             leaving the keyboard-first flow. Squeezed narrow it keeps only its
             icon: in a pane that thin the session's own name is worth more of
             the bar than the folder's, and the title still carries the path. */
          <button
            ref={cwdChipRef}
            type="button"
            aria-label="Change directory"
            title={session.cwd}
            onClick={() => setCwdPickerOpen((value) => !value)}
            className="flex h-7 max-w-40 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Folder className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate @max-[260px]/pane-header:hidden">
              {basename(session.cwd) || session.cwd}
            </span>
            <ChevronDown className="size-3 shrink-0 @max-[260px]/pane-header:hidden" aria-hidden />
          </button>
        )}
        <DropdownMenu
          align="end"
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`${title} options`}
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
          {session && onDuplicate && (
            <DropdownMenuItem disabled={!canDuplicate} onSelect={() => onDuplicate(sessionId)}>
              <Copy className="size-4" aria-hidden />
              Duplicate
              <MenuHint>⌘/⌥ drag</MenuHint>
            </DropdownMenuItem>
          )}
          {session && (
            <DropdownMenuItem onSelect={() => toggleSessionMuted(sessionId)}>
              {muted ? (
                <Bell className="size-4" aria-hidden />
              ) : (
                <BellOff className="size-4" aria-hidden />
              )}
              {muted ? "Unmute alerts" : "Mute alerts"}
            </DropdownMenuItem>
          )}
          {!session && (
            /* With the session gone every session action above is gone with
               it, and a menu with nothing in it is a bug drawn on screen. The
               one thing a dead pane can still do is leave. */
            <DropdownMenuItem onSelect={() => onRemoveFromWorkspace(sessionId)}>
              <X className="size-4" aria-hidden />
              Remove from workspace
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
        </DropdownMenu>
        {/* Closing has its own control, at the far right where a window's
            close has always been. The confirmation dialog protects against
            accidental clicks, so the X can express its intent directly. A
            pane whose session is gone has no process to kill, so its X skips
            the ceremony and just takes the dead pane out of the layout. */}
        <button
          type="button"
          aria-label={session ? `Close ${title}` : "Remove from workspace"}
          disabled={closeM.isPending}
          onClick={session ? closeSession : () => onRemoveFromWorkspace(sessionId)}
          // Pulled back off the bar's rhythm: the two controls are one
          // cluster at the end of the header, not two more items in the row.
          className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50"
        >
          <X className="size-3.5" aria-hidden />
        </button>
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
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          {/* Offer the way out rather than describing it: removing the pane is
              a layout edit, nothing here is running, so no confirmation. */}
          <div className="flex max-w-xs flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">This session no longer exists.</p>
            <button
              type="button"
              onClick={() => onRemoveFromWorkspace(sessionId)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
            >
              Remove from workspace
            </button>
          </div>
        </div>
      )}

      <FolderPicker
        key={`${paneHost?.id ?? "none"}:${cwdPickerOpen ? "open" : "closed"}`}
        open={cwdPickerOpen}
        host={paneHost}
        initialPath={session?.cwd}
        anchorRef={cwdChipRef}
        onOpenChange={setCwdPickerOpen}
        onSelect={(path) => {
          if (!session) return;
          const purpose = "Changing this window's folder";
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
