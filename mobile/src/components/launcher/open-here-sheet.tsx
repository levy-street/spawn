import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { HostUpdateDialog } from "@/components/hosts/host-update-dialog";
import { hostNeedsUpdatePrompt } from "@/components/hosts/host-update-status";
import { FolderPicker } from "@/components/launcher/folder-picker";
import { pathFlavorForHostOS } from "@/components/launcher/folder-picker-logic";
import { launchAvailability } from "@/components/launcher/launch-orchestrator";
import { useDeviceApprovalGate } from "@/components/trust/device-approval-gate";
import { DrawerRow, DrawerSeparator } from "@/components/ui/drawer-row";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetHeader, SheetScrollView } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { useAgentsQuery } from "@/data/queries/hosts";
import { useCreateWindow } from "@/data/queries/launcher";
import { useWorkspacesQuery } from "@/data/queries/workspaces";
import { identifyAgent, sortAgents } from "@/data/selectors/agent";
import { displayPath, placeReasonLabel, suggestPlaces } from "@/data/selectors/places";
import { readLastWorkspace, rememberLastWorkspace } from "@/data/stores/last-workspace";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/** What the new window runs. */
type Choice = { kind: "shell" } | { kind: "agent"; agent: AgentOut };

/** What to run, where on the host, which workspace; "folder" browses for a place. */
type Step = "what" | "where" | "folder" | "workspace";

export interface OpenHereRequest {
  /** The folder, when the window is opened from one; null asks where. */
  cwd: string | null;
  /**
   * "shell" opens a shell without asking what; "agent" asks only which agent.
   * Omitted asks either.
   */
  run?: "shell" | "agent";
}

export interface OpenHereSheetProps {
  host: HostOut;
  /** Visible while set. */
  request: OpenHereRequest | null;
  /** This host's windows, which rank the places offered on it. */
  sessions: readonly SessionOut[];
  onDismiss(): void;
  onOpened(opened: { workspaceId: string; sessionId: string; warning?: string }): void;
}

function choiceLabel(choice: Choice): string {
  return choice.kind === "agent" ? choice.agent.name : "Shell";
}

/** The workspaces offered, the last one used first and then the rest in their own order. */
export function orderWorkspaceTargets(
  workspaces: readonly WorkspaceOut[],
  lastWorkspaceId: string | null,
): { workspace: WorkspaceOut; last: boolean }[] {
  const last = workspaces.find((workspace) => workspace.id === lastWorkspaceId);
  return [
    ...(last ? [{ workspace: last, last: true }] : []),
    ...workspaces
      .filter((workspace) => workspace.id !== last?.id)
      .map((workspace) => ({ workspace, last: false })),
  ];
}

function activeTabFull(workspace: WorkspaceOut, host: HostOut): boolean {
  const tab =
    workspace.layout.tabs.find((candidate) => candidate.id === workspace.layout.active_tab) ??
    workspace.layout.tabs[0];
  return tab ? launchAvailability(tab, host) === "tab_full" : true;
}

/**
 * "New window here…": a window on this host, from its page. What runs in it,
 * then where on this host (skipped when it is opened from a folder), then
 * which workspace it joins — the one used last first, or a new one it starts.
 * Made through the one window maker (`create-window.ts`), so it is the same
 * window the workspace's own "Add a window" would have made.
 */
export function OpenHereSheet({
  host,
  request,
  sessions,
  onDismiss,
  onOpened,
}: OpenHereSheetProps): React.JSX.Element {
  const theme = useTheme();
  const visible = request !== null;
  const agentsQuery = useAgentsQuery();
  const workspacesQuery = useWorkspacesQuery();
  const createWindow = useCreateWindow();
  // Browsing a host's folders needs it to have approved this device, so the
  // approval comes before the browse rather than as its error.
  const gate = useDeviceApprovalGate();
  const [step, setStep] = useState<Step>("what");
  const [history, setHistory] = useState<Step[]>([]);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [lastWorkspaceId, setLastWorkspaceId] = useState<string | null>(null);
  const [transport, setTransport] = useState<HostTransport | null>(null);
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<WorkspaceTarget | null>(null);
  const busy = createWindow.isPending;

  useEffect(() => {
    if (!request) return;
    const shell = request.run === "shell";
    setChoice(shell ? { kind: "shell" } : null);
    setCwd(request.cwd);
    setStep(shell ? (request.cwd === null ? "where" : "workspace") : "what");
    setHistory([]);
    setTransport(null);
    setTransportState("idle");
    setError(null);
    setUpdatePrompt(null);
    let active = true;
    void readLastWorkspace().then((id) => {
      if (active) setLastWorkspaceId(id);
    });
    return () => {
      active = false;
    };
  }, [request]);

  const go = (next: Step) => {
    setError(null);
    setHistory((previous) => [...previous, step]);
    setStep(next);
  };
  const back = () => {
    const prior = history[history.length - 1];
    if (!prior) return;
    haptics.selection();
    setError(null);
    setHistory(history.slice(0, -1));
    setStep(prior);
    // Back to before the place was chosen: it is asked again, not assumed.
    if (request?.cwd == null && (prior === "what" || prior === "where")) setCwd(null);
  };

  const handleTransport = useCallback((next: HostTransport) => setTransport(next), []);

  const agents = useMemo(() => sortAgents(agentsQuery.data ?? []), [agentsQuery.data]);
  // Only this host's places: its windows' folders, then its home.
  const places = useMemo(() => suggestPlaces({ sessions, hosts: [host] }), [host, sessions]);
  const targets = orderWorkspaceTargets(workspacesQuery.data ?? [], lastWorkspaceId);

  const pick = (next: Choice) => {
    haptics.selection();
    setChoice(next);
    go(cwd === null ? "where" : "workspace");
  };

  const place = (path: string) => {
    haptics.selection();
    setCwd(path);
    go("workspace");
  };

  const perform = async (target: WorkspaceTarget) => {
    if (!choice || cwd === null || busy) return;
    setError(null);
    try {
      const result = await createWindow.mutateAsync({
        host,
        cwd,
        ...(choice.kind === "agent" ? { agent: choice.agent } : {}),
        workspace:
          target.kind === "new"
            ? { kind: "new-workspace" }
            : { kind: "workspace", workspaceId: target.id },
      });
      const workspaceId = result.workspaceId ?? (target.kind === "existing" ? target.id : null);
      if (workspaceId === null) throw new Error("The window was opened outside any workspace.");
      rememberLastWorkspace(workspaceId);
      haptics.success();
      onOpened({
        workspaceId,
        sessionId: result.session.id,
        ...(result.status === "created_unqueued"
          ? {
              warning: `The shell was created, but ${choiceLabel(choice)} could not be queued: ${result.message}`,
            }
          : {}),
      });
      onDismiss();
    } catch (cause) {
      haptics.error();
      setError(cause instanceof Error ? cause.message : "Could not open the window.");
    }
  };

  const open = (target: WorkspaceTarget) => {
    if (hostNeedsUpdatePrompt(host)) {
      setUpdatePrompt(target);
      return;
    }
    void perform(target);
  };

  const proceedPastUpdate = () => {
    const pending = updatePrompt;
    setUpdatePrompt(null);
    if (pending) void perform(pending);
  };

  // Browsing the host's folders is a channel to it, verified by its key; a
  // host this device holds no key for still takes a window in a known place.
  const browsable = host.host_public_key !== null;

  const browse = () => {
    if (!browsable) return;
    haptics.selection();
    gate.guard(host.id, () => {
      setTransport(null);
      setTransportState("idle");
      go("folder");
    });
  };

  const title =
    step === "what"
      ? `New window on ${host.name}`
      : step === "where"
        ? `Where on ${host.name}?`
        : step === "folder"
          ? `Folder for ${choice ? choiceLabel(choice) : "the window"}`
          : "Open in which workspace?";

  const whatRows = (
    <>
      {request?.run === "agent" ? null : (
        <DrawerRow
          detail="A plain login shell"
          disabled={busy}
          icon={<Icon name="SquareTerminal" />}
          label="Shell"
          onPress={() => pick({ kind: "shell" })}
          testID="open-here-shell"
        />
      )}
      {agents.map((agent) => (
        <DrawerRow
          detail={agent.command}
          disabled={busy}
          icon={
            <AgentIcon
              identity={identifyAgent(agent.command, [agent])}
              size={sizing.actionSheet.icon}
            />
          }
          key={agent.id}
          label={agent.name}
          onPress={() => pick({ kind: "agent", agent })}
          testID={`open-here-agent-${agent.id}`}
        />
      ))}
      {request?.run === "agent" && agents.length === 0 && !agentsQuery.isPending ? (
        <Text color="mutedForeground" style={styles.note}>
          No agents are defined. Add one in Settings → Agents.
        </Text>
      ) : null}
    </>
  );

  const whereRows = (
    <>
      {places.map((suggestion, index) => (
        <DrawerRow
          detail={placeReasonLabel(suggestion.reason)}
          disabled={busy}
          icon={<StatusDot tone="active" />}
          key={suggestion.cwd}
          label={displayPath(suggestion.cwd)}
          onPress={() => place(suggestion.cwd)}
          testID={index === 0 ? "open-here-where-suggested" : `open-here-where-${index}`}
        />
      ))}
      <DrawerSeparator />
      <DrawerRow
        detail={
          browsable
            ? `Browse ${host.name}`
            : "Reconnect this host to establish its trusted identity before browsing files."
        }
        disabled={busy || !browsable}
        icon={<Icon name="FolderOpen" />}
        label="Choose a folder…"
        onPress={browse}
        testID="open-here-where-browse"
      />
    </>
  );

  const workspaceRows = (
    <>
      {cwd !== null ? (
        <Text color="mutedForeground" style={styles.note} variant="caption">
          {`${choice ? choiceLabel(choice) : "Shell"} in ${displayPath(cwd)} on ${host.name}`}
        </Text>
      ) : null}
      {workspacesQuery.isPending ? (
        <View style={styles.centered}>
          <Spinner size={spacing[6]} />
        </View>
      ) : (
        targets.map(({ workspace, last }) => {
          const full = activeTabFull(workspace, host);
          return (
            <DrawerRow
              disabled={busy || full}
              icon={
                <WorkspaceIcon
                  icon={workspace.icon}
                  name={workspace.name}
                  size={sizing.actionSheet.icon}
                />
              }
              key={workspace.id}
              label={workspace.name}
              onPress={() => open({ kind: "existing", id: workspace.id })}
              testID={`open-here-workspace-${workspace.id}`}
              {...(full ? { detail: "Full" } : last ? { detail: "Last used" } : {})}
            />
          );
        })
      )}
      <DrawerSeparator />
      <DrawerRow
        detail="Starts with this window"
        disabled={busy}
        icon={<Icon name="Plus" />}
        label="New workspace"
        onPress={() => open({ kind: "new" })}
        testID="open-here-new-workspace"
      />
    </>
  );

  return (
    <>
      <Sheet onDismiss={onDismiss} size="tall" testID="open-here-sheet" visible={visible}>
        {history.length > 0 ? (
          <View style={[styles.stepBar, { borderBottomColor: theme.colors.border }]}>
            <IconButton accessibilityLabel="Go back" icon="ChevronLeft" onPress={back} size="sm" />
            <Text numberOfLines={1} style={styles.stepTitle} variant="label">
              {title}
            </Text>
            <View style={styles.backPlaceholder} />
          </View>
        ) : (
          <SheetHeader title={title} />
        )}
        {error ? (
          <View style={[styles.error, { backgroundColor: theme.colors.destructiveSoft }]}>
            <Text accessibilityRole="alert" color="destructive">
              {error}
            </Text>
          </View>
        ) : null}
        {busy ? (
          <View style={styles.centered}>
            <Spinner size={spacing[6]} />
            <Text color="mutedForeground">Opening…</Text>
          </View>
        ) : step === "folder" ? (
          <FolderPicker
            initialPath={cwd}
            onSelect={place}
            pathFlavor={pathFlavorForHostOS(host.os)}
            recentDirectories={[]}
            transport={transport}
            transportState={transportState}
          />
        ) : (
          <SheetScrollView contentContainerStyle={styles.menuContent}>
            {step === "what" ? whatRows : step === "where" ? whereRows : workspaceRows}
          </SheetScrollView>
        )}
        {visible && step === "folder" && host.host_public_key ? (
          <HostTransportSurface
            hostId={host.id}
            hostIdentityPublicKey={host.host_public_key}
            onError={(transportError) => setError(transportError.message)}
            onStateChange={setTransportState}
            onTransport={handleTransport}
          />
        ) : null}
      </Sheet>
      {gate.overlay}
      {updatePrompt ? (
        <HostUpdateDialog
          host={host}
          onDismiss={() => setUpdatePrompt(null)}
          onNotNow={proceedPastUpdate}
          onUpdated={proceedPastUpdate}
          visible
        />
      ) : null}
    </>
  );
}

type WorkspaceTarget = { kind: "existing"; id: string } | { kind: "new" };

const styles = StyleSheet.create({
  backPlaceholder: { height: spacing[9], width: spacing[9] },
  centered: {
    alignItems: "center",
    gap: spacing[3],
    justifyContent: "center",
    padding: spacing[6],
  },
  error: { margin: spacing[4], padding: spacing[3] },
  menuContent: { paddingBottom: spacing[2] },
  note: { paddingBottom: spacing[2], paddingHorizontal: spacing[4] },
  stepBar: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[4],
  },
  stepTitle: { flex: 1, textAlign: "center" },
});
