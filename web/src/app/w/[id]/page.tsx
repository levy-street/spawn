"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { LauncherFab } from "@/components/workspace/launcher-fab";
import { WorkspaceGrid } from "@/components/workspace/workspace-grid";
import { WorkspaceTabs } from "@/components/workspace/workspace-tabs";
import { ApiError, sessions, workspaces } from "@/lib/api";
import { readingOrder, type Tile } from "@/lib/grid";
import { activeTab, tabById, tabOfSession, tabTiles } from "@/lib/tabs";

const TAB_STORAGE_PREFIX = "spawn.workspace.tab.";

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
  const [focusedId, setFocusedId] = useState<string | null>(searchParams.get("focus"));
  // Errors surface as toasts; null clears nothing (toasts expire on their
  // own). Stable identity: children key gesture listeners on this callback.
  const reportError = useCallback((message: string | null) => {
    if (message) toast.error(message);
  }, []);
  const [chosenTabId, setChosenTabId] = useState<string | null>(() => searchParams.get("tab"));
  // The grid's live drag preview; the strip restyles the selected tab from it
  // mid-gesture instead of waiting for the drop to commit.
  const [previewTiles, setPreviewTiles] = useState<Tile[] | null>(null);

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

  /*
   * Which tab is open. Explicit choices (clicks, ?tab=, a ?focus= session's
   * home tab) win; then the last tab used on this device; then the envelope's
   * own active_tab. Choices persist per workspace in localStorage — the
   * server's active_tab is only written as a side effect of layout writes, so
   * two devices never fight over it.
   */
  const activeTabId = useMemo(() => {
    if (!workspace) return null;
    if (chosenTabId && tabById(workspace.layout, chosenTabId)) return chosenTabId;
    const focusParam = searchParams.get("focus");
    const focusTab = focusParam ? tabOfSession(workspace.layout, focusParam) : null;
    if (focusTab) return focusTab.id;
    const stored = window.localStorage.getItem(`${TAB_STORAGE_PREFIX}${workspaceId}`);
    if (stored && tabById(workspace.layout, stored)) return stored;
    return activeTab(workspace.layout).id;
  }, [chosenTabId, searchParams, workspace, workspaceId]);

  const switchTab = (tabId: string) => {
    setChosenTabId(tabId);
    window.localStorage.setItem(`${TAB_STORAGE_PREFIX}${workspaceId}`, tabId);
  };

  // The sidebar links sessions as /w/<id>?tab=<tabId>; honor param changes.
  useEffect(() => {
    const param = searchParams.get("tab");
    if (param) setChosenTabId(param);
  }, [searchParams]);

  const workspaceSessions = useMemo(() => {
    if (!workspace) return [];
    const ids = new Set(
      workspace.layout.tabs.flatMap((tab) => tab.layout.tiles.map((tile) => tile.session_id)),
    );
    return (sessionsQ.data ?? []).filter((session) => ids.has(session.id));
  }, [sessionsQ.data, workspace]);

  useEffect(() => {
    if (!workspace || !activeTabId) return;
    const ids = readingOrder(tabTiles(workspace.layout, activeTabId));
    if (ids.length === 0) {
      setFocusedId(null);
    } else if (!focusedId || !ids.includes(focusedId)) {
      setFocusedId(ids[0] ?? null);
    }
  }, [activeTabId, focusedId, workspace]);

  if (!workspace) {
    return (
      <div className="grid h-[calc(var(--vv-height)-3rem)] place-items-center @md/shell:h-[calc(var(--vv-height)-2*var(--content-inset))]">
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
    <div className="flex h-[calc(var(--vv-height)-3rem)] min-h-0 flex-col bg-background @md/shell:h-[calc(var(--vv-height)-2*var(--content-inset))]">
      <WorkspaceTabs
        workspace={workspace}
        activeTabId={activeTabId ?? activeTab(workspace.layout).id}
        previewTiles={previewTiles}
        focusedId={focusedId}
        onSwitch={switchTab}
        onError={reportError}
      />

      <div className="flex min-h-0 flex-1">
        <WorkspaceGrid
          workspace={workspace}
          tabId={activeTabId ?? activeTab(workspace.layout).id}
          sessions={workspaceSessions}
          initialFocusId={searchParams.get("focus")}
          onFocusChange={setFocusedId}
          onSwitchTab={switchTab}
          onPreviewTiles={setPreviewTiles}
          onError={reportError}
        />
      </div>

      <LauncherFab
        workspace={workspace}
        tabId={activeTabId ?? activeTab(workspace.layout).id}
        onCreated={({ sessionId }) => {
          if (sessionId) router.push(`/w/${workspace.id}?focus=${sessionId}`);
        }}
      />
    </div>
  );
}
