import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Image, StyleSheet } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { subscribeRetirementReason } from "@/data/realtime/lifecycle";
import { deviceIdentityGeneration, subscribeDeviceIdentityAccount } from "@/lib/crypto/identity";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-codec";
import { createHostConsumerTransport } from "@/terminal/transport/host-transport";
import { retainHostTransport } from "@/terminal/transport/host-transport-registry";
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
  /** The authenticated app retains the root; tool surfaces own child channels. */
  connectionOwner?: boolean;
  onTransport(transport: HostTransport): void;
  onStateChange?(state: TransportState): void;
  onError?(error: TransportError): void;
  onDiagnostic?(diagnostic: WorkerDiagnostic): void;
}

export function HostTransportSurface(props: HostTransportSurfaceProps): React.JSX.Element {
  const generation = useSyncExternalStore(
    subscribeDeviceIdentityAccount,
    deviceIdentityGeneration,
    deviceIdentityGeneration,
  );
  return <HostTransportInstance key={generation} {...props} />;
}

function HostTransportInstance({
  hostId,
  hostIdentityPublicKey,
  forceRelay,
  openSignal,
  connectionOwner = false,
  onTransport,
  onStateChange,
  onError,
  onDiagnostic,
}: HostTransportSurfaceProps): React.JSX.Element | null {
  const webViewRef = useRef<WebView>(null);
  const workerLoaded = useRef(false);
  const retiredForBackground = useRef(false);
  const callbacks = useRef({ onTransport, onStateChange, onError, onDiagnostic });
  callbacks.current = { onTransport, onStateChange, onError, onDiagnostic };
  const lease = useMemo(
    () =>
      retainHostTransport({
        hostId,
        hostIdentityPublicKey,
        ...(forceRelay === undefined ? {} : { forceRelay }),
        ...(openSignal === undefined ? {} : { openSignal }),
      }),
    [forceRelay, hostId, hostIdentityPublicKey, openSignal],
  );
  const { bridge, transport: rootTransport } = lease.shared;
  const transport = useMemo(
    () =>
      connectionOwner
        ? rootTransport
        : createHostConsumerTransport({ hostId, hostIdentityPublicKey, bridge }, rootTransport),
    [bridge, connectionOwner, hostId, hostIdentityPublicKey, rootTransport],
  );
  const [ownsWorker, setOwnsWorker] = useState(lease.shared.owner === lease.ownerId);

  useEffect(() => lease.subscribeOwnership(setOwnsWorker), [lease]);
  useEffect(() => {
    if (!ownsWorker) return;
    return bridge.attach((raw) => webViewRef.current?.postMessage(raw));
  }, [bridge, ownsWorker]);

  useEffect(() => {
    callbacks.current.onTransport(transport);
    const unsubscribers = [
      transport.on("state", (state) => callbacks.current.onStateChange?.(state)),
      transport.on("error", (error) => callbacks.current.onError?.(error)),
      transport.on("diagnostic", (diagnostic) => callbacks.current.onDiagnostic?.(diagnostic)),
    ];
    callbacks.current.onStateChange?.(transport.state);
    if (transport !== rootTransport) void transport.open().catch(() => {});
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (transport !== rootTransport) transport.close();
      lease.release();
    };
  }, [lease, rootTransport, transport]);

  useEffect(() => {
    if (!ownsWorker) return;
    rootTransport.prepare?.();
    return subscribeRetirementReason((reason) => {
      if (reason === "interface-change") rootTransport.networkChanged?.();
    });
  }, [ownsWorker, rootTransport]);

  const openTransport = useCallback((): void => {
    void rootTransport.open().catch((error: unknown) => {
      // A coded rejection (device_not_trusted above all) keeps its code:
      // rewrapping it generically is what hid the approval ceremony.
      callbacks.current.onError?.({
        code: error instanceof HostControlTransportError ? error.code : "host_transport_open",
        message: error instanceof Error ? error.message : "Host transport failed to open.",
        retryable: true,
      });
    });
  }, [rootTransport]);

  useEffect(() => {
    let backgroundTimer: ReturnType<typeof setTimeout> | null = null;
    let backgroundDeadline: number | null = null;
    const retireBackground = () => {
      if (backgroundDeadline === null || Date.now() < backgroundDeadline) return;
      backgroundDeadline = null;
      backgroundTimer = null;
      retiredForBackground.current = true;
      rootTransport.close();
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
  }, [openTransport, rootTransport]);

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

  if (!ownsWorker) return null;

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
      // The library wraps the web view in a container of its own that grows to
      // fill its column; positioned like the worker itself, it takes no room
      // from whatever screen hosts the transport.
      containerStyle={styles.hiddenWorker}
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
        rootTransport.close();
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
