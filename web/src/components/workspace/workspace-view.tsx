"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startCarryDrag } from "@/components/nav/workspace-carry";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useWorkspaceIconAutoFill } from "@/hooks/useWorkspaceIconAutoFill";
import { ApiError, sessions, workspaces } from "@/lib/api";
import { readingOrder, type Tile } from "@/lib/grid";
import type { SplitSide } from "@/lib/split-store";
import { activeTab, tabById, tabOfSession, tabTiles } from "@/lib/tabs";
import { ArchivedBanner } from "./archived-banner";
import { LauncherFab } from "./launcher-fab";
import { PaneScopeProvider } from "./pane-scope";
import { WorkspaceGrid } from "./workspace-grid";
import { WorkspaceTabs } from "./workspace-tabs";

const TAB_STORAGE_PREFIX = "spawn.workspace.tab.";

/**
 * One workspace: its tab strip, its canvas and its launcher.
 *
 * Two of these can be up at once, so nothing here may reach for "the" route,
 * "the" canvas or "the" last-opened workspace. Anything that is a fact about
 * the window rather than about this workspace arrives as a prop and is acted
 * on by the primary alone.
 *
 * Memoised because the seam drag lives a level up: a pointer move that only
 * changes the split's ratio has nothing to say to either grid, and re-running
 * both of them at pointer rate is what would make the drag stutter.
 */
export const WorkspaceView = memo(function WorkspaceView({
  workspaceId,
  side,
  split,
  routedId,
  active,
  focusParam,
  tabParam,
  onActivate,
  onUnsplit,
  onRemoveFromSplit,
}: {
  workspaceId: string;
  side: SplitSide;
  /** True only when the window actually holds two workspaces. */
  split: boolean;
  /**
   * The workspace the address bar is about. Either half of a split can be it
   * — the URL names a workspace and the pair decides the order, so the routed
   * half is not always the left one — and a carry started from this half's
   * own name needs to know which, to tell whether a drop displaces the route.
   */
  routedId: string;
  /** Whether this half owns the document-level gestures. */
  active: boolean;
  /**
   * `?focus=` and `?tab=`, which the container hands to the routed half only.
   * The address bar names one workspace, and honouring its session in both
   * halves would drag the other one's view somewhere its URL never asked for.
   */
  focusParam: string | null;
  tabParam: string | null;
  /** A pointer or focus landed anywhere in this half. */
  onActivate: () => void;
  /** "Keep this half", from this half's own strip. Null when not split. */
  onUnsplit: (() => void) | null;
  /** "This half steps out", from its own menu. Null when not split. */
  onRemoveFromSplit: (() => void) | null;
}) {
  const routed = routedId === workspaceId;
  const router = useRouter();
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(focusParam);
  // Errors surface as toasts; null clears nothing (toasts expire on their
  // own). Stable identity: children key gesture listeners on this callback.
  const reportError = useCallback((message: string | null) => {
    if (message) toast.error(message);
  }, []);
  const [chosenTabId, setChosenTabId] = useState<string | null>(tabParam);
  // The layout a live drag is promising, from the grid's own gestures or from
  // a pane dragged off the launcher. The strip restyles the selected tab from
  // it, and the launcher's version is what the grid renders its panes at.
  const [previewTiles, setPreviewTiles] = useState<Tile[] | null>(null);
  // A pane is being carried on the canvas, which turns the launcher into the
  // bin for that drag.
  const [draggingPane, setDraggingPane] = useState(false);

  const workspaceQ = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => workspaces.get(workspaceId),
    retry: false,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 10_000,
  });
  // Only the carry needs this, and only to name the workspaces its drop
  // preview draws — the one being carried is already in hand.
  const workspaceById = useMemo(
    () => new Map((workspacesQ.data ?? []).map((item) => [item.id, item])),
    [workspacesQ.data],
  );
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    refetchInterval: 5_000,
  });

  useEffect(() => {
    // Only the routed half records where the user was. A cold start opens one
    // workspace, so if both halves wrote this the next one would be whichever
    // of the two happened to mount last rather than the one being worked in.
    if (!routed) return;
    window.localStorage.setItem("spawn.workspaces.last", workspaceId);
  }, [routed, workspaceId]);

  // Archived from somewhere else (this device's sidebar, another tab): the
  // lists it belongs to have changed even though this page can still show it,
  // as the snapshot it has become.
  useEffect(() => {
    if (!workspaceQ.data?.archived_at) return;
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  }, [queryClient, workspaceQ.data?.archived_at]);

  useEffect(() => {
    if (!(workspaceQ.error instanceof ApiError) || workspaceQ.error.status !== 404) return;
    if (workspacesQ.isLoading) return;
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    // A vanished second workspace leaves the arrangement instead: the refresh
    // above is what reaches `splitStore.reconcile`. Letting it navigate as
    // well would send the half the user is still working in somewhere else.
    if (!routed) return;
    const remaining = [...(workspacesQ.data ?? [])]
      .filter((workspace) => workspace.id !== workspaceId)
      .sort((a, b) => a.position - b.position);
    router.replace(remaining[0] ? `/w/${remaining[0].id}` : "/app");
  }, [
    queryClient,
    routed,
    router,
    workspaceId,
    workspaceQ.error,
    workspacesQ.data,
    workspacesQ.isLoading,
  ]);

  const workspace = workspaceQ.data;
  // A workspace nobody has looked at yet gets its folder scanned for a mark
  // the first time it is opened with its host online.
  useWorkspaceIconAutoFill(workspace);

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
    const focusTab = focusParam ? tabOfSession(workspace.layout, focusParam) : null;
    if (focusTab) return focusTab.id;
    const stored = window.localStorage.getItem(`${TAB_STORAGE_PREFIX}${workspaceId}`);
    if (stored && tabById(workspace.layout, stored)) return stored;
    return activeTab(workspace.layout).id;
  }, [chosenTabId, focusParam, workspace, workspaceId]);

  const switchTab = (tabId: string) => {
    setChosenTabId(tabId);
    window.localStorage.setItem(`${TAB_STORAGE_PREFIX}${workspaceId}`, tabId);
  };

  // The sidebar links sessions as /w/<id>?tab=<tabId>; honor param changes.
  useEffect(() => {
    if (tabParam) setChosenTabId(tabParam);
  }, [tabParam]);

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

  /*
   * The root carries the scope even while the workspace is still loading:
   * `paneRootAt` hit-tests a pointer against these attributes, and a half that
   * only became findable once its data arrived would swallow the first drag
   * that crossed it. The unsplit window provides the scope too, so the
   * surfaces below have one way of finding their canvas rather than two.
   */
  return (
    <PaneScopeProvider
      workspaceId={workspaceId}
      side={side}
      split={split}
      routed={routed}
      active={active}
      rootRef={rootRef}
    >
      <div
        ref={rootRef}
        data-workspace-pane={workspaceId}
        data-split-side={side}
        // Capture, not bubble: a half has to claim the keyboard even when the
        // thing that was clicked stops the event on its way up.
        onPointerDownCapture={onActivate}
        onFocusCapture={onActivate}
        // Positioned so the launcher can hang off this half rather than off
        // the viewport once there are two of them. Without it an `absolute`
        // launcher escapes to the initial containing block, which on a page
        // that does not scroll lands close enough to the right answer to look
        // like it worked.
        className="relative flex h-[calc(var(--vv-height)-3rem)] min-h-0 flex-col bg-background @md/shell:h-[calc(var(--vv-height)-2*var(--content-inset))]"
      >
        {workspace ? (
          <>
            <WorkspaceTabs
              workspace={workspace}
              activeTabId={activeTabId ?? activeTab(workspace.layout).id}
              previewTiles={previewTiles}
              focusedId={focusedId}
              onPreviewTiles={setPreviewTiles}
              onSwitch={switchTab}
              onError={reportError}
              // Gated on `onUnsplit` rather than on `split`: the two part
              // company for the length of a close, and the affordance belongs
              // to the arrangement, not to the geometry. It goes on the click,
              // instead of standing on a window the user has dismissed while
              // the halves finish moving.
              splitChrome={
                onUnsplit && onRemoveFromSplit
                  ? {
                      workspaceName: workspace.name,
                      workspaceIcon: workspace.icon,
                      side,
                      onUnsplit,
                      onRemoveFromSplit,
                      // The rail's gesture, started from the strip: a
                      // workspace is picked up by its name and dropped into
                      // whichever half it should occupy, which is how a split
                      // is rearranged without going near the sidebar.
                      onCarry: (event) =>
                        startCarryDrag({
                          event,
                          workspace,
                          routedId,
                          lookup: (id) => workspaceById.get(id),
                          navigate: (id) => router.push(`/w/${id}`),
                        }),
                    }
                  : null
              }
            />

            {workspace.archived_at && <ArchivedBanner workspace={workspace} />}

            <div className="flex min-h-0 flex-1">
              <WorkspaceGrid
                workspace={workspace}
                tabId={activeTabId ?? activeTab(workspace.layout).id}
                sessions={workspaceSessions}
                initialFocusId={focusParam}
                onFocusChange={setFocusedId}
                onSwitchTab={switchTab}
                previewTiles={previewTiles}
                onPreviewTiles={setPreviewTiles}
                onDraggingPane={setDraggingPane}
                onError={reportError}
              />
            </div>

            {!workspace.archived_at && (
              <LauncherFab
                workspace={workspace}
                tabId={activeTabId ?? activeTab(workspace.layout).id}
                paneDragging={draggingPane}
                onPreviewTiles={setPreviewTiles}
                onCreated={({ sessionId }) => {
                  // Routing is how the routed half focuses a fresh session.
                  // The same push from the other half would move the address
                  // bar to a workspace the user did not ask to go to, so that
                  // half lets the pane arrive where the grid places it.
                  if (sessionId && routed) {
                    router.push(`/w/${workspace.id}?focus=${sessionId}`);
                  }
                }}
              />
            )}
          </>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center">
            {workspaceQ.isLoading ? (
              <Spinner label="Loading workspace" />
            ) : workspaceQ.error &&
              !(workspaceQ.error instanceof ApiError && workspaceQ.error.status === 404) ? (
              <p className="text-sm text-destructive">{String(workspaceQ.error)}</p>
            ) : null}
          </div>
        )}
      </div>
    </PaneScopeProvider>
  );
});
