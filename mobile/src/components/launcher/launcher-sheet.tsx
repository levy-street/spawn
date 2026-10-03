import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { HostUpdateDialog } from "@/components/hosts/host-update-dialog";
import { hostNeedsUpdatePrompt } from "@/components/hosts/host-update-status";
import { FolderPicker } from "@/components/launcher/folder-picker";
import { pathFlavorForHostOS } from "@/components/launcher/folder-picker-logic";
import { HostStep } from "@/components/launcher/host-step";
import { useDeviceApprovalGate } from "@/components/trust/device-approval-gate";
import { Button } from "@/components/ui/button";
import { DrawerRow, DrawerSeparator } from "@/components/ui/drawer-row";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetHeader, SheetScrollView } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import {
  discardLaunchedSession,
  keepLaunchedShell,
  useAddFilesWidget,
  useLauncherData,
  useLaunchSession,
  useRecentDirectories,
} from "@/data/queries/launcher";
import { identifyAgent, sortAgents } from "@/data/selectors/agent";
import { displayPath, placeReasonLabel, suggestPlaces } from "@/data/selectors/places";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/** What the drawer is about to add: a shell, an agent in a shell, or a widget. */
type Choice = { kind: "shell" } | { kind: "agent"; agent: AgentOut } | { kind: "files" };

/**
 * What to run ("choose"), then where it runs ("where": the likeliest places,
 * first one first). "host" and "folder" browse for anywhere else.
 */
type LauncherStep = "choose" | "where" | "host" | "folder" | "recovery";

/** Past this many rows the menu scrolls, so the panel claims the tall shape. */
const COMPACT_ROW_LIMIT = 7;

export interface LauncherCompletion {
  /** Null when a file explorer was added: a widget is layout, not a session. */
  session: SessionOut | null;
  pendingCommand: boolean;
  warning?: string;
}

export interface LauncherSheetProps {
  /** The tab the new window lands in; defaults to the workspace's active tab. */
  initialTabId?: string | null;
  onDismiss(): void;
  onLaunchError?(message: string, sessionId?: string): void;
  onLaunched(completion: LauncherCompletion): void;
  visible: boolean;
  workspaceId: string;
}

/** What the picker steps are finding a place for. */
function choiceLabel(choice: Choice): string {
  if (choice.kind === "agent") return choice.agent.name;
  return choice.kind === "files" ? "File explorer" : "Shell";
}

/**
 * Adding a window: what to run, then where it runs.
 *
 * A workspace has no host or folder of its own — each window says where it
 * runs — so the second step is always asked, with the likeliest place first:
 * beside the windows of this tab, then this workspace, then recent places,
 * then each host's home. "Choose a folder…" browses any host for anything
 * else. The window can be moved again from its header (`terminal-header`).
 */
export function LauncherSheet({
  initialTabId,
  onDismiss,
  onLaunchError,
  onLaunched,
  visible,
  workspaceId,
}: LauncherSheetProps): React.JSX.Element {
  const theme = useTheme();
  const data = useLauncherData(workspaceId, visible);
  const launch = useLaunchSession();
  // Listing a machine's folders needs that machine to have approved this
  // device, so the approval comes before the browse rather than as its error.
  const gate = useDeviceApprovalGate();
  const addWidget = useAddFilesWidget();
  const cancelRequested = useRef(false);
  const [step, setStep] = useState<LauncherStep>("choose");
  /** The choice the "where" steps are completing. */
  const [pendingChoice, setPendingChoice] = useState<Choice | null>(null);
  const [pickerHost, setPickerHost] = useState<HostOut | null>(null);
  const [hostTransport, setHostTransport] = useState<HostTransport | null>(null);
  const [hostTransportState, setHostTransportState] = useState<TransportState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ session: SessionOut; message: string } | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<{
    host: HostOut;
    cwd: string;
    target: Choice;
  } | null>(null);
  const recents = useRecentDirectories(pickerHost?.id ?? null, visible && step === "folder");
  const workspace = data.workspace;
  const busy = launch.isPending || addWidget.isPending;

  const tabId =
    (initialTabId ?? workspace?.layout.active_tab ?? workspace?.layout.tabs[0]?.id) || "";
  const tab = workspace?.layout.tabs.find((candidate) => candidate.id === tabId);
  const places = useMemo(
    () =>
      suggestPlaces({
        sessions: data.sessions,
        hosts: data.hosts,
        tabSessionIds: tab?.layout.tiles.map((tile) => tile.session_id) ?? [],
        workspaceSessionIds:
          workspace?.layout.tabs.flatMap((each) => each.layout.tiles.map((t) => t.session_id)) ??
          [],
      }),
    [data.sessions, data.hosts, tab, workspace],
  );
  const agents = useMemo(() => sortAgents(data.agents), [data.agents]);

  useEffect(() => {
    if (!visible) return;
    setStep("choose");
    setPendingChoice(null);
    setPickerHost(null);
    setHostTransport(null);
    setHostTransportState("idle");
    setError(null);
    setRecovery(null);
    setUpdatePrompt(null);
    cancelRequested.current = false;
  }, [visible]);

  const handleCancel = () => {
    // A launch already in flight cannot be recalled, so the drawer leaves and the
    // session it creates is discarded the moment the request lands.
    if (launch.isPending) cancelRequested.current = true;
    onDismiss();
  };

  const handleTransport = useCallback((transport: HostTransport) => {
    setHostTransport(transport);
  }, []);

  const performCreate = async (host: HostOut, cwd: string, target: Choice) => {
    if (!tabId || busy) return;
    setError(null);
    try {
      if (target.kind === "files") {
        await addWidget.mutateAsync({ workspaceId, tabId, hostId: host.id, path: cwd });
        haptics.success();
        onLaunched({ session: null, pendingCommand: false });
        onDismiss();
        return;
      }

      const result = await launch.mutateAsync({
        workspaceId,
        tabId,
        hostId: host.id,
        cwd,
        ...(target.kind === "agent" ? { agent: target.agent } : {}),
      });

      if (cancelRequested.current) {
        try {
          await discardLaunchedSession(result.session.id);
        } catch (cause) {
          onLaunchError?.(
            cause instanceof Error ? cause.message : "The cancelled session could not be removed.",
            result.session.id,
          );
        }
        onDismiss();
        return;
      }

      if (result.status === "created_unqueued") {
        haptics.error();
        setRecovery({
          session: result.session,
          message:
            "The shell was created, but the agent command could not be saved. Keep the shell or remove it.",
        });
        setStep("recovery");
        return;
      }

      haptics.success();
      onLaunched({ session: result.session, pendingCommand: result.pendingCommand });
      onDismiss();
    } catch (cause) {
      haptics.error();
      const message = cause instanceof Error ? cause.message : "Could not launch the session.";
      setError(message);
      onLaunchError?.(message);
      if (cancelRequested.current) onDismiss();
    }
  };

  const create = (host: HostOut, cwd: string, target: Choice) => {
    if (hostNeedsUpdatePrompt(host)) {
      setUpdatePrompt({ host, cwd, target });
      return;
    }
    void performCreate(host, cwd, target);
  };

  const proceedPastUpdate = () => {
    const pending = updatePrompt;
    setUpdatePrompt(null);
    if (pending) void performCreate(pending.host, pending.cwd, pending.target);
  };

  /**
   * Browse for a folder anywhere: one host opens the browser straight away,
   * several ask which machine first.
   */
  const browse = () => {
    haptics.selection();
    setError(null);
    const only = data.hosts.length === 1 ? data.hosts[0] : null;
    if (only) {
      setPickerHost(only);
      setStep("folder");
      return;
    }
    setPickerHost(null);
    setStep("host");
  };

  // What goes in the window; then where it runs — always the second step.
  const pick = (target: Choice) => {
    haptics.selection();
    setError(null);
    setPendingChoice(target);
    setStep("where");
  };

  const rows = [
    {
      key: "shell",
      label: "Shell",
      detail: "A plain login shell",
      icon: <Icon name="SquareTerminal" />,
      onPress: () => pick({ kind: "shell" }),
    },
    ...agents.map((agent) => ({
      key: agent.id,
      label: agent.name,
      detail: agent.command,
      icon: (
        <AgentIcon
          identity={identifyAgent(agent.command, [agent])}
          size={sizing.actionSheet.icon}
        />
      ),
      onPress: () => pick({ kind: "agent", agent }),
    })),
    {
      key: "files",
      label: "File explorer",
      detail: "Browse a folder in a pane",
      icon: <Icon name="FolderTree" />,
      onPress: () => pick({ kind: "files" }),
    },
  ];

  const back: Partial<Record<LauncherStep, LauncherStep>> = {
    where: "choose",
    host: "where",
    folder: data.hosts.length === 1 ? "where" : "host",
  };
  const scrolls = step !== "choose" || rows.length > COMPACT_ROW_LIMIT;
  // The host step carries its own heading, so the bar only names what is being
  // placed; the folder browser has none of its own, so the bar is its heading.
  const placing =
    step === "where"
      ? `Where should ${pendingChoice ? choiceLabel(pendingChoice) : "it"} run?`
      : step === "host"
        ? (pendingChoice && choiceLabel(pendingChoice)) || "Choose a host"
        : step === "folder"
          ? pendingChoice
            ? `Folder for ${choiceLabel(pendingChoice)}`
            : "Choose a folder"
          : null;

  const menu = (
    <>
      <SheetHeader title="Add a window" />
      {rows.map((row) => (
        <DrawerRow
          detail={row.detail}
          disabled={busy}
          icon={row.icon}
          key={row.key}
          label={row.label}
          onPress={row.onPress}
          testID={`launcher-choice-${row.key}`}
        />
      ))}
    </>
  );

  const hostName = (id: string) => data.hosts.find((host) => host.id === id)?.name ?? "host";
  const whereList = (
    <SheetScrollView contentContainerStyle={styles.menuContent}>
      {places.map((place, index) => {
        const host = data.hosts.find((candidate) => candidate.id === place.hostId);
        return (
          <DrawerRow
            detail={`${hostName(place.hostId)} · ${place.online ? placeReasonLabel(place.reason) : "offline"}`}
            disabled={busy || !place.online || !host}
            icon={<StatusDot tone={place.online ? "active" : "offline"} />}
            key={`${place.hostId}:${place.cwd}`}
            label={displayPath(place.cwd)}
            onPress={() => {
              if (!host || !pendingChoice) return;
              haptics.selection();
              create(host, place.cwd, pendingChoice);
            }}
            testID={index === 0 ? "launcher-where-suggested" : `launcher-where-${index}`}
          />
        );
      })}
      <DrawerSeparator />
      <DrawerRow
        detail={data.hosts.length > 1 ? "Browse any host" : "Browse this host"}
        disabled={busy}
        icon={<Icon name="FolderOpen" />}
        label="Choose a folder…"
        onPress={browse}
        testID="launcher-where-browse"
      />
    </SheetScrollView>
  );

  return (
    <>
      <Sheet
        onDismiss={handleCancel}
        size={scrolls ? "tall" : "content"}
        testID="launcher-sheet"
        visible={visible}
      >
        {placing ? (
          <View style={[styles.stepBar, { borderBottomColor: theme.colors.border }]}>
            <IconButton
              accessibilityLabel="Go back"
              icon="ChevronLeft"
              onPress={() => {
                haptics.selection();
                setError(null);
                setStep(back[step] ?? "choose");
              }}
              size="sm"
            />
            <Text numberOfLines={1} style={styles.stepTitle} variant="label">
              {placing}
            </Text>
            <View style={styles.backPlaceholder} />
          </View>
        ) : null}

        {error ? (
          <View style={[styles.error, { backgroundColor: theme.colors.destructiveSoft }]}>
            <Text accessibilityRole="alert" color="destructive">
              {error}
            </Text>
          </View>
        ) : null}

        {data.error ? (
          <View style={styles.centered}>
            <Text color="destructive">Could not load the launcher.</Text>
            <Button onPress={() => void data.refetch()} variant="outline">
              Try again
            </Button>
          </View>
        ) : data.isLoading || !workspace ? (
          <View style={styles.centered}>
            <Spinner size={spacing[6]} />
            <Text color="mutedForeground">Loading…</Text>
          </View>
        ) : step === "choose" ? (
          scrolls ? (
            <SheetScrollView contentContainerStyle={styles.menuContent}>{menu}</SheetScrollView>
          ) : (
            <View>{menu}</View>
          )
        ) : step === "where" ? (
          whereList
        ) : step === "host" ? (
          <HostStep
            hosts={data.hosts}
            onSelect={(host) => {
              haptics.selection();
              gate.guard(host.id, () => {
                setPickerHost(host);
                setHostTransport(null);
                setHostTransportState("idle");
                setStep("folder");
              });
            }}
            selectedHostId={pickerHost?.id ?? null}
          />
        ) : step === "folder" ? (
          <FolderPicker
            initialPath={places.find((place) => place.hostId === pickerHost?.id)?.cwd ?? null}
            onSelect={(path) => {
              if (pickerHost && pendingChoice) create(pickerHost, path, pendingChoice);
            }}
            recentError={recents.error?.message ?? null}
            recentDirectories={recents.data}
            pathFlavor={pathFlavorForHostOS(pickerHost?.os)}
            transport={hostTransport}
            transportState={hostTransportState}
          />
        ) : recovery ? (
          <View style={styles.recovery}>
            <Text variant="title">The shell is running</Text>
            <Text color="mutedForeground">{recovery.message}</Text>
            <Button
              onPress={() => {
                void keepLaunchedShell(recovery.session.id)
                  .then(() => {
                    onLaunched({
                      session: recovery.session,
                      pendingCommand: false,
                      warning: recovery.message,
                    });
                    onDismiss();
                  })
                  .catch((cause) => {
                    const message =
                      cause instanceof Error
                        ? cause.message
                        : "Could not abandon the agent launch.";
                    setError(message);
                    onLaunchError?.(message, recovery.session.id);
                  });
              }}
              variant="outline"
            >
              Keep shell
            </Button>
            <Button
              onPress={() => {
                void discardLaunchedSession(recovery.session.id)
                  .then(onDismiss)
                  .catch((cause) => {
                    const message =
                      cause instanceof Error ? cause.message : "Could not remove the session.";
                    setError(message);
                    onLaunchError?.(message, recovery.session.id);
                  });
              }}
              variant="destructive"
            >
              Remove session
            </Button>
          </View>
        ) : null}

        {visible && step === "folder" && pickerHost?.host_public_key ? (
          <HostTransportSurface
            hostId={pickerHost.id}
            hostIdentityPublicKey={pickerHost.host_public_key}
            onError={(transportError) => setError(transportError.message)}
            onStateChange={setHostTransportState}
            onTransport={handleTransport}
          />
        ) : null}
      </Sheet>
      {gate.overlay}
      {updatePrompt ? (
        <HostUpdateDialog
          host={updatePrompt.host}
          onDismiss={() => setUpdatePrompt(null)}
          onNotNow={proceedPastUpdate}
          onUpdated={proceedPastUpdate}
          visible
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  stepBar: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  stepTitle: { flex: 1, textAlign: "center" },
  backPlaceholder: { height: spacing[9], width: spacing[9] },
  caption: { paddingBottom: spacing[2], paddingHorizontal: spacing[4] },
  menuContent: { paddingBottom: spacing[2] },
  error: { margin: spacing[4], padding: spacing[3] },
  centered: {
    alignItems: "center",
    gap: spacing[3],
    justifyContent: "center",
    padding: spacing[6],
  },
  recovery: { gap: spacing[4], justifyContent: "center", padding: spacing[6] },
});
