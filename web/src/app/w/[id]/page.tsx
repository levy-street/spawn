"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, FolderOpen, Pencil, Trash2 } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { SessionFilesAside } from "@/components/files/session-files-aside";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { WorkspaceGrid } from "@/components/workspace/workspace-grid";
import { ApiError, sessions, type Workspace, workspaces } from "@/lib/api";
import { readingOrder } from "@/lib/grid";

export default function WorkspacePage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params?.id;
  return (
    <AuthGate>
      <AppShell mainClassName="overflow-hidden !pb-0">
        <Suspense fallback={null}>
          {workspaceId ? <WorkspaceView key={workspaceId} workspaceId={workspaceId} /> : null}
        </Suspense>
      </AppShell>
    </AuthGate>
  );
}

function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(searchParams.get("focus"));
  const [savingLayout, setSavingLayout] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const workspaceQ = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => workspaces.get(workspaceId),
    retry: false,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaces.list,
    staleTime: 10_000,
  });
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    refetchInterval: 5_000,
  });

  useEffect(() => {
    window.localStorage.setItem("spawn.workspaces.last", workspaceId);
  }, [workspaceId]);

  useEffect(() => {
    if (!(workspaceQ.error instanceof ApiError) || workspaceQ.error.status !== 404) return;
    if (workspacesQ.isLoading) return;
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    const remaining = [...(workspacesQ.data ?? [])]
      .filter((workspace) => workspace.id !== workspaceId)
      .sort((a, b) => a.position - b.position);
    router.replace(remaining[0] ? `/w/${remaining[0].id}` : "/");
  }, [queryClient, router, workspaceId, workspaceQ.error, workspacesQ.data, workspacesQ.isLoading]);

  const workspace = workspaceQ.data;
  const workspaceSessions = useMemo(() => {
    if (!workspace) return [];
    const ids = new Set(workspace.layout.tiles.map((tile) => tile.session_id));
    return (sessionsQ.data ?? []).filter((session) => ids.has(session.id));
  }, [sessionsQ.data, workspace]);
  const focusedSession =
    workspaceSessions.find((session) => session.id === focusedId) ??
    workspaceSessions.find(
      (session) => session.id === readingOrder(workspace?.layout.tiles ?? [])[0],
    ) ??
    null;

  useEffect(() => {
    if (!workspace) return;
    const ids = readingOrder(workspace.layout.tiles);
    if (ids.length === 0) {
      setFocusedId(null);
      setFilesOpen(false);
    } else if (!focusedId || !ids.includes(focusedId)) {
      setFocusedId(ids[0] ?? null);
    }
  }, [focusedId, workspace]);

  const renameM = useMutation({
    mutationFn: (name: string) => workspaces.update(workspaceId, { name }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["workspace", workspaceId], saved);
      queryClient.setQueryData<Workspace[]>(["workspaces"], (current) =>
        current?.map((item) => (item.id === saved.id ? saved : item)),
      );
      setEditingName(false);
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(String(error)),
  });
  const deleteM = useMutation({
    mutationFn: () => workspaces.remove(workspaceId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["workspace", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      const remaining = [...(workspacesQ.data ?? [])]
        .filter((item) => item.id !== workspaceId)
        .sort((a, b) => a.position - b.position);
      router.replace(remaining[0] ? `/w/${remaining[0].id}` : "/");
    },
    onError: (error) => setErrorMessage(String(error)),
  });

  const submitRename = () => {
    if (!workspace) return;
    const next = draftName.trim();
    if (!next || next === workspace.name) {
      setEditingName(false);
      return;
    }
    renameM.mutate(next);
  };

  const deleteWorkspace = async () => {
    if (!workspace) return;
    const accepted = await confirm({
      title: `Delete ${workspace.name}?`,
      body: "Every session in this workspace will be closed and permanently removed.",
      confirmLabel: "Delete workspace",
      destructive: true,
    });
    if (accepted) deleteM.mutate();
  };

  if (!workspace) {
    return (
      <div className="grid h-[calc(var(--vv-height)-3rem)] place-items-center @md/shell:h-vv">
        {workspaceQ.isLoading ? (
          <Spinner label="Loading workspace" />
        ) : workspaceQ.error &&
          !(workspaceQ.error instanceof ApiError && workspaceQ.error.status === 404) ? (
          <p className="text-sm text-destructive">{String(workspaceQ.error)}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(var(--vv-height)-3rem)] min-h-0 flex-col bg-background @md/shell:h-vv">
      <header className="hidden h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 @md/shell:flex">
        {editingName ? (
          <Input
            autoFocus
            aria-label="Workspace name"
            value={draftName}
            disabled={renameM.isPending}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitRename();
              if (event.key === "Escape") setEditingName(false);
            }}
            className="h-8 max-w-72 text-sm"
          />
        ) : (
          <button
            type="button"
            title="Double-click to rename"
            onDoubleClick={() => {
              setDraftName(workspace.name);
              setEditingName(true);
            }}
            className="min-w-0 truncate rounded px-1 text-left text-sm font-semibold hover:bg-accent"
          >
            {workspace.name}
          </button>
        )}
        <span
          className={`text-[11px] text-muted-foreground transition-opacity ${savingLayout ? "opacity-100" : "opacity-0"}`}
          aria-hidden={!savingLayout}
        >
          Saving…
        </span>
        <div className="flex-1" />
        <Button
          type="button"
          variant={filesOpen ? "secondary" : "ghost"}
          size="icon"
          className="size-8"
          aria-label="Toggle files panel"
          aria-pressed={filesOpen}
          disabled={!focusedSession}
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
              className="size-8"
              aria-label="Workspace options"
            >
              <Ellipsis className="size-4" aria-hidden />
            </Button>
          )}
        >
          <DropdownMenuItem
            onSelect={() => {
              setDraftName(workspace.name);
              setEditingName(true);
            }}
          >
            <Pencil className="size-4" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={deleteM.isPending} onSelect={deleteWorkspace}>
            <Trash2 className="size-4" aria-hidden />
            Delete workspace
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
        <WorkspaceGrid
          workspace={workspace}
          sessions={workspaceSessions}
          initialFocusId={searchParams.get("focus")}
          onFocusChange={setFocusedId}
          onSavingChange={setSavingLayout}
          onError={setErrorMessage}
        />
        {filesOpen && focusedSession && <SessionFilesAside session={focusedSession} />}
      </div>
    </div>
  );
}
