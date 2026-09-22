"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ellipsis,
  FolderOpen,
  Pencil,
  RotateCcw,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { SessionFilesAside, SessionFilesPanel } from "@/components/files/session-files-aside";
import { agentDisplayName, commandBasename } from "@/components/icons/AgentIcon";
import { ConnectionChip } from "@/components/terminal/ConnectionChip";
import { useLiveTerminal } from "@/components/terminal/LiveTerminalProvider";
import { ModifierBar } from "@/components/terminal/ModifierBar";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { SessionStatusDot } from "@/components/ui/status";
import {
  type AgentRestartPhase,
  restartPhaseLabel,
  restartSessionAgent,
} from "@/components/workspace/agent-restart";
import { AgentSwitcher, writeForegroundToCache } from "@/components/workspace/agent-switcher";
import { pendingLaunch } from "@/components/workspace/pending-launch";
import { runInShell } from "@/components/workspace/shell-handoff";
import {
  ApiError,
  agents as agentsApi,
  type Session,
  sessions,
  type Workspace,
  workspaces,
} from "@/lib/api";
import { cachedListItem } from "@/lib/cached-list-item";
import { remove as removeTile } from "@/lib/grid";
import { sessionAtShell, sessionTitle } from "@/lib/sessions";
import { type LayoutV3, tabOfSession, withTabTiles } from "@/lib/tabs";
import { cn } from "@/lib/utils";

/** The envelope with `sessionId`'s tile removed from whichever tab holds it. */
function layoutWithoutSession(layout: LayoutV3, sessionId: string): LayoutV3 {
  const tab = tabOfSession(layout, sessionId);
  if (!tab) return layout;
  return withTabTiles(layout, tab.id, removeTile(tab.layout.tiles, sessionId));
}

function updateSessionCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  session: Session,
): void {
  queryClient.setQueryData(["session", session.id], session);
  queryClient.setQueryData<Session[]>(["sessions"], (current) =>
    current?.map((item) => (item.id === session.id ? session : item)),
  );
}

export function SessionView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { attach, getHandle, connInfo, displayState, agentNotice } = useLiveTerminal(sessionId);
  const [restartPhase, setRestartPhase] = useState<AgentRestartPhase | null>(null);
  const sessionQ = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => sessions.get(sessionId),
    ...cachedListItem<Session>(queryClient, ["sessions"], sessionId),
    refetchInterval: 5_000,
    retry: false,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 15_000,
  });
  const memberWorkspace = useMemo(
    () =>
      (workspacesQ.data ?? []).find(
        (workspace) => tabOfSession(workspace.layout, sessionId) !== null,
      ) ?? null,
    [sessionId, workspacesQ.data],
  );
  const session = sessionQ.data;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (window.matchMedia("(pointer: fine)").matches) getHandle()?.focus();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [getHandle]);

  useEffect(() => {
    if (!(sessionQ.error instanceof ApiError) || sessionQ.error.status !== 404) return;
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    router.replace(memberWorkspace ? `/w/${memberWorkspace.id}` : "/");
  }, [memberWorkspace, queryClient, router, sessionQ.error]);

  const renameM = useMutation({
    mutationFn: (name: string | null) => sessions.update(sessionId, { name }),
    onSuccess: (saved) => {
      updateSessionCaches(queryClient, saved);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setEditingName(false);
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(String(error)),
  });
  // The same restart the pane offers: the window comes back as what it was
  // opened as, its agent resumed in the same conversation where it can be.
  const restartM = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("This session no longer exists.");
      const definitions = await queryClient
        .ensureQueryData({ queryKey: ["agents"], queryFn: agentsApi.list })
        .catch(() => []);
      return restartSessionAgent({
        session,
        agents: definitions,
        handle: getHandle(),
        handoff: runInShell,
        restart: async () => {
          const saved = await sessions.restart(sessionId);
          updateSessionCaches(queryClient, saved);
          return saved;
        },
        onSession: (latest) => updateSessionCaches(queryClient, latest),
        onPhase: setRestartPhase,
      });
    },
    onSettled: () => setRestartPhase(null),
    onSuccess: (result) => {
      if (result.kind === "resumed" && result.plan.kind === "agent") {
        const basename = commandBasename(result.plan.command);
        if (basename) writeForegroundToCache(queryClient, sessionId, basename);
      }
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setErrorMessage(null);
      requestAnimationFrame(() => getHandle()?.focus());
    },
    onError: (error) => setErrorMessage(String(error)),
  });

  // A command a restart queued for the fresh shell is typed the moment that
  // shell's transport opens — the same drain the workspace pane runs, so a
  // restart from this page lands the agent back too.
  const socketOpen = connInfo?.socketState === "open";
  useEffect(() => {
    if (!session || !socketOpen || !pendingLaunch.has(sessionId)) return;
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      if (cancelled) return;
      const handle = getHandle();
      if (!handle) {
        if (tries++ < 50) window.setTimeout(attempt, 100);
        return;
      }
      const command = pendingLaunch.take(sessionId);
      if (!command) return;
      handle.sendInput(`${command}\r`);
      requestAnimationFrame(() => handle.focus());
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [socketOpen, getHandle, session, sessionId]);
  const removeFromWorkspaceM = useMutation({
    mutationFn: (workspace: Workspace) =>
      workspaces.update(workspace.id, {
        layout: layoutWithoutSession(workspace.layout, sessionId),
      }),
    onMutate: (workspace) => {
      const optimistic = {
        ...workspace,
        layout: layoutWithoutSession(workspace.layout, sessionId),
      };
      queryClient.setQueryData(["workspace", workspace.id], optimistic);
      queryClient.setQueryData<Workspace[]>(["workspaces"], (current) =>
        current?.map((item) => (item.id === workspace.id ? optimistic : item)),
      );
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["workspace", saved.id], saved);
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setErrorMessage(null);
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setErrorMessage(String(error));
    },
  });
  const closeM = useMutation({
    mutationFn: async () => {
      await sessions.remove(sessionId);
      if (memberWorkspace) {
        try {
          await workspaces.update(memberWorkspace.id, {
            layout: layoutWithoutSession(memberWorkspace.layout, sessionId),
          });
        } catch (error) {
          // The session is already gone; a subsequent workspace read prunes
          // the now-unowned tile. Do not strand the user on a dead session.
          console.warn("Could not eagerly remove the closed session tile", error);
        }
      }
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["session", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      router.replace(memberWorkspace ? `/w/${memberWorkspace.id}` : "/");
    },
    onError: (error) => setErrorMessage(String(error)),
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

  if (!session) {
    return (
      <div className="grid h-[calc(var(--vv-height)-2*var(--content-inset))] place-items-center bg-background">
        {sessionQ.isLoading ? (
          <Spinner label="Loading session" />
        ) : (
          <p className="text-sm text-destructive">
            {String(sessionQ.error ?? "Session not found")}
          </p>
        )}
      </div>
    );
  }

  const title = sessionTitle(session);
  const backHref = memberWorkspace ? `/w/${memberWorkspace.id}?focus=${sessionId}` : "/";

  return (
    <div className="relative flex h-[calc(var(--vv-height)-2*var(--content-inset))] min-h-0 flex-col overflow-hidden bg-background pad-safe-top">
      {/* `pad-safe-x` alone would override px-* and leave the back button on
          the window edge; fold the inset into the padding instead. */}
      <header
        className={cn(
          "group/pane-header flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95",
          "pl-[max(0.25rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))]",
        )}
      >
        <Button asChild variant="ghost" size="icon" className="size-9 shrink-0">
          <Link
            href={backHref}
            aria-label={memberWorkspace ? `Back to ${memberWorkspace.name}` : "Back"}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
        </Button>
        <AgentSwitcher session={session} getHandle={getHandle} size={26} />
        {editingName ? (
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
            className="h-8 min-w-0 max-w-72 flex-1"
          />
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{title}</h1>
              <SessionStatusDot session={session} />
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {session.host_name ?? "Host"} · {session.cwd}
            </p>
          </div>
        )}
        {/* Owner-side viewer count and the transport/trust chip: the surface
            header carried both before this view replaced it, and the chip is
            the one place the endpoint-to-endpoint story is told (viewer mode's
            dimmed overlay handles the non-owner side inside the terminal). */}
        {displayState?.owner && displayState.viewers > 1 && (
          <span className="hidden whitespace-nowrap px-2 text-xs text-muted-foreground sm:inline">
            {displayState.viewers - 1} viewer{displayState.viewers - 1 === 1 ? "" : "s"}
          </span>
        )}
        <ConnectionChip info={connInfo} compact className="sm:hidden" />
        <ConnectionChip info={connInfo} className="hidden sm:block" />
        <Button
          type="button"
          variant={filesOpen ? "secondary" : "ghost"}
          size="icon"
          className="size-9"
          aria-label="Toggle files"
          aria-pressed={filesOpen}
          onClick={() => setFilesOpen((value) => !value)}
        >
          <FolderOpen className="size-4" aria-hidden />
        </Button>
        <DropdownMenu
          align="end"
          renderTrigger={(props) => (
            <Button
              {...props}
              type="button"
              variant="ghost"
              size="icon"
              className="size-9"
              aria-label="Session options"
            >
              <Ellipsis className="size-4" aria-hidden />
            </Button>
          )}
        >
          <DropdownMenuItem
            onSelect={() => {
              setDraftName(session.name ?? title);
              setEditingName(true);
            }}
          >
            <Pencil className="size-4" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled={restartM.isPending} onSelect={() => restartM.mutate()}>
            <RotateCcw className="size-4" aria-hidden />
            Restart
          </DropdownMenuItem>
          {memberWorkspace && (
            <DropdownMenuItem
              disabled={removeFromWorkspaceM.isPending}
              onSelect={() => removeFromWorkspaceM.mutate(memberWorkspace)}
            >
              <Unlink className="size-4" aria-hidden />
              Remove from workspace
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={closeM.isPending} onSelect={closeSession}>
            <Trash2 className="size-4" aria-hidden />
            Close session
          </DropdownMenuItem>
        </DropdownMenu>
      </header>

      {errorMessage && (
        <p
          className="shrink-0 border-b border-destructive/25 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {errorMessage}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 @container/term">
          <div ref={attach} className="size-full" />
          {agentNotice === "update_installed" &&
            session.status === "running" &&
            !sessionAtShell(session) && (
              <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-2">
                <div
                  role="status"
                  className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs shadow-lg"
                >
                  <span className="truncate text-muted-foreground">
                    {agentDisplayName(session.foreground_command)} installed an update.
                  </span>
                  <Button size="sm" disabled={restartM.isPending} onClick={() => restartM.mutate()}>
                    <RotateCcw className="size-3.5" aria-hidden />
                    {restartM.isPending
                      ? restartPhaseLabel(
                          restartPhase,
                          agentDisplayName(session.foreground_command),
                        )
                      : `Restart ${agentDisplayName(session.foreground_command)}`}
                  </Button>
                </div>
              </div>
            )}
          {(session.status === "exited" || session.status === "killed") && (
            <div className="absolute inset-0 z-20 grid place-items-center bg-background/75 backdrop-blur-[2px]">
              <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-popover p-4 shadow-lg">
                <p className="text-sm font-medium">Shell exited</p>
                <div className="flex gap-2">
                  <Button size="sm" disabled={restartM.isPending} onClick={() => restartM.mutate()}>
                    <RotateCcw className="size-3.5" aria-hidden />
                    {restartM.isPending ? restartPhaseLabel(restartPhase, "the agent") : "Restart"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={closeSession}>
                    Close
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
        {filesOpen && <SessionFilesAside session={session} />}
      </div>

      <ModifierBar
        className="hidden [@media(pointer:coarse)]:flex"
        onSend={(bytes) => {
          getHandle()?.sendInput(bytes);
          requestAnimationFrame(() => getHandle()?.focus());
        }}
        onPaste={(data) => getHandle()?.pasteDataTransfer(data)}
        onPasteText={(text) => getHandle()?.pasteText(text)}
        onPasteClick={() => void getHandle()?.pasteFromClipboard()}
        onSubmit={() => {
          getHandle()?.submit();
          requestAnimationFrame(() => getHandle()?.focus());
        }}
      />

      {filesOpen && (
        <div className="absolute inset-0 z-40 flex flex-col bg-background pad-safe-top md:hidden">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-sm font-semibold">Files</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              onClick={() => setFilesOpen(false)}
              aria-label="Close files"
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
          <SessionFilesPanel session={session} className="min-h-0 flex-1" />
        </div>
      )}
    </div>
  );
}
