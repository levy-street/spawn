import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";

import { ConnectionStateOverlay } from "@/components/terminal-ui/connection-status";
import { DiagnosticsSheet } from "@/components/terminal-ui/diagnostics-sheet";
import {
  type FollowState,
  INITIAL_FOLLOW_STATE,
  reduceFollowState,
  shouldShowJumpToLatest,
} from "@/components/terminal-ui/follow-state";
import { FontSizeSheet } from "@/components/terminal-ui/font-size-sheet";
import { JumpToLatest } from "@/components/terminal-ui/jump-to-latest";
import { ModifierBar } from "@/components/terminal-ui/modifier-bar";
import { TerminalSearchBar } from "@/components/terminal-ui/search-bar";
import { SelectionToolbar } from "@/components/terminal-ui/selection-toolbar";
import { TerminalHeader } from "@/components/terminal-ui/terminal-header";
import {
  useTerminalFontSizeGate,
  useTerminalKeepAwake,
} from "@/components/terminal-ui/terminal-lifecycle";
import { TerminalNotice } from "@/components/terminal-ui/terminal-notice";
import { UploadProgressBar } from "@/components/terminal-ui/upload-progress-bar";
import { useTerminalTransfers } from "@/components/terminal-ui/use-terminal-transfers";
import { Confirm } from "@/components/ui/confirm";
import { SwipeDismissOverlay } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import {
  attachPendingLaunchDelivery,
  type PendingLaunchDeliveryResult,
} from "@/data/queries/launcher";
import { DEFAULT_SESSION_UI, useSessionUiStore } from "@/data/stores/session-ui";
import { haptics } from "@/lib/haptics";
import { TerminalSurface, type TerminalSurfaceHandle } from "@/terminal/TerminalSurface";
import type {
  KeySpec,
  SessionTransport,
  TransportError,
  TransportState,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import { layer, useTheme } from "@/theme";

const INITIAL_TERMINAL_GRID = { cols: 80, rows: 24 } as const;

export interface TerminalOverlayProps {
  session: SessionOut;
  host: HostOut;
  focused: boolean;
  onDismiss: () => void;
  onRename: (name: string) => Promise<void>;
  onRestart: () => Promise<void>;
  onKill: () => Promise<void>;
}

function safeTerminalLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function pendingLaunchNotice(result: PendingLaunchDeliveryResult): string | null {
  if (result.status === "sent" || result.status === "missing") return null;
  if (result.status === "stale") {
    return "The saved agent launch expired. This session was left as a shell.";
  }
  if (result.status === "lost") {
    return "The saved agent launch could not be read safely. This session was left as a shell.";
  }
  if (result.reason === "session_dead") {
    return "The session ended before the agent command was ready. Nothing was sent.";
  }
  return "The agent command could not be delivered safely and was not retried.";
}

export function TerminalOverlay({
  session,
  host,
  focused,
  onDismiss,
  onRename,
  onRestart,
  onKill,
}: TerminalOverlayProps): React.JSX.Element {
  const theme = useTheme();
  const surfaceRef = useRef<TerminalSurfaceHandle>(null);
  const transportRef = useRef<SessionTransport | null>(null);
  const scrollUnsubscribeRef = useRef<(() => void) | null>(null);
  const pendingLaunchUnsubscribeRef = useRef<(() => void) | null>(null);
  const previousConnectionState = useRef<TransportState>("idle");
  const sessionUi = useSessionUiStore((state) => state.sessions[session.id]);
  const setStoredFollow = useSessionUiStore((state) => state.setFollow);
  const setStoredFontSize = useSessionUiStore((state) => state.setFontSize);
  const setLastKnownTitle = useSessionUiStore((state) => state.setLastKnownTitle);
  const fontSize = sessionUi?.fontSize ?? DEFAULT_SESSION_UI.fontSize;
  const lastKnownTitle = sessionUi?.lastKnownTitle ?? null;
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  const [connectionState, setConnectionState] = useState<TransportState>("idle");
  const [connectionError, setConnectionError] = useState<TransportError | null>(null);
  const [diagnostic, setDiagnostic] = useState<WorkerDiagnostic | null>(null);
  const [hasEverBeenReady, setHasEverBeenReady] = useState(false);
  const [followState, setFollowState] = useState<FollowState>(INITIAL_FOLLOW_STATE);
  const [searchVisible, setSearchVisible] = useState(false);
  const [fontSheetVisible, setFontSheetVisible] = useState(false);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);
  const [selectionVisible, setSelectionVisible] = useState(false);
  const [killConfirmVisible, setKillConfirmVisible] = useState(false);

  useTerminalKeepAwake(session.id, focused, connectionState);
  const changeFontSize = useTerminalFontSizeGate(
    surfaceRef,
    fontSize,
    theme.motion.duration.fast,
    (next) => setStoredFontSize(session.id, next),
  );

  useEffect(
    () => () => {
      scrollUnsubscribeRef.current?.();
      pendingLaunchUnsubscribeRef.current?.();
    },
    [],
  );

  const updateFollow = useCallback(
    (event: Parameters<typeof reduceFollowState>[1]): void => {
      setFollowState((current) => {
        const next = reduceFollowState(current, event);
        const follow = next.mode === "following";
        surfaceRef.current?.setFollow(follow);
        setStoredFollow(session.id, follow);
        return next;
      });
    },
    [session.id, setStoredFollow],
  );

  const transfers = useTerminalTransfers({
    transport: () => transportRef.current,
    ready: connectionState === "ready",
    onInputSent: () => updateFollow({ type: "input-sent" }),
  });

  const handleTransport = useCallback(
    (transport: SessionTransport): void => {
      scrollUnsubscribeRef.current?.();
      pendingLaunchUnsubscribeRef.current?.();
      transportRef.current = transport;
      scrollUnsubscribeRef.current = transport.on("scroll", (scroll) => {
        updateFollow({ type: "scroll", scroll });
        if (scroll.newOutputWhileAway) updateFollow({ type: "output-while-away" });
      });
      pendingLaunchUnsubscribeRef.current = attachPendingLaunchDelivery(transport, {
        initialSessionStatus: session.status,
        onResult: (result) => {
          if (result.status === "sent") updateFollow({ type: "input-sent" });
          const notice = pendingLaunchNotice(result);
          if (notice) transfers.setNotice(notice);
        },
      });
    },
    [session.status, transfers.setNotice, updateFollow],
  );

  const handleConnectionState = (next: TransportState): void => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = next;
    setConnectionState(next);
    if (next === "ready") {
      setHasEverBeenReady(true);
      setConnectionError(null);
      if (previous !== "ready") haptics.success();
    } else if (
      previous === "ready" &&
      (next === "reconnecting" || next === "failed" || next === "closed")
    ) {
      haptics.error();
    }
  };

  const retry = (): void => {
    scrollUnsubscribeRef.current?.();
    scrollUnsubscribeRef.current = null;
    pendingLaunchUnsubscribeRef.current?.();
    pendingLaunchUnsubscribeRef.current = null;
    transportRef.current = null;
    previousConnectionState.current = "idle";
    setConnectionState("idle");
    setConnectionError(null);
    setSurfaceGeneration((generation) => generation + 1);
  };

  const sendAccessoryKey = (sequence: string, _spec: KeySpec): void => {
    surfaceRef.current?.sendKey(sequence);
    updateFollow({ type: "input-sent" });
  };

  const jumpToLatest = (): void => {
    surfaceRef.current?.setFollow(true);
    surfaceRef.current?.scrollToBottom();
    updateFollow({ type: "jump-to-latest" });
  };

  const enterSelection = useCallback((): void => {
    setSelectionVisible(true);
    updateFollow({ type: "enter-selection" });
    haptics.selection();
  }, [updateFollow]);

  const leaveSelection = (): void => {
    setSelectionVisible(false);
    updateFollow({ type: "leave-selection" });
  };

  const copySelection = async (): Promise<void> => {
    const value = await surfaceRef.current?.copySelection();
    if (!value) {
      transfers.setNotice("No terminal text is selected.");
      return;
    }
    await Clipboard.setStringAsync(value);
    haptics.success();
    transfers.setNotice("Copied terminal selection.");
    leaveSelection();
  };

  const selectionGesture = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(theme.motion.duration.successHold)
        .onStart(() => scheduleOnRN(enterSelection)),
    [enterSelection, theme.motion.duration.successHold],
  );

  const title = session.name ?? lastKnownTitle ?? "Terminal";
  const hostKey = host.host_public_key;

  return (
    <SwipeDismissOverlay dragHandleRegion="header" onDismiss={onDismiss} visible>
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <TerminalHeader
          connectionState={connectionState}
          cwd={session.cwd}
          foregroundCommand={session.foreground_command}
          hostName={session.host_name ?? host.name}
          onCopyMode={enterSelection}
          onDiagnostics={() => setDiagnosticsVisible(true)}
          onDismiss={onDismiss}
          onFontSize={() => setFontSheetVisible(true)}
          onKill={() => setKillConfirmVisible(true)}
          onRename={async (name) => {
            try {
              await onRename(name);
            } catch (error) {
              transfers.setNotice(
                error instanceof Error ? error.message : "Session rename failed.",
              );
            }
          }}
          onRestart={() => {
            void onRestart()
              .then(() => {
                transfers.setNotice("Session restarted.");
                retry();
              })
              .catch((error: unknown) => {
                transfers.setNotice(
                  error instanceof Error ? error.message : "Session restart failed.",
                );
              });
          }}
          onSearch={() => setSearchVisible(true)}
          onUpload={() => void transfers.uploadFile()}
          title={title}
        />
        <TerminalSearchBar
          onDismiss={() => setSearchVisible(false)}
          onSearch={(query, direction) => surfaceRef.current?.search(query, direction)}
          visible={searchVisible}
        />
        <View style={[styles.surfaceFrame, { backgroundColor: theme.colors.terminalBg }]}>
          {hostKey ? (
            <GestureDetector gesture={selectionGesture}>
              <View style={styles.surface}>
                <TerminalSurface
                  fontSize={fontSize}
                  hostIdentityPublicKey={hostKey}
                  initialSize={INITIAL_TERMINAL_GRID}
                  key={`${session.id}-${surfaceGeneration}`}
                  onDiagnostic={setDiagnostic}
                  onError={(error) => {
                    setConnectionError(error);
                    if (!error.retryable) setConnectionState("failed");
                  }}
                  onLink={(url) => {
                    if (safeTerminalLink(url)) void Linking.openURL(url);
                    else transfers.setNotice("The terminal link uses an unsupported URL scheme.");
                  }}
                  onStateChange={handleConnectionState}
                  onTitleChange={(next) => setLastKnownTitle(session.id, next)}
                  onTransport={handleTransport}
                  ref={surfaceRef}
                  sessionId={session.id}
                />
              </View>
            </GestureDetector>
          ) : (
            <View style={[styles.unavailable, { gap: theme.space(2), padding: theme.space(6) }]}>
              <Text variant="label">Host identity unavailable</Text>
              <Text color="mutedForeground" style={styles.centered} variant="body">
                This host does not have a trusted identity key, so a secure terminal cannot open.
              </Text>
            </View>
          )}
          <UploadProgressBar ratio={transfers.progressRatio} />
          <ConnectionStateOverlay
            error={connectionError}
            hasEverBeenReady={hasEverBeenReady}
            onRetry={retry}
            state={hostKey ? connectionState : "failed"}
          />
          {shouldShowJumpToLatest(followState) ? (
            <View
              pointerEvents="box-none"
              style={[styles.jump, { bottom: theme.space(3), zIndex: layer.floatingChrome }]}
            >
              <JumpToLatest unread={followState.unread} onPress={jumpToLatest} />
            </View>
          ) : null}
          <View
            pointerEvents="box-none"
            style={[styles.selection, { top: theme.space(3), zIndex: layer.floatingChrome }]}
          >
            <SelectionToolbar
              onCancel={leaveSelection}
              onCopy={() => void copySelection()}
              visible={selectionVisible}
            />
          </View>
          <TerminalNotice message={transfers.notice} />
        </View>
        <ModifierBar
          disabled={connectionState !== "ready" || !hostKey}
          onDismissKeyboard={() => surfaceRef.current?.blur()}
          onPaste={() => void transfers.paste()}
          onSend={sendAccessoryKey}
          sessionId={session.id}
        />
        <FontSizeSheet
          onChange={changeFontSize}
          onDismiss={() => setFontSheetVisible(false)}
          value={fontSize}
          visible={fontSheetVisible}
        />
        <DiagnosticsSheet
          diagnostic={diagnostic}
          error={connectionError}
          onDismiss={() => setDiagnosticsVisible(false)}
          state={connectionState}
          visible={diagnosticsVisible}
        />
        <Confirm
          cancelLabel="Keep session"
          confirmLabel="Kill session"
          description="This stops the running process and removes the session."
          destructive
          onCancel={() => setKillConfirmVisible(false)}
          onConfirm={() => {
            setKillConfirmVisible(false);
            void onKill()
              .then(onDismiss)
              .catch((error: unknown) => {
                transfers.setNotice(
                  error instanceof Error ? error.message : "Session could not be killed.",
                );
              });
          }}
          title="Kill this session?"
          visible={killConfirmVisible}
        />
      </View>
    </SwipeDismissOverlay>
  );
}

const styles = StyleSheet.create({
  centered: {
    textAlign: "center",
  },
  jump: {
    alignItems: "center",
    left: 0,
    position: "absolute",
    right: 0,
  },
  root: {
    flex: 1,
  },
  selection: {
    alignItems: "center",
    left: 0,
    position: "absolute",
    right: 0,
  },
  surface: {
    flex: 1,
  },
  surfaceFrame: {
    flex: 1,
    overflow: "hidden",
    position: "relative",
  },
  unavailable: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
});
