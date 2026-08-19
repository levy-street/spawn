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
import { useEffect, useMemo, useRef, useState } from "react";
import { SessionFilesAside, SessionFilesPanel } from "@/components/files/session-files-aside";
import { AgentIcon } from "@/components/icons/AgentIcon";
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
import { ShortcutBar } from "@/components/workspace/shortcut-bar";
import { ApiError, type Session, sessions, type Workspace, workspaces } from "@/lib/api";
import { remove as removeTile } from "@/lib/grid";
import { sessionTitle } from "@/lib/sessions";

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
  const terminalSurfaceRef = useRef<HTMLDivElement>(null);
  const { attach, getHandle, promptState, subscribeCursorMove } = useLiveTerminal(sessionId);
  const sessionQ = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => sessions.get(sessionId),
    refetchInterval: 5_000,
    retry: false,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaces.list,
    staleTime: 15_000,
  });
  const memberWorkspace = useMemo(
    () =>
      (workspacesQ.data ?? []).find((workspace) =>
        workspace.layout.tiles.some((tile) => tile.session_id === sessionId),
      ) ?? null,
    [sessionId, workspacesQ.data],
  );
  const session = sessionQ.data;
  const foregroundCommand = session?.foreground_command;

  useEffect(() => {
    if (foregroundCommand === undefined) return;
    const frame = requestAnimationFrame(() => getHandle()?.resetPromptState());
    return () => cancelAnimationFrame(frame);
  }, [foregroundCommand, getHandle]);

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
  const restartM = useMutation({
    mutationFn: () => sessions.restart(sessionId),
    onSuccess: (saved) => {
      updateSessionCaches(queryClient, saved);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setErrorMessage(null);
      requestAnimationFrame(() => getHandle()?.focus());
    },
    onError: (error) => setErrorMessage(String(error)),
  });
  const removeFromWorkspaceM = useMutation({
    mutationFn: (workspace: Workspace) =>
      workspaces.update(workspace.id, {
        layout: { version: 2, tiles: removeTile(workspace.layout.tiles, sessionId) },
      }),
    onMutate: (workspace) => {
      const optimistic = {
        ...workspace,
        layout: { version: 2 as const, tiles: removeTile(workspace.layout.tiles, sessionId) },
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
            layout: { version: 2, tiles: removeTile(memberWorkspace.layout.tiles, sessionId) },
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
      <div className="grid h-vv place-items-center bg-background">
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
    <div className="relative flex h-vv min-h-0 flex-col overflow-hidden bg-background pad-safe-top">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-2 pad-safe-x sm:px-3">
        <Button asChild variant="ghost" size="icon" className="size-9 shrink-0">
          <Link
            href={backHref}
            aria-label={memberWorkspace ? `Back to ${memberWorkspace.name}` : "Back"}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
        </Button>
        <AgentIcon command={session.foreground_command} size={26} className="rounded-md" />
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
        <div ref={terminalSurfaceRef} className="relative min-h-0 min-w-0 flex-1 @container/term">
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
              <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-popover p-4 shadow-lg">
                <p className="text-sm font-medium">Shell exited</p>
                <div className="flex gap-2">
                  <Button size="sm" disabled={restartM.isPending} onClick={() => restartM.mutate()}>
                    <RotateCcw className="size-3.5" aria-hidden />
                    Restart
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
