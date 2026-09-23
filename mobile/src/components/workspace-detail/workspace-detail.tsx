import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { TabPager } from "@/components/gestures/tab-pager";
import { HostUpdateDialog } from "@/components/hosts/host-update-dialog";
import { hostNeedsUpdatePrompt } from "@/components/hosts/host-update-status";
import { LauncherSheet } from "@/components/launcher/launcher-sheet";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { TranscriptsSheet } from "@/components/terminal-ui/transcripts-sheet";
import { Confirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import {
  MovePaneHostSheet,
  MovePaneSheet,
  PaneActionsSheet,
  type PaneActionTarget,
  TabActionsSheet,
  WorkspaceActionsSheet,
} from "@/components/workspace-detail/action-sheets";
import { type PaneGhost, usePaneDragValues } from "@/components/workspace-detail/pane-drag";
import { PaneDragGhost } from "@/components/workspace-detail/pane-drag-ghost";
import { PaneList } from "@/components/workspace-detail/pane-list";
import { RenameDialog } from "@/components/workspace-detail/rename-dialog";
import { TabStrip } from "@/components/workspace-detail/tab-strip";
import { useWorkspaceActions } from "@/components/workspace-detail/use-workspace-actions";
import {
  WorkspaceErrorBanner,
  WorkspaceLoadingState,
  WorkspaceUnavailableState,
} from "@/components/workspace-detail/workspace-detail-states";
import { WorkspaceHeader } from "@/components/workspace-detail/workspace-header";
import { canAddTab } from "@/data/layout/tabs";
import { canAddTile } from "@/data/layout/tiles";
import { useWorkspaceDetail } from "@/data/queries/workspace-detail";
import { selectActiveTabId } from "@/data/selectors/workspace";
import { useConnectionStore } from "@/data/stores/connection";
import type { Session, Workspace } from "@/data/types/domain";
import type { Tile, WorkspaceTab } from "@/data/types/layout";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { tabSurfaces, useTheme } from "@/theme";

export interface WorkspaceDetailProps {
  workspaceId: string;
  onBack: () => void;
  onOpenTerminal: (sessionId: string) => void;
  onOpenFiles: (hostId: string, path: string) => void;
}

type RenameTarget =
  | { kind: "workspace"; id: string; value: string }
  | { kind: "tab"; id: string; value: string }
  | { kind: "session"; id: string; value: string };

interface ConfirmationState {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}

const TAB_FULL_MESSAGE = "This tab is full. A tab can contain up to 16 panes.";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Something went wrong.";
}

export function WorkspaceDetail({
  workspaceId,
  onBack,
  onOpenTerminal,
  onOpenFiles,
}: WorkspaceDetailProps) {
  const theme = useTheme();
  const surfaces = theme.isDark ? tabSurfaces.dark : tabSurfaces.light;
  const toast = useToast();
  const detail = useWorkspaceDetail(workspaceId);
  const workspace = detail.workspace.data ?? null;
  const sessions = detail.sessions.data ?? [];
  const hosts = detail.hosts.data ?? [];
  const agents = detail.agents.data ?? [];
  // Pulled out of `detail` because the hook hands back a fresh object every
  // render; the pages are memoised on these two alone.
  const refreshDetail = detail.refresh;
  const detailRefreshing = detail.refreshing;
  const transports = useConnectionStore((state) => state.sessionTransports);
  const dragProgress = useSharedValue(0);
  const progressEnvelopeRef = useRef("");
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [paneTarget, setPaneTarget] = useState<PaneActionTarget | null>(null);
  const [moveTile, setMoveTile] = useState<Tile | null>(null);
  const [hostTarget, setHostTarget] = useState<{ tile: Tile; session: Session } | null>(null);
  const [tabTarget, setTabTarget] = useState<WorkspaceTab | null>(null);
  const [workspaceActionsVisible, setWorkspaceActionsVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [launcherTabId, setLauncherTabId] = useState<string | null>(null);
  const [fileUpdatePrompt, setFileUpdatePrompt] = useState<{
    hostId: string;
    path: string;
  } | null>(null);
  const paneDrag = usePaneDragValues();
  const screenRef = useRef<View>(null);
  const [screenOrigin, setScreenOrigin] = useState({ x: 0, y: 0 });
  const [draggingPane, setDraggingPane] = useState<{
    tabId: string;
    tile: Tile;
    ghost: PaneGhost;
  } | null>(null);
  const draggingPaneRef = useRef<typeof draggingPane>(null);
  draggingPaneRef.current = draggingPane;
  const workspaceRef = useRef<Workspace | null>(null);
  workspaceRef.current = workspace;
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const actions = useWorkspaceActions((error) => {
    setOperationError(errorMessage(error));
    haptics.error();
  });

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const hostsById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  // The transcript sheet reads host files, which takes a host consumer channel
  // of its own; it exists only while the sheet is up. The session is kept
  // past dismissal so the sheet can animate out over it.
  const [transcriptSession, setTranscriptSession] = useState<Session | null>(null);
  const [transcriptsVisible, setTranscriptsVisible] = useState(false);
  const [transcriptTransport, setTranscriptTransport] = useState<HostTransport | null>(null);
  const [transcriptTransportState, setTranscriptTransportState] = useState<TransportState>("idle");
  const transcriptHost = transcriptSession ? hostsById.get(transcriptSession.host_id) : undefined;
  const transcriptHostKey = transcriptHost?.host_public_key ?? null;
  const fileUpdateHost = fileUpdatePrompt ? (hostsById.get(fileUpdatePrompt.hostId) ?? null) : null;
  const requestOpenFiles = useCallback(
    (hostId: string, path: string) => {
      const host = hostsById.get(hostId);
      if (host && hostNeedsUpdatePrompt(host)) {
        setFileUpdatePrompt({ hostId, path });
        return;
      }
      onOpenFiles(hostId, path);
    },
    [hostsById, onOpenFiles],
  );

  const resolvedTabId = workspace
    ? selectActiveTabId(workspace, { deviceTabId: selectedTabId })
    : null;
  const activeIndex = workspace
    ? Math.max(
        0,
        workspace.layout.tabs.findIndex((tab) => tab.id === resolvedTabId),
      )
    : 0;
  const activeTab = workspace?.layout.tabs[activeIndex] ?? null;
  const envelopeIdentity = workspace
    ? `${workspace.id}:${workspace.layout.tabs.map((tab) => tab.id).join(",")}`
    : "";

  useEffect(() => {
    if (!workspace || progressEnvelopeRef.current === envelopeIdentity) return;
    progressEnvelopeRef.current = envelopeIdentity;
    dragProgress.value = activeIndex;
  }, [activeIndex, dragProgress, envelopeIdentity, workspace]);

  useEffect(() => {
    if (resolvedTabId !== null && selectedTabId !== resolvedTabId) {
      setSelectedTabId(resolvedTabId);
    }
  }, [resolvedTabId, selectedTabId]);

  const run = useCallback(
    /**
     * @param done raised as a toast when the operation lands. Reserved for the
     *   destructive ones: a row that vanishes is its own confirmation, but a
     *   killed session leaves nothing behind to say what just happened to it.
     */
    async (operation: () => Promise<unknown>, after?: () => void, done?: string) => {
      setBusy(true);
      setOperationError(null);
      try {
        await operation();
        after?.();
        haptics.success();
        if (done) toast.success(done);
      } catch (error) {
        setOperationError(errorMessage(error));
        haptics.error();
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  /*
   * Carrying a pane to another tab. The gesture reports window coordinates, so
   * the ghost's container has to know where it sits; the drop itself is the
   * same layout write the pane menu's "Move to another tab" performs.
   */
  const measureScreen = useCallback(() => {
    screenRef.current?.measureInWindow((x: number, y: number) => setScreenOrigin({ x, y }));
  }, []);

  const beginPaneDrag = useCallback(
    (tabId: string, tile: Tile, ghost: PaneGhost) => {
      haptics.impact("medium");
      // Measured again on pickup rather than trusted from layout: a screen that
      // has been pushed or rotated since then would put the ghost under the
      // wrong finger.
      measureScreen();
      setDraggingPane({ tabId, tile, ghost });
    },
    [measureScreen],
  );

  const dropPane = useCallback(
    (tabIndex: number) => {
      const dragged = draggingPaneRef.current;
      const current = workspaceRef.current;
      setDraggingPane(null);
      if (!dragged || !current) return;
      const target = current.layout.tabs[tabIndex];
      if (!target || target.id === dragged.tabId) return;
      haptics.impact("light");
      void run(
        () => actions.movePane(current, dragged.tile.session_id, target.id),
        // The pane is followed to where it landed, so the move is visible.
        () => setSelectedTabId(target.id),
      );
    },
    [actions, run],
  );

  const presentLauncher = useCallback((tabId: string) => setLauncherTabId(tabId), []);
  const presentWorkspaceActions = useCallback(() => setWorkspaceActionsVisible(true), []);

  const presentActiveLauncher = useCallback(() => {
    if (!activeTab || !canAddTile(activeTab.layout)) {
      setOperationError(TAB_FULL_MESSAGE);
      haptics.warning();
      return;
    }
    presentLauncher(activeTab.id);
  }, [activeTab, presentLauncher]);

  const confirmRemove = useCallback(
    (currentWorkspace: Workspace, tile: Tile) => {
      const session = sessionsById.get(tile.session_id) ?? null;
      setConfirmation({
        title: session ? "Close session?" : "Remove pane?",
        description: session
          ? "This kills the running process and deletes the session."
          : "This removes the files pane from this workspace.",
        confirmLabel: session ? "Close session" : "Remove",
        onConfirm: () => {
          setConfirmation(null);
          void run(
            () => actions.removePane(currentWorkspace, tile),
            () => setPaneTarget(null),
            session ? "Session killed" : "Pane removed",
          );
        },
      });
    },
    [actions, run, sessionsById],
  );

  const closeTab = useCallback(
    (tab: WorkspaceTab) => {
      if (!workspace) return;
      const close = () => {
        void run(
          () => actions.deleteTab(workspace, tab.id),
          () => setTabTarget(null),
          `Closed ${tab.name}`,
        );
      };
      if (!tab.layout.tiles.some((tile) => !tile.widget)) {
        close();
        return;
      }
      setConfirmation({
        title: `Close ${tab.name}?`,
        description: "Every session in this tab will be killed and deleted.",
        confirmLabel: "Close tab",
        onConfirm: () => {
          setConfirmation(null);
          close();
        },
      });
    },
    [actions, run, workspace],
  );

  const renderPage = useCallback(
    (tab: WorkspaceTab) => {
      if (!workspace) return null;
      // Nowhere to carry a pane to while the workspace has a single tab.
      const carryable = workspace.layout.tabs.length > 1;
      return (
        <PaneList
          agents={agents}
          canAddPane={canAddTile(tab.layout)}
          draggingPaneId={draggingPane?.tile.session_id ?? null}
          hostsById={hostsById}
          onAddPane={() => presentLauncher(tab.id)}
          onOpenFiles={requestOpenFiles}
          onOpenTerminal={onOpenTerminal}
          onPaneActions={(tile) => setPaneTarget({ tabId: tab.id, tile })}
          onRefresh={refreshDetail}
          refreshing={detailRefreshing}
          sessionsById={sessionsById}
          tab={tab}
          transports={transports}
          {...(carryable
            ? {
                paneDrag,
                onPaneDragBegin: (tile: Tile, ghost: PaneGhost) =>
                  beginPaneDrag(tab.id, tile, ghost),
                onPaneDragEnd: dropPane,
              }
            : {})}
        />
      );
    },
    [
      agents,
      beginPaneDrag,
      detailRefreshing,
      draggingPane,
      dropPane,
      hostsById,
      onOpenTerminal,
      paneDrag,
      presentLauncher,
      refreshDetail,
      requestOpenFiles,
      sessionsById,
      transports,
      workspace,
    ],
  );

  if (detail.loading && !workspace) {
    return (
      <Screen header={<AppHeader onBack={onBack} title="Workspace" />} padded={false}>
        <WorkspaceLoadingState />
      </Screen>
    );
  }

  if (!workspace) {
    return (
      <Screen header={<AppHeader onBack={onBack} title="Workspace" />} padded={false}>
        <WorkspaceUnavailableState
          message={errorMessage(detail.error)}
          onRetry={() => void detail.workspace.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <WorkspaceHeader
          canAddPane={activeTab ? canAddTile(activeTab.layout) : false}
          onActions={presentWorkspaceActions}
          onAddPane={presentActiveLauncher}
          onBack={onBack}
          workspace={workspace}
        />
      }
      padded={false}
    >
      <View
        onLayout={measureScreen}
        ref={screenRef}
        style={[styles.screen, { backgroundColor: theme.colors.background }]}
      >
        <TabStrip
          activeIndex={activeIndex}
          addBusy={busy}
          canAdd={canAddTab(workspace.layout)}
          onActions={setTabTarget}
          onAdd={() => {
            void run(async () => {
              const saved = await actions.createTab(workspace);
              if (saved.layout.active_tab) setSelectedTabId(saved.layout.active_tab);
            });
          }}
          onClose={closeTab}
          onReorder={(tabId, toIndex) => actions.reorderTab(workspace, tabId, toIndex)}
          onSelect={(index) => {
            const tab = workspace.layout.tabs[index];
            if (tab) setSelectedTabId(tab.id);
          }}
          paneDrag={paneDrag}
          sessionsById={sessionsById}
          tabs={workspace.layout.tabs}
        />
        {operationError ? <WorkspaceErrorBanner message={operationError} /> : null}
        <TabPager
          lazyWindow={1}
          onDragProgress={dragProgress}
          onPageChange={(index) => {
            const tab = workspace.layout.tabs[index];
            if (tab) setSelectedTabId(tab.id);
          }}
          page={activeIndex}
          pages={workspace.layout.tabs}
          renderPage={renderPage}
          style={{
            backgroundColor:
              activeTab && activeTab.layout.tiles.length > 0 ? surfaces.focused : surfaces.empty,
          }}
          testID="workspace-tab-pager"
        />

        <PaneDragGhost
          drag={paneDrag}
          originX={screenOrigin.x}
          originY={screenOrigin.y}
          pane={draggingPane?.ghost ?? null}
        />

        <PaneActionsSheet
          agents={agents}
          onDismiss={() => setPaneTarget(null)}
          onDuplicate={(tile, session) => {
            void run(
              () => actions.duplicatePane(workspace, tile, session, agents),
              () => setPaneTarget(null),
            );
          }}
          onMove={(tile) => setMoveTile(tile)}
          onMoveToHost={(tile, session) => setHostTarget({ tile, session })}
          onRemove={(tile) => confirmRemove(workspace, tile)}
          onRename={(session) =>
            setRenameTarget({ kind: "session", id: session.id, value: session.name ?? "" })
          }
          onReorder={(target, offset) => {
            actions.reorderPane(workspace, target.tabId, target.tile.session_id, offset);
            setPaneTarget(null);
          }}
          onRestart={(session) => {
            void run(
              () => actions.restartSession(session, agents),
              () => setPaneTarget(null),
            );
          }}
          onTranscripts={(session) => {
            setPaneTarget(null);
            setTranscriptSession(session);
            setTranscriptsVisible(true);
          }}
          sessionsById={sessionsById}
          target={paneTarget}
          visible={paneTarget !== null}
          workspace={workspace}
        />
        {transcriptsVisible && transcriptHost && transcriptHostKey ? (
          <HostTransportSurface
            hostId={transcriptHost.id}
            hostIdentityPublicKey={transcriptHostKey}
            onStateChange={setTranscriptTransportState}
            onTransport={setTranscriptTransport}
          />
        ) : null}
        {transcriptSession ? (
          <TranscriptsSheet
            agents={agents}
            hostName={transcriptSession.host_name ?? transcriptHost?.name ?? "this host"}
            onDismiss={() => {
              setTranscriptsVisible(false);
              setTranscriptTransport(null);
              setTranscriptTransportState("idle");
            }}
            session={transcriptSession}
            transport={transcriptsVisible ? transcriptTransport : null}
            transportState={
              !transcriptHostKey ? "failed" : transcriptsVisible ? transcriptTransportState : "idle"
            }
            visible={transcriptsVisible}
          />
        ) : null}
        <MovePaneHostSheet
          hosts={hosts}
          onDismiss={() => setHostTarget(null)}
          onSelect={(host) => {
            const target = hostTarget;
            if (!target) return;
            setHostTarget(null);
            setConfirmation({
              title: `Move to ${host.name}?`,
              description:
                "This window's shell is closed and its running process killed; a new one starts in your home folder there.",
              confirmLabel: "Move window",
              onConfirm: () => {
                setConfirmation(null);
                void run(
                  () =>
                    actions.movePaneToHost(workspace, target.tile, host, target.session, agents),
                  () => setPaneTarget(null),
                );
              },
            });
          }}
          session={hostTarget?.session ?? null}
          visible={hostTarget !== null}
        />
        <MovePaneSheet
          onDismiss={() => setMoveTile(null)}
          onMove={(tabId) => {
            if (moveTile) {
              void run(
                () => actions.movePane(workspace, moveTile.session_id, tabId),
                () => {
                  setMoveTile(null);
                  setPaneTarget(null);
                },
              );
            }
          }}
          tile={moveTile}
          visible={moveTile !== null}
          workspace={workspace}
        />
        <TabActionsSheet
          onDelete={closeTab}
          onDismiss={() => setTabTarget(null)}
          onRename={(tab) => setRenameTarget({ kind: "tab", id: tab.id, value: tab.name })}
          onReorder={(tab, offset) => {
            const index = workspace.layout.tabs.findIndex((candidate) => candidate.id === tab.id);
            actions.reorderTab(workspace, tab.id, index + offset);
            setTabTarget(null);
          }}
          tab={tabTarget}
          visible={tabTarget !== null}
          workspace={workspace}
        />
        <WorkspaceActionsSheet
          canAddTab={canAddTab(workspace.layout)}
          onAddTab={() => {
            void run(async () => {
              const saved = await actions.createTab(workspace);
              if (saved.layout.active_tab) setSelectedTabId(saved.layout.active_tab);
            });
          }}
          onDismiss={() => setWorkspaceActionsVisible(false)}
          onRename={() =>
            setRenameTarget({ kind: "workspace", id: workspace.id, value: workspace.name })
          }
          visible={workspaceActionsVisible}
          workspace={workspace}
        />
        <RenameDialog
          allowEmpty={renameTarget?.kind === "session"}
          initialValue={renameTarget?.value ?? ""}
          loading={busy}
          maxLength={renameTarget?.kind === "tab" ? 64 : 128}
          onDismiss={() => setRenameTarget(null)}
          onSubmit={(value) => {
            if (!renameTarget) return;
            const operation = (() => {
              if (renameTarget.kind === "workspace")
                return actions.renameWorkspace(workspace, value);
              if (renameTarget.kind === "tab")
                return actions.renameTab(workspace, renameTarget.id, value);
              const session: Session | undefined = sessionsById.get(renameTarget.id);
              if (!session) return Promise.reject(new Error("Session unavailable."));
              return actions.renameSession(session, value);
            })();
            void run(
              () => operation,
              () => setRenameTarget(null),
            );
          }}
          title={
            renameTarget?.kind === "workspace"
              ? "Rename workspace"
              : renameTarget?.kind === "tab"
                ? "Rename tab"
                : "Rename session"
          }
          visible={renameTarget !== null}
        />
        <Confirm
          destructive
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            confirmation?.onConfirm();
          }}
          title={confirmation?.title ?? "Confirm"}
          visible={confirmation !== null}
          {...(confirmation === null
            ? {}
            : {
                confirmLabel: confirmation.confirmLabel,
                description: confirmation.description,
              })}
        />
        <LauncherSheet
          initialTabId={launcherTabId}
          onDismiss={() => setLauncherTabId(null)}
          onLaunchError={(message) => setOperationError(message)}
          onLaunched={({ session, warning }) => {
            setLauncherTabId(null);
            if (warning) setOperationError(warning);
            // A file explorer has no session to open: it is already in the tab.
            if (session) onOpenTerminal(session.id);
          }}
          visible={launcherTabId !== null}
          workspaceId={workspace.id}
        />
        {fileUpdatePrompt && fileUpdateHost ? (
          <HostUpdateDialog
            host={fileUpdateHost}
            onDismiss={() => setFileUpdatePrompt(null)}
            onNotNow={() => {
              onOpenFiles(fileUpdatePrompt.hostId, fileUpdatePrompt.path);
              setFileUpdatePrompt(null);
            }}
            onUpdated={() => {
              onOpenFiles(fileUpdatePrompt.hostId, fileUpdatePrompt.path);
              setFileUpdatePrompt(null);
            }}
            visible
          />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
});
