import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AgentRestartResult } from "@/components/launcher/agent-restart";
import type { ShellCommandSink } from "@/components/launcher/shell-handoff";
import { TerminalAccessoryBar } from "@/components/terminal-ui/accessory-bar";
import { AttachmentSheet } from "@/components/terminal-ui/attachment-sheet";
import { ConnectionStateOverlay } from "@/components/terminal-ui/connection-status";
import { DiagnosticsSheet } from "@/components/terminal-ui/diagnostics-sheet";
import { DisplayControlBar } from "@/components/terminal-ui/display-control-bar";
import {
  type FollowState,
  INITIAL_FOLLOW_STATE,
  reduceFollowState,
  shouldShowJumpToLatest,
} from "@/components/terminal-ui/follow-state";
import { FontSizeSheet } from "@/components/terminal-ui/font-size-sheet";
import { JumpToLatest } from "@/components/terminal-ui/jump-to-latest";
import { useTerminalKeyboardHold } from "@/components/terminal-ui/keyboard-hold";
import { useLaunchAutoFocus } from "@/components/terminal-ui/launch-focus";
import { usePinnedCommands } from "@/components/terminal-ui/pinned-commands";
import { TerminalSearchBar } from "@/components/terminal-ui/search-bar";
import { SelectionToolbar } from "@/components/terminal-ui/selection-toolbar";
import { SessionTargetSheets } from "@/components/terminal-ui/session-target-sheets";
import {
  agentKindFor,
  REPEAT_PRESS_GAP_MS,
  resolvePinnedCommands,
  type TerminalCommand,
} from "@/components/terminal-ui/terminal-commands";
import { TerminalCommandsSheet } from "@/components/terminal-ui/terminal-commands-sheet";
import { TerminalHeader } from "@/components/terminal-ui/terminal-header";
import {
  useTerminalFontSizeGate,
  useTerminalKeepAwake,
} from "@/components/terminal-ui/terminal-lifecycle";
import { TerminalNotice } from "@/components/terminal-ui/terminal-notice";
import { UploadProgressBar } from "@/components/terminal-ui/upload-progress-bar";
import { useTerminalTransfers } from "@/components/terminal-ui/use-terminal-transfers";
import { DeviceApprovalOverlay } from "@/components/trust/device-approval-overlay";
import { Confirm } from "@/components/ui/confirm";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import {
  attachPendingLaunchDelivery,
  type PendingLaunchDeliveryResult,
} from "@/data/queries/launcher";
import { identifyAgent } from "@/data/selectors/agent";
import { DEFAULT_SESSION_UI, useSessionUiStore } from "@/data/stores/session-ui";
import { DEVICE_NOT_TRUSTED_CODE, invalidateDeviceHostTrust } from "@/data/trust/device-trust";
import { useHostApprovalWatch } from "@/data/trust/use-host-approval-watch";
import { haptics } from "@/lib/haptics";
import { encodeKey } from "@/terminal/key-encoder";
import { TerminalSurface, type TerminalSurfaceHandle } from "@/terminal/TerminalSurface";
import type {
  AgentNotice,
  ConnectionInfo,
  DisplayControlState,
  KeySpec,
  SessionTransport,
  TransportError,
  TransportState,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import { layer, useTheme } from "@/theme";
import { bottomNavHeight } from "@/theme/sizing";

const INITIAL_TERMINAL_GRID = { cols: 80, rows: 24 } as const;

export interface TerminalOverlayProps {
  session: SessionOut;
  host: HostOut;
  focused: boolean;
  onDismiss: () => void;
  onRename: (name: string) => Promise<void>;
  /** Restart the window as what it was opened as, given the terminal's own
   *  keyboard so an agent can be relaunched in the shell it already has. */
  onRestart: (terminal: ShellCommandSink) => Promise<AgentRestartResult>;
  /** What restarting brings back, for the menu row. */
  restartDetail?: string;
  /** Reports its own outcome and must not reject: the window is already gone. */
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
  restartDetail,
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
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [hasEverBeenReady, setHasEverBeenReady] = useState(false);
  const [followState, setFollowState] = useState<FollowState>(INITIAL_FOLLOW_STATE);
  const [searchVisible, setSearchVisible] = useState(false);
  const [fontSheetVisible, setFontSheetVisible] = useState(false);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);
  const [selectionVisible, setSelectionVisible] = useState(false);
  const [killConfirmVisible, setKillConfirmVisible] = useState(false);
  const [approvalVisible, setApprovalVisible] = useState(false);
  const [attachVisible, setAttachVisible] = useState(false);
  const [moreVisible, setMoreVisible] = useState(false);
  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [folderVisible, setFolderVisible] = useState(false);
  const [agentVisible, setAgentVisible] = useState(false);

  // Which key list this session gets, and which of those keys ride above the
  // keyboard. Read from the foreground command rather than from the agent
  // registry: a terminal must know what it is talking to without a round trip.
  const agentKind = agentKindFor(session.foreground_command);
  const updatedAgentName = identifyAgent(session.foreground_command, []).displayName;
  const { pinned, toggle: togglePinned } = usePinnedCommands(agentKind);
  const pinnedCommands = useMemo(
    () => resolvePinnedCommands(agentKind, pinned),
    [agentKind, pinned],
  );
  const repeatTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Every drawer this screen can raise. The keyboard is taller than most of
  // them, so it stands down while one is open and comes back afterwards. The
  // search field and the rename dialog are deliberately absent: those two ask
  // for the keyboard themselves.
  const drawerOpen =
    attachVisible ||
    moreVisible ||
    headerMenuVisible ||
    fontSheetVisible ||
    diagnosticsVisible ||
    folderVisible ||
    agentVisible ||
    killConfirmVisible;
  useTerminalKeyboardHold({
    held: drawerOpen,
    onHold: () => surfaceRef.current?.blur(),
    onRelease: () => surfaceRef.current?.focus(),
  });

  // A session created on an agent opens to be typed into, so the keyboard comes
  // up by itself once the agent command has actually gone out.
  const armLaunchFocus = useLaunchAutoFocus({
    focused,
    held: drawerOpen,
    onFocus: () => surfaceRef.current?.focus(),
  });
  const [display, setDisplay] = useState<DisplayControlState | null>(null);
  // What the agent's own status bar is saying, read off the live screen by
  // the worker. The one notice so far asks for a restart, which is offered
  // right on it.
  const [agentNotice, setAgentNotice] = useState<AgentNotice | null>(null);
  const [restarting, setRestarting] = useState(false);

  // The bottom nav is portalled to window level and nothing holds its footprint
  // open, so the terminal reserves it — and drops that reservation the moment
  // the keyboard covers the bar, which is when the phantom gap under the key row
  // used to appear.
  const insets = useSafeAreaInsets();
  const keyboard = useReanimatedKeyboardAnimation();
  const restingInset = bottomNavHeight(insets.bottom);
  const bottomInset = useAnimatedStyle(
    () => ({ paddingBottom: Math.max(-keyboard.height.value, restingInset) }),
    [keyboard.height, restingInset],
  );

  useTerminalKeepAwake(session.id, focused, connectionState);
  const changeFontSize = useTerminalFontSizeGate(
    surfaceRef,
    fontSize,
    theme.motion.duration.fast,
    (next) => setStoredFontSize(session.id, next),
  );

  useEffect(() => {
    const timers = repeatTimers.current;
    return () => {
      scrollUnsubscribeRef.current?.();
      pendingLaunchUnsubscribeRef.current?.();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const updateFollow = useCallback((event: Parameters<typeof reduceFollowState>[1]): void => {
    setFollowState((current) => reduceFollowState(current, event));
  }, []);

  // The surface and the store follow the state; they are not driven from
  // inside the updater above.
  //
  // A state updater has to be pure — React is free to call it during a render,
  // and twice in development — so writing to a store from in there updates one
  // component while another is rendering. That is the
  // "Cannot update a component (`%s`) while rendering a different component"
  // warning, and it showed up as soon as anyone tapped through the approval
  // sheet quickly enough to re-render mid-update.
  useEffect(() => {
    const follow = followState.mode === "following";
    surfaceRef.current?.setFollow(follow);
    setStoredFollow(session.id, follow);
  }, [followState.mode, session.id, setStoredFollow]);

  const transfers = useTerminalTransfers({
    transport: () => transportRef.current,
    ready: connectionState === "ready",
    onInputSent: () => updateFollow({ type: "input-sent" }),
    onFocusTerminal: () => surfaceRef.current?.focus(),
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
          if (result.status === "sent") {
            updateFollow({ type: "input-sent" });
            armLaunchFocus();
          }
          const notice = pendingLaunchNotice(result);
          if (notice) transfers.setNotice(notice);
        },
      });
    },
    [armLaunchFocus, session.status, transfers.setNotice, updateFollow],
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

  const retry = useCallback((): void => {
    // Retry means "something may have changed since last time", and the thing
    // most likely to have changed is an approval granted on another device.
    invalidateDeviceHostTrust(host.id);
    scrollUnsubscribeRef.current?.();
    scrollUnsubscribeRef.current = null;
    pendingLaunchUnsubscribeRef.current?.();
    pendingLaunchUnsubscribeRef.current = null;
    transportRef.current = null;
    previousConnectionState.current = "idle";
    setConnectionState("idle");
    setConnectionError(null);
    setSurfaceGeneration((generation) => generation + 1);
  }, [host.id]);

  // Approval is granted somewhere else entirely, so the phone watches for it
  // and reconnects itself. Making the operator walk back here and press Retry
  // is the part of this that used to feel broken.
  //
  // The watch latches, because the trust code is not the last word the
  // transport says: a refused connection goes on to fail plainly ("transport is
  // in a failed state"), and reading only the newest error called the watch off
  // mid-approval — the ceremony finished, and the terminal sat on a Retry
  // button nobody should have had to press.
  const trustRefusal =
    connectionState === "failed" && connectionError?.code === DEVICE_NOT_TRUSTED_CODE;
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  useEffect(() => {
    if (trustRefusal) setAwaitingApproval(true);
  }, [trustRefusal]);
  useEffect(() => {
    // Connected: whatever the refusal was, it is over.
    if (connectionState === "ready") setAwaitingApproval(false);
  }, [connectionState]);
  const hostApproval = useHostApprovalWatch(host.id, awaitingApproval);
  useEffect(() => {
    if (!awaitingApproval || hostApproval !== "trusted") return;
    // Handled: drop the latch first so the watch stops and this cannot loop on
    // a connection that fails again for some other reason.
    setAwaitingApproval(false);
    retry();
  }, [awaitingApproval, hostApproval, retry]);

  // The ceremony presents itself: a trust failure is not something Retry can
  // fix, so waiting for the operator to find the right button is a dead end.
  // It closes itself a beat after the approval lands (the sheet's own dwell) —
  // dismissing it early keeps it closed for this failure, and the error
  // screen's "Approve this device" reopens it.
  useEffect(() => {
    if (trustRefusal) setApprovalVisible(true);
  }, [trustRefusal]);

  const sendAccessoryKey = (sequence: string, _spec: KeySpec): void => {
    surfaceRef.current?.sendKey(sequence);
    updateFollow({ type: "input-sent" });
  };

  /**
   * One pinned or drawer key. A command asking for more than one press sends them
   * apart rather than as one packet: the double Escape that rewinds Claude Code
   * and Codex is two presses to their input readers, and two escapes arriving
   * together read as a single modified key instead.
   */
  const runCommand = (command: TerminalCommand): void => {
    const sequence = encodeKey(command.spec);
    if (sequence.length === 0) {
      haptics.warning();
      return;
    }
    sendAccessoryKey(sequence, command.spec);
    for (let press = 1; press < (command.presses ?? 1); press += 1) {
      const timer = setTimeout(() => {
        repeatTimers.current.delete(timer);
        sendAccessoryKey(sequence, command.spec);
      }, press * REPEAT_PRESS_GAP_MS);
      repeatTimers.current.add(timer);
    }
  };

  /**
   * What "change folder" and "change agent" type into. The command goes through
   * this window's own keyboard path — the same one a pinned key uses — so
   * nothing is ever run out of sight of the person watching the terminal.
   */
  const terminalSink = useMemo<ShellCommandSink>(
    () => ({
      sendInput: (data: string) => {
        surfaceRef.current?.sendKey(data);
        updateFollow({ type: "input-sent" });
      },
      focus: () => surfaceRef.current?.focus(),
    }),
    [updateFollow],
  );

  /**
   * The one restart, from the menu or the agent's own notice: an agent window
   * comes back into its conversation, typed into the shell it already has
   * when that works — nothing to reconnect — and a fresh shell otherwise,
   * which the transport has to be reopened for.
   */
  const restartFromHere = (): void => {
    if (restarting) return;
    setRestarting(true);
    void onRestart(terminalSink)
      .then((result) => {
        const agent = result.plan.kind === "agent" ? result.plan.agent.name : null;
        if (result.kind === "resumed") {
          transfers.setNotice(`${agent} restarted.`);
          return;
        }
        transfers.setNotice(
          agent
            ? `Session restarted. ${agent} starts when the shell is back.`
            : "Session restarted.",
        );
        retry();
      })
      .catch((error: unknown) => {
        transfers.setNotice(error instanceof Error ? error.message : "Session restart failed.");
      })
      .finally(() => setRestarting(false));
  };

  const takeDisplayControl = (): void => {
    surfaceRef.current?.takeControl();
    setDisplay((current) => (current === null ? current : { ...current, owner: true }));
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

  /**
   * Output must not scroll out from under a live selection: iOS puts its handles
   * on a position in the document, and anything arriving underneath would drag
   * the text away from them. Follow resumes the moment the selection is dropped.
   */
  const onNativeSelection = useCallback(
    (active: boolean): void => {
      updateFollow({ type: active ? "enter-selection" : "leave-selection" });
    },
    [updateFollow],
  );

  const title = session.name ?? lastKnownTitle ?? "Terminal";
  const hostKey = host.host_public_key;

  return (
    <Animated.View
      style={[styles.root, { backgroundColor: theme.colors.background }, bottomInset]}
      testID="terminal-overlay-route-scene"
    >
      <TerminalHeader
        connectionInfo={connectionInfo}
        cwd={session.cwd}
        foregroundCommand={session.foreground_command}
        hostName={session.host_name ?? host.name}
        onBack={onDismiss}
        onChangeFolder={() => setFolderVisible(true)}
        onCopyMode={enterSelection}
        onDiagnostics={() => setDiagnosticsVisible(true)}
        onFontSize={() => setFontSheetVisible(true)}
        onKill={() => setKillConfirmVisible(true)}
        onMenuVisibilityChange={setHeaderMenuVisible}
        onRename={async (name) => {
          try {
            await onRename(name);
          } catch (error) {
            transfers.setNotice(error instanceof Error ? error.message : "Session rename failed.");
          }
        }}
        onRestart={restartFromHere}
        {...(restartDetail ? { restartDetail } : {})}
        onSearch={() => setSearchVisible(true)}
        onSwitchAgent={() => setAgentVisible(true)}
        onUpload={() => setAttachVisible(true)}
        title={title}
      />
      <TerminalSearchBar
        onDismiss={() => setSearchVisible(false)}
        onSearch={(query, direction) => surfaceRef.current?.search(query, direction)}
        visible={searchVisible}
      />
      <DisplayControlBar display={display} onTakeControl={takeDisplayControl} />
      <View style={[styles.surfaceFrame, { backgroundColor: theme.colors.terminalBg }]}>
        {hostKey ? (
          // Nothing wraps the surface in a gesture any more. A long press has to
          // reach the web view for the system to answer it with its own selection
          // handles and Copy/Look Up menu; a recogniser out here swallowed it.
          <View style={styles.surface}>
            <TerminalSurface
              fontSize={fontSize}
              hostId={host.id}
              hostIdentityPublicKey={hostKey}
              initialSize={INITIAL_TERMINAL_GRID}
              key={`${session.id}-${surfaceGeneration}`}
              onDiagnostic={setDiagnostic}
              onConnectionInfo={setConnectionInfo}
              onDisplayChange={setDisplay}
              onError={(error) => {
                setConnectionError(error);
                if (!error.retryable) setConnectionState("failed");
              }}
              onLink={(url) => {
                if (safeTerminalLink(url)) void Linking.openURL(url);
                else transfers.setNotice("The terminal link uses an unsupported URL scheme.");
              }}
              onAgentNotice={setAgentNotice}
              onNativeSelection={onNativeSelection}
              onStateChange={handleConnectionState}
              onTitleChange={(next) => setLastKnownTitle(session.id, next)}
              onTransport={handleTransport}
              ref={surfaceRef}
              sessionId={session.id}
            />
          </View>
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
          awaitingApproval={awaitingApproval}
          error={connectionError}
          hasEverBeenReady={hasEverBeenReady}
          sharedConnectionReady={transportRef.current?.daemonState === "ready"}
          sharedConnectionUnavailable={
            transportRef.current?.daemonState !== undefined &&
            transportRef.current.daemonState !== "ready"
          }
          onDeviceTrust={() => setApprovalVisible(true)}
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
        {agentNotice === "update_installed" && session.status === "running" ? (
          <TerminalNotice
            action={{
              label: restarting ? "Restarting…" : `Restart ${updatedAgentName}`,
              disabled: restarting,
              onPress: restartFromHere,
            }}
            message={`${updatedAgentName} installed an update.`}
          />
        ) : (
          <TerminalNotice message={transfers.notice} />
        )}
      </View>
      <TerminalAccessoryBar
        commands={pinnedCommands}
        disabled={connectionState !== "ready" || !hostKey}
        onAttach={() => setAttachVisible(true)}
        onCommand={runCommand}
        onDismissKeyboard={() => surfaceRef.current?.blur()}
        onMore={() => setMoreVisible(true)}
        onSend={sendAccessoryKey}
      />
      <TerminalCommandsSheet
        kind={agentKind}
        onCommand={runCommand}
        onDismiss={() => setMoreVisible(false)}
        onTogglePin={togglePinned}
        pinned={pinned}
        visible={moreVisible}
      />
      <AttachmentSheet
        onAttach={(source) => void transfers.attach(source)}
        onDismiss={() => setAttachVisible(false)}
        onPaste={() => void transfers.paste()}
        visible={attachVisible}
      />
      <FontSizeSheet
        onChange={changeFontSize}
        onDismiss={() => setFontSheetVisible(false)}
        value={fontSize}
        visible={fontSheetVisible}
      />
      <DiagnosticsSheet
        connectionInfo={connectionInfo}
        diagnostic={diagnostic}
        error={connectionError}
        onDismiss={() => setDiagnosticsVisible(false)}
        state={connectionState}
        visible={diagnosticsVisible}
      />
      <DeviceApprovalOverlay
        hostId={host.id}
        onDismiss={() => setApprovalVisible(false)}
        visible={approvalVisible}
      />
      <SessionTargetSheets
        agentVisible={agentVisible}
        folderVisible={folderVisible}
        host={host}
        onDismissAgent={() => setAgentVisible(false)}
        onDismissFolder={() => setFolderVisible(false)}
        onNotice={transfers.setNotice}
        session={session}
        terminal={terminalSink}
      />
      <Confirm
        cancelLabel="Keep session"
        confirmLabel="Kill session"
        description="This stops the running process and removes the session."
        destructive
        onCancel={() => setKillConfirmVisible(false)}
        onConfirm={() => {
          setKillConfirmVisible(false);
          // The window closes on the way out rather than on the answer. There
          // is nothing here worth looking at once the kill has been asked for,
          // and a request that hangs or fails used to leave the operator
          // stranded over a terminal they had just told the app to destroy —
          // the outcome is reported by a toast that outlives this screen.
          onDismiss();
          void onKill();
        }}
        title="Kill this session?"
        visible={killConfirmVisible}
      />
    </Animated.View>
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
