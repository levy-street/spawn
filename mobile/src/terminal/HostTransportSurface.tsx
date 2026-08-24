import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState, Image, StyleSheet } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { WorkerBridge } from "@/terminal/transport/bridge";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-codec";
import { createHostTransport } from "@/terminal/transport/host-transport";
import type {
  HostTransport,
  HostTransportOptions,
  TransportError,
  TransportState,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import { isWorkerBootstrapNavigation, WORKER_BASE_URL } from "@/terminal/worker/navigation-policy";
import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";
import { opacity, spacing } from "@/theme";
import terminalWorkerAsset from "../../assets/terminal/worker.html";

// A future third fallback is serving this immutable asset from the spawn HTTPS origin.
const USE_FILE_WORKER_FALLBACK = false;

export interface HostTransportSurfaceProps extends Omit<HostTransportOptions, "bridge"> {
  onTransport(transport: HostTransport): void;
  onStateChange?(state: TransportState): void;
  onError?(error: TransportError): void;
  onDiagnostic?(diagnostic: WorkerDiagnostic): void;
}

export function HostTransportSurface({
  hostId,
  hostIdentityPublicKey,
  forceRelay,
  openSignal,
  onTransport,
  onStateChange,
  onError,
  onDiagnostic,
}: HostTransportSurfaceProps): React.JSX.Element {
  const webViewRef = useRef<WebView>(null);
  const workerLoaded = useRef(false);
  const retiredForBackground = useRef(false);
  const bridge = useMemo(() => new WorkerBridge(), []);
  const callbacks = useRef({ onTransport, onStateChange, onError, onDiagnostic });
  callbacks.current = { onTransport, onStateChange, onError, onDiagnostic };
  const transport = useMemo(
    () =>
      createHostTransport({
        hostId,
        hostIdentityPublicKey,
        bridge,
        ...(forceRelay === undefined ? {} : { forceRelay }),
        ...(openSignal === undefined ? {} : { openSignal }),
      }),
    [bridge, forceRelay, hostId, hostIdentityPublicKey, openSignal],
  );

  useEffect(() => bridge.attach((raw) => webViewRef.current?.postMessage(raw)), [bridge]);

  useEffect(() => {
    callbacks.current.onTransport(transport);
    const unsubscribers = [
      transport.on("state", (state) => callbacks.current.onStateChange?.(state)),
      transport.on("error", (error) => callbacks.current.onError?.(error)),
      transport.on("diagnostic", (diagnostic) => callbacks.current.onDiagnostic?.(diagnostic)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      transport.close();
    };
  }, [transport]);

  const openTransport = useCallback((): void => {
    void transport.open().catch((error: unknown) => {
      // A coded rejection (device_not_trusted above all) keeps its code:
      // rewrapping it generically is what hid the approval ceremony.
      callbacks.current.onError?.({
        code: error instanceof HostControlTransportError ? error.code : "host_transport_open",
        message: error instanceof Error ? error.message : "Host transport failed to open.",
        retryable: true,
      });
    });
  }, [transport]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        if (workerLoaded.current) {
          retiredForBackground.current = true;
          transport.close();
        }
        return;
      }
      if (!retiredForBackground.current || !workerLoaded.current) return;
      retiredForBackground.current = false;
      openTransport();
    });
    return () => subscription.remove();
  }, [openTransport, transport]);

  const handleMessage = (event: WebViewMessageEvent): void => {
    try {
      bridge.receive(event.nativeEvent.data);
    } catch (error) {
      callbacks.current.onError?.({
        code: "bridge_protocol",
        message: error instanceof Error ? error.message : "Host worker message failed.",
        retryable: false,
      });
    }
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
      style={styles.hiddenWorker}
      accessible={false}
      pointerEvents="none"
      originWhitelist={["*"]}
      scrollEnabled={false}
      bounces={false}
      allowsLinkPreview={false}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      onShouldStartLoadWithRequest={(request) =>
        isWorkerBootstrapNavigation(request, fileWorkerUrl)
      }
      onOpenWindow={() => undefined}
      onMessage={handleMessage}
      onLoad={() => {
        workerLoaded.current = true;
        if (AppState.currentState === "active") openTransport();
        else retiredForBackground.current = true;
      }}
      onContentProcessDidTerminate={() => {
        workerLoaded.current = false;
        transport.close();
        webViewRef.current?.reload();
      }}
    />
  );
}

const styles = StyleSheet.create({
  hiddenWorker: {
    position: "absolute",
    width: spacing.px,
    height: spacing.px,
    opacity: opacity.hidden,
  },
});
