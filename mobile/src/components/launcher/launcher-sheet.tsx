import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { HostUpdateDialog } from "@/components/hosts/host-update-dialog";
import { hostNeedsUpdatePrompt } from "@/components/hosts/host-update-status";
import { FolderPicker } from "@/components/launcher/folder-picker";
import { pathBasename, pathFlavorForHostOS } from "@/components/launcher/folder-picker-logic";
import { HostStep } from "@/components/launcher/host-step";
import { type LaunchHome, resolveLaunchHome } from "@/components/launcher/launcher-selection";
import { useDeviceApprovalGate } from "@/components/trust/device-approval-gate";
import { Button } from "@/components/ui/button";
import { DrawerRow, DrawerSeparator } from "@/components/ui/drawer-row";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetHeader, SheetScrollView } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
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
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/** What the drawer is about to add: a shell, an agent in a shell, or a widget. */
type Choice = { kind: "shell" } | { kind: "agent"; agent: AgentOut } | { kind: "files" };

/**
 * "choose" is the whole flow whenever the tab has a home to open in. The two
 * picker steps exist for the workspace that has none, and for the explicit
 * "somewhere else" choice.
 */
type LauncherStep = "choose" | "host" | "folder" | "recovery";

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

function homeDetail(home: LaunchHome | null): string | null {
  if (!home) return null;
  if (home.host.status !== "online") return `${home.host.name} is offline — pick somewhere else`;
  return `Opens in ${pathBasename(home.cwd, pathFlavorForHostOS(home.host.os)) || home.cwd} on ${home.host.name}`;
}

/**
 * Adding a window: what to run, and nothing else.
 *
 * The tab's own home — or the workspace's, chosen when it was created — answers
 * where, so picking Claude Code *is* the whole flow: the shell is created on that
 * host, in that folder, in the tab the drawer was opened from, and the terminal
 * opens on it. The host and folder pickers below are the fallback for a workspace
 * with no home and for the deliberate "somewhere else", and both can be changed
 * again from the running window (`terminal-header`).
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
  /** The choice the pickers are completing; null when they are re-pointing the menu. */
  const [pendingChoice, setPendingChoice] = useState<Choice | null>(null);
  /** A location chosen through "somewhere else", standing in for the tab's home. */
  const [elsewhere, setElsewhere] = useState<LaunchHome | null>(null);
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
  const home = elsewhere ?? (workspace ? resolveLaunchHome(workspace, tabId, data.hosts) : null);
  const agents = useMemo(() => sortAgents(data.agents), [data.agents]);

  useEffect(() => {
    if (!visible) return;
    setStep("choose");
    setPendingChoice(null);
    setElsewhere(null);
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
   * Ask where. The folder browser answers that on its own, so there is no menu
   * of locations to step through — one host opens it straight away, several ask
   * which machine first.
   *
   * `target` is the choice waiting on an answer, and null is the "somewhere
   * else" row: that one re-points the menu rather than completing anything, so
   * the folder comes back as the home every choice above it then opens in.
   */
  const browse = (target: Choice | null) => {
    haptics.selection();
    setError(null);
    setPendingChoice(target);
    const only = data.hosts.length === 1 ? data.hosts[0] : null;
    if (only) {
      setPickerHost(only);
      setStep("folder");
      return;
    }
    setPickerHost(null);
    setStep("host");
  };

  // What goes in the window; then where it points, unless home answers that.
  const pick = (target: Choice) => {
    if (home && home.host.status === "online") {
      haptics.selection();
      create(home.host, home.cwd, target);
      return;
    }
    browse(target);
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
    host: "choose",
    folder: data.hosts.length === 1 ? "choose" : "host",
  };
  const scrolls = step !== "choose" || rows.length > COMPACT_ROW_LIMIT;
  // The host step carries its own heading, so the bar only names what is being
  // placed; the folder browser has none of its own, so the bar is its heading.
  const placing =
    step === "host"
      ? (pendingChoice && choiceLabel(pendingChoice)) || "Somewhere else"
      : step === "folder"
        ? pendingChoice
          ? `Folder for ${choiceLabel(pendingChoice)}`
          : "Choose a folder"
        : null;

  const menu = (
    <>
      <SheetHeader title="Add a window" />
      {home ? (
        <Text
          color={home.host.status === "online" ? "mutedForeground" : "warning"}
          style={styles.caption}
          variant="caption"
        >
          {homeDetail(home)}
        </Text>
      ) : null}
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
      {/* Home answers "where" for everything above, so a workspace with one
          needs this escape hatch to open on another host — or just another
          folder — without giving up the one-tap default. */}
      {home ? (
        <>
          <DrawerSeparator />
          <DrawerRow
            detail={data.hosts.length > 1 ? "Pick a host and folder first" : "Pick a folder first"}
            disabled={busy}
            icon={<Icon name={data.hosts.length > 1 ? "Server" : "FolderOpen"} />}
            label="Somewhere else"
            onPress={() => browse(null)}
            testID="launcher-choice-elsewhere"
          />
        </>
      ) : null}
    </>
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
            initialPath={pickerHost && home?.host.id === pickerHost.id ? home.cwd : null}
            onSelect={(path) => {
              if (!pickerHost) return;
              if (pendingChoice) {
                create(pickerHost, path, pendingChoice);
                return;
              }
              // "Somewhere else" only answered where; the menu asks what again,
              // now opening here instead of at the tab's home.
              haptics.selection();
              setElsewhere({ host: pickerHost, cwd: path });
              setStep("choose");
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
