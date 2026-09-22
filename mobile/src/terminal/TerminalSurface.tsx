import * as Clipboard from "expo-clipboard";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  AppState,
  Image,
  Keyboard,
  type StyleProp,
  StyleSheet,
  type ViewStyle,
} from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { createKeyboardFitGate } from "@/components/terminal-ui/keyboard-fit-gate";
import { subscribeRetirementReason } from "@/data/realtime/lifecycle";
import { deviceIdentityGeneration, subscribeDeviceIdentityAccount } from "@/lib/crypto/identity";
import {
  BridgeProtocolError,
  TERMINAL_BRIDGE_VERSION,
  WorkerBridge,
  type WorkerToNativeMessage,
} from "@/terminal/transport/bridge";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-codec";
import { createSessionTransport } from "@/terminal/transport/session-transport";
import type {
  AgentNotice,
  ConnectionInfo,
  DisplayControlState,
  SessionTransport,
  SessionTransportOptions,
  TransportError,
  TransportState,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import { isWorkerBootstrapNavigation, WORKER_BASE_URL } from "@/terminal/worker/navigation-policy";
import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";
import { useTheme } from "@/theme";
import terminalWorkerAsset from "../../assets/terminal/worker.html";

// Switch this to true if inline HTML is not a secure WebRTC context on the target WKWebView.
// A future third fallback is serving this immutable asset from the spawn HTTPS origin.
const USE_FILE_WORKER_FALLBACK = false;

export interface TerminalSurfaceHandle {
  focus(): void;
  blur(): void;
  sendKey(seq: string): void;
  scrollToBottom(): void;
  setFollow(follow: boolean): void;
  setFontSize(px: number): void;
  copySelection(): Promise<string | null>;
  search(q: string, dir: "next" | "prev"): void;
  takeControl(): void;
}

export interface TerminalSurfaceProps extends Omit<SessionTransportOptions, "bridge" | "theme"> {
  style?: StyleProp<ViewStyle>;
  onTransport?(transport: SessionTransport): void;
  onStateChange?(state: TransportState): void;
  onError?(error: TransportError): void;
  onDiagnostic?(diagnostic: WorkerDiagnostic): void;
  onTitleChange?(title: string): void;
  onDisplayChange?(display: DisplayControlState): void;
  onConnectionInfo?(info: ConnectionInfo): void;
  onBell?(): void;
  /** The agent's own status bar notice, read off the rendered screen. */
  onAgentNotice?(notice: AgentNotice | null): void;
  onLink?(url: string): void;
  /** The system has, or no longer has, text selected in the terminal. */
  onNativeSelection?(active: boolean): void;
  onContentProcessTerminated?(): void;
}

interface SelectionWaiter {
  resolve(value: string | null): void;
  timer: ReturnType<typeof setTimeout>;
}

export const TerminalSurface = forwardRef<TerminalSurfaceHandle, TerminalSurfaceProps>(
  function TerminalSurface(props, ref) {
    const generation = useSyncExternalStore(
      subscribeDeviceIdentityAccount,
      deviceIdentityGeneration,
      deviceIdentityGeneration,
    );
    return <TerminalSurfaceInstance key={generation} {...props} ref={ref} />;
  },
);

const TerminalSurfaceInstance = forwardRef<TerminalSurfaceHandle, TerminalSurfaceProps>(
  function TerminalSurface(
    {
      sessionId,
      hostIdentityPublicKey,
      initialSize,
      fontSize,
      hostId,
      style,
      onTransport,
      onStateChange,
      onError,
      onDiagnostic,
      onTitleChange,
      onDisplayChange,
      onConnectionInfo,
      onBell,
      onLink,
      onNativeSelection,
      onAgentNotice,
      onContentProcessTerminated,
    },
    ref,
  ) {
    const theme = useTheme();
    const webViewRef = useRef<WebView>(null);
    const bridge = useMemo(() => new WorkerBridge(), []);
    const initialTheme = useRef(theme.terminal);
    const workerLoaded = useRef(false);
    const retiredForBackground = useRef(false);
    const selectionSequence = useRef(0);
    const selectionWaiters = useRef(new Map<string, SelectionWaiter>());
    const callbacks = useRef({
      onTransport,
      onStateChange,
      onError,
      onDiagnostic,
      onTitleChange,
      onDisplayChange,
      onConnectionInfo,
      onBell,
      onLink,
      onNativeSelection,
      onAgentNotice,
      onContentProcessTerminated,
    });
    callbacks.current = {
      onTransport,
      onStateChange,
      onError,
      onDiagnostic,
      onTitleChange,
      onDisplayChange,
      onConnectionInfo,
      onBell,
      onLink,
      onNativeSelection,
      onAgentNotice,
      onContentProcessTerminated,
    };

    const transport = useMemo(
      () =>
        createSessionTransport({
          sessionId,
          hostIdentityPublicKey,
          initialSize: { cols: initialSize.cols, rows: initialSize.rows },
          theme: initialTheme.current,
          bridge,
          ...(fontSize === undefined ? {} : { fontSize }),
          ...(hostId === undefined ? {} : { hostId }),
        }),
      [
        bridge,
        fontSize,
        hostId,
        hostIdentityPublicKey,
        initialSize.cols,
        initialSize.rows,
        sessionId,
      ],
    );

    const send = useCallback(
      (message: Parameters<WorkerBridge["send"]>[0]): void => {
        try {
          bridge.send(message);
        } catch (error) {
          callbacks.current.onError?.({
            code: "worker_bridge",
            message: error instanceof Error ? error.message : "Terminal worker bridge failed.",
            retryable: true,
          });
        }
      },
      [bridge],
    );

    // The worker refits itself off a ResizeObserver, which is the authority on
    // its own frame. This gate exists for the one thing the observer cannot see
    // coming: a keyboard transition, where refitting mid-animation churns the
    // PTY geometry on every intermediate frame.
    const fitGate = useMemo(
      () =>
        createKeyboardFitGate(
          () => send({ v: TERMINAL_BRIDGE_VERSION, type: "fit" }),
          theme.motion.duration.fast,
        ),
      [send, theme.motion.duration.fast],
    );
    useEffect(() => () => fitGate.dispose(), [fitGate]);

    useEffect(() => {
      const detach = bridge.attach((raw) => webViewRef.current?.postMessage(raw));
      return detach;
    }, [bridge]);

    useEffect(() => {
      callbacks.current.onTransport?.(transport);
      const unsubscribers = [
        transport.on("state", (state) => callbacks.current.onStateChange?.(state)),
        transport.on("error", (error) => callbacks.current.onError?.(error)),
        transport.on("diagnostic", (diagnostic) => callbacks.current.onDiagnostic?.(diagnostic)),
        transport.on("title", (title) => callbacks.current.onTitleChange?.(title)),
        transport.on("display", (display) => callbacks.current.onDisplayChange?.(display)),
        transport.on("connection-info", (info) => callbacks.current.onConnectionInfo?.(info)),
        transport.on("bell", () => callbacks.current.onBell?.()),
        transport.on("agent-notice", (notice) => callbacks.current.onAgentNotice?.(notice)),
      ];
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
        transport.close();
      };
    }, [transport]);

    useEffect(() => {
      transport.prepare?.();
      return subscribeRetirementReason((reason) => {
        if (reason === "interface-change") transport.networkChanged?.();
      });
    }, [transport]);

    const openTransport = useCallback((): void => {
      void transport.open().catch((error: unknown) => {
        // A coded rejection (device_not_trusted above all) keeps its code:
        // rewrapping it generically is what hid the approval ceremony.
        callbacks.current.onError?.({
          code: error instanceof HostControlTransportError ? error.code : "transport_open",
          message: error instanceof Error ? error.message : "Terminal transport failed to open.",
          retryable: true,
        });
      });
    }, [transport]);

    useEffect(() => {
      let backgroundTimer: ReturnType<typeof setTimeout> | null = null;
      let backgroundDeadline: number | null = null;
      const retireBackground = () => {
        if (backgroundDeadline === null || Date.now() < backgroundDeadline) return;
        backgroundDeadline = null;
        backgroundTimer = null;
        retiredForBackground.current = true;
        transport.close();
      };
      const subscription = AppState.addEventListener("change", (nextState) => {
        if (nextState === "inactive") return;
        if (nextState === "background") {
          if (!workerLoaded.current || backgroundDeadline !== null || retiredForBackground.current)
            return;
          backgroundDeadline = Date.now() + 3_000;
          backgroundTimer = setTimeout(retireBackground, 3_000);
          return;
        }
        if (backgroundTimer !== null) {
          clearTimeout(backgroundTimer);
          backgroundTimer = null;
        }
        // Native runtimes can pause timers in the background. Retire an expired
        // connection before foreground reopening even if its timer never ran.
        if (backgroundDeadline !== null && Date.now() >= backgroundDeadline) retireBackground();
        backgroundDeadline = null;
        if (!retiredForBackground.current || !workerLoaded.current) return;
        retiredForBackground.current = false;
        openTransport();
      });
      return () => {
        if (backgroundTimer !== null) clearTimeout(backgroundTimer);
        backgroundDeadline = null;
        subscription.remove();
      };
    }, [openTransport, transport]);

    useEffect(() => {
      send({ v: TERMINAL_BRIDGE_VERSION, type: "set-theme", theme: theme.terminal });
    }, [send, theme.terminal]);

    useEffect(() => {
      const start = (): void => fitGate.beginTransition();
      const finish = (): void => {
        fitGate.requestFit();
        fitGate.endTransition();
      };
      const subscriptions = [
        Keyboard.addListener("keyboardWillShow", start),
        Keyboard.addListener("keyboardWillHide", start),
        Keyboard.addListener("keyboardDidShow", finish),
        Keyboard.addListener("keyboardDidHide", finish),
      ];
      return () => {
        for (const subscription of subscriptions) subscription.remove();
      };
    }, [fitGate]);

    const handleSurfaceMessage = useCallback(
      async (message: WorkerToNativeMessage): Promise<void> => {
        if (message.type === "selection" && message.requestId) {
          const waiter = selectionWaiters.current.get(message.requestId);
          if (!waiter) return;
          clearTimeout(waiter.timer);
          selectionWaiters.current.delete(message.requestId);
          waiter.resolve(message.text.length === 0 ? null : message.text);
        } else if (message.type === "native-selection") {
          callbacks.current.onNativeSelection?.(message.active);
        } else if (message.type === "link") {
          callbacks.current.onLink?.(message.url);
        } else if (message.type === "clipboard-read") {
          send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "clipboard-response",
            requestId: message.requestId,
            error: "Clipboard reads require a native user gesture.",
          });
        } else if (message.type === "clipboard-write") {
          try {
            await Clipboard.setStringAsync(message.text);
            send({
              v: TERMINAL_BRIDGE_VERSION,
              type: "clipboard-response",
              requestId: message.requestId,
            });
          } catch (error) {
            send({
              v: TERMINAL_BRIDGE_VERSION,
              type: "clipboard-response",
              requestId: message.requestId,
              error: error instanceof Error ? error.message : "Clipboard write failed.",
            });
          }
        }
      },
      [send],
    );

    useEffect(() => {
      const unsubscribe = bridge.onMessage((message) => {
        void handleSurfaceMessage(message);
      });
      return unsubscribe;
    }, [bridge, handleSurfaceMessage]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => send({ v: TERMINAL_BRIDGE_VERSION, type: "focus" }),
        blur: () => send({ v: TERMINAL_BRIDGE_VERSION, type: "blur" }),
        sendKey: (sequence) => transport.write(new TextEncoder().encode(sequence)),
        scrollToBottom: () =>
          send({ v: TERMINAL_BRIDGE_VERSION, type: "scroll", target: "bottom" }),
        setFollow: (follow) => send({ v: TERMINAL_BRIDGE_VERSION, type: "set-follow", follow }),
        setFontSize: (nextFontSize) =>
          send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "set-font-size",
            fontSize: nextFontSize,
          }),
        copySelection: () => {
          const requestId = `selection-${++selectionSequence.current}`;
          return new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => {
              selectionWaiters.current.delete(requestId);
              resolve(null);
            }, theme.motion.duration.toastInfo);
            selectionWaiters.current.set(requestId, { resolve, timer });
            send({
              v: TERMINAL_BRIDGE_VERSION,
              type: "copy-selection",
              requestId,
            });
          });
        },
        search: (query, direction) =>
          send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "search",
            query,
            direction,
          }),
        takeControl: () => send({ v: TERMINAL_BRIDGE_VERSION, type: "take-control" }),
      }),
      [send, theme.motion.duration.toastInfo, transport],
    );

    const handleMessage = (event: WebViewMessageEvent): void => {
      try {
        bridge.receive(event.nativeEvent.data);
      } catch (error) {
        callbacks.current.onError?.({
          code: "bridge_protocol",
          message:
            error instanceof BridgeProtocolError
              ? error.message
              : "Terminal worker message failed.",
          retryable: false,
        });
      }
    };

    const handleLoad = (): void => {
      workerLoaded.current = true;
      if (AppState.currentState === "active") openTransport();
      else retiredForBackground.current = true;
    };

    const fileWorkerUrl = USE_FILE_WORKER_FALLBACK
      ? Image.resolveAssetSource(terminalWorkerAsset).uri
      : null;
    const source = fileWorkerUrl
      ? { uri: fileWorkerUrl }
      : { html: TERMINAL_WORKER_HTML, baseUrl: WORKER_BASE_URL };

    return (
      <WebView
        ref={webViewRef}
        source={source}
        style={[styles.surface, { backgroundColor: theme.terminal.background }, style]}
        accessibilityLabel="Terminal"
        accessible
        originWhitelist={["*"]}
        scrollEnabled={false}
        bounces={false}
        allowsBackForwardNavigationGestures={false}
        overScrollMode="never"
        hideKeyboardAccessoryView
        keyboardDisplayRequiresUserAction={false}
        textInteractionEnabled={false}
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        onShouldStartLoadWithRequest={(request) =>
          isWorkerBootstrapNavigation(request, fileWorkerUrl)
        }
        onOpenWindow={({ nativeEvent: { targetUrl } }) => {
          callbacks.current.onLink?.(targetUrl);
        }}
        onMessage={handleMessage}
        onLoad={handleLoad}
        onLayout={() => fitGate.requestFit()}
        onContentProcessDidTerminate={() => {
          workerLoaded.current = false;
          transport.close();
          callbacks.current.onContentProcessTerminated?.();
          webViewRef.current?.reload();
        }}
      />
    );
  },
);

const styles = StyleSheet.create({
  surface: {
    flex: 1,
  },
});
