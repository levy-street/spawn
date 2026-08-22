import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { DetailsStep } from "@/components/launcher/details-step";
import { FolderPicker } from "@/components/launcher/folder-picker";
import { HostStep } from "@/components/launcher/host-step";
import {
  firstAvailableTabId,
  resolveInitialDirectory,
} from "@/components/launcher/launcher-selection";
import { type RunChoice, RunStep } from "@/components/launcher/run-step";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import {
  discardLaunchedSession,
  keepLaunchedShell,
  useLauncherData,
  useLaunchSession,
  useRecentDirectories,
} from "@/data/queries/launcher";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { borderWidth, spacing, useTheme } from "@/theme";

type LauncherStep = "host" | "folder" | "run" | "details" | "recovery";

export interface LauncherCompletion {
  session: SessionOut;
  pendingCommand: boolean;
  warning?: string;
}

export interface LauncherSheetProps {
  initialTabId?: string | null;
  onDismiss(): void;
  onLaunchError?(message: string, sessionId?: string): void;
  onLaunched(completion: LauncherCompletion): void;
  visible: boolean;
  workspaceId: string;
}

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
  const cancelRequested = useRef(false);
  const [step, setStep] = useState<LauncherStep>("host");
  const [selectedHost, setSelectedHost] = useState<HostOut | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [runChoice, setRunChoice] = useState<RunChoice | null>(null);
  const [name, setName] = useState("");
  const [tabId, setTabId] = useState("");
  const [hostTransport, setHostTransport] = useState<HostTransport | null>(null);
  const [hostTransportState, setHostTransportState] = useState<TransportState>("idle");
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{
    session: SessionOut;
    message: string;
  } | null>(null);
  const recents = useRecentDirectories(selectedHost?.id ?? null, visible && step === "folder");

  useEffect(() => {
    if (!visible) return;
    setStep("host");
    setSelectedHost(null);
    setFolder(null);
    setRunChoice(null);
    setName("");
    setTabId("");
    setHostTransport(null);
    setHostTransportState("idle");
    setIsCancelling(false);
    setError(null);
    setRecovery(null);
    cancelRequested.current = false;
  }, [visible]);

  useEffect(() => {
    if (!data.workspace || tabId) return;
    setTabId(firstAvailableTabId(data.workspace, initialTabId) ?? "");
  }, [data.workspace, initialTabId, tabId]);

  const moveTo = (next: LauncherStep) => {
    haptics.selection();
    setError(null);
    setStep(next);
  };

  const handleCancel = () => {
    if (launch.isPending) {
      cancelRequested.current = true;
      setIsCancelling(true);
      return;
    }
    onDismiss();
  };

  const handleTransport = useCallback((transport: HostTransport) => {
    setHostTransport(transport);
  }, []);

  const handleLaunch = async () => {
    if (!data.workspace || !selectedHost || !folder || !runChoice || !tabId) return;
    setError(null);
    try {
      const result = await launch.mutateAsync({
        workspaceId,
        tabId,
        hostId: selectedHost.id,
        cwd: folder,
        name,
        ...(runChoice.kind === "agent" ? { agent: runChoice.agent } : {}),
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

  const stepTitle: Record<LauncherStep, string> = {
    host: "New session",
    folder: selectedHost?.name ?? "Choose folder",
    run: "New session",
    details: "New session",
    recovery: "Launch incomplete",
  };
  const previousStep: Partial<Record<LauncherStep, LauncherStep>> = {
    folder: "host",
    run: "folder",
    details: "run",
  };
  const initialFolder =
    data.workspace && selectedHost
      ? resolveInitialDirectory(data.workspace, tabId, selectedHost.id)
      : null;

  return (
    <Sheet
      contentStyle={styles.sheetContent}
      initialSnapIndex={1}
      onDismiss={handleCancel}
      testID="launcher-sheet"
      visible={visible}
    >
      <SheetHeader
        action={
          <Button disabled={isCancelling} onPress={handleCancel} size="sm" variant="ghost">
            {isCancelling ? "Cancelling…" : "Cancel"}
          </Button>
        }
        title={stepTitle[step]}
      />
      <View style={[styles.stepBar, { borderBottomColor: theme.colors.border }]}>
        {previousStep[step] ? (
          <IconButton
            accessibilityLabel="Go back"
            icon="ChevronLeft"
            onPress={() => moveTo(previousStep[step] ?? "host")}
            size="sm"
          />
        ) : (
          <View style={styles.backPlaceholder} />
        )}
        <Text color="mutedForeground" variant="caption">
          {step === "recovery"
            ? "Action needed"
            : `Step ${["host", "folder", "run", "details"].indexOf(step) + 1} of 4`}
        </Text>
      </View>

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
      ) : data.isLoading || !data.workspace ? (
        <View style={styles.centered}>
          <Spinner size={spacing[6]} />
          <Text color="mutedForeground">Loading launcher…</Text>
        </View>
      ) : step === "host" ? (
        <HostStep
          hosts={data.hosts}
          onSelect={(host) => {
            setSelectedHost(host);
            setFolder(null);
            setHostTransport(null);
            setHostTransportState("idle");
            moveTo("folder");
          }}
          selectedHostId={selectedHost?.id ?? null}
        />
      ) : step === "folder" ? (
        <FolderPicker
          initialPath={folder ?? initialFolder}
          onSelect={(path) => {
            setFolder(path);
            setHostTransport(null);
            setHostTransportState("idle");
            moveTo("run");
          }}
          recentError={recents.error?.message ?? null}
          recentDirectories={recents.data}
          transport={hostTransport}
          transportState={hostTransportState}
        />
      ) : step === "run" ? (
        <RunStep
          agents={data.agents}
          onSelect={(choice) => {
            setRunChoice(choice);
            moveTo("details");
          }}
          selected={runChoice}
        />
      ) : step === "details" ? (
        <DetailsStep
          isLaunching={launch.isPending}
          name={name}
          onLaunch={() => void handleLaunch()}
          onNameChange={setName}
          onSelectTab={(nextTabId) => {
            haptics.selection();
            setTabId(nextTabId);
          }}
          selectedTabId={tabId}
          workspace={data.workspace}
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
                    cause instanceof Error ? cause.message : "Could not abandon the agent launch.";
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

      {visible && step === "folder" && selectedHost?.host_public_key ? (
        <HostTransportSurface
          hostId={selectedHost.id}
          hostIdentityPublicKey={selectedHost.host_public_key}
          onError={(transportError) => setError(transportError.message)}
          onStateChange={setHostTransportState}
          onTransport={handleTransport}
        />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sheetContent: { flex: 1 },
  stepBar: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  backPlaceholder: { height: spacing[9], width: spacing[9] },
  error: { margin: spacing[4], padding: spacing[3] },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: spacing[3],
    justifyContent: "center",
    padding: spacing[6],
  },
  recovery: { flex: 1, gap: spacing[4], justifyContent: "center", padding: spacing[6] },
});
