import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { buildAlertsSocketUrl } from "@/data/api/socket-urls";
import { qk } from "@/data/queryKeys";
import { AlertSocketClient } from "@/data/realtime/alert-socket";
import { type CacheEffect, effectsForFrame, type RealtimeFrame } from "@/data/realtime/event-map";
import { subscribeHostSignalFrames } from "@/data/realtime/host-signal";
import {
  installRealtimeLifecycle,
  type NetworkSource,
  reopenRegisteredGenerations,
  retireRegisteredGenerations,
} from "@/data/realtime/lifecycle";
import { createProductionNetworkSource } from "@/data/realtime/network-source";
import { subscribeSessionSignalFrames } from "@/data/realtime/session-signal";
import { retireAll, type SocketState } from "@/data/realtime/socket";
import { useAlertStore } from "@/data/stores/alerts";
import { useConnectionStore } from "@/data/stores/connection";

export interface RealtimeProviderProps extends PropsWithChildren {
  networkSource?: NetworkSource;
  getActiveQueryKeys?: () => readonly (readonly unknown[])[];
  reopenVisibleTransports?: () => void | Promise<void>;
}

interface RealtimeContextValue {
  alertSocketState: SocketState;
  reconnect: () => void;
  retire: () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export async function applyCacheEffects(
  queryClient: Pick<QueryClient, "invalidateQueries" | "setQueryData">,
  effects: CacheEffect[],
): Promise<void> {
  for (const effect of effects) {
    if (effect.kind === "invalidate") {
      await queryClient.invalidateQueries({ queryKey: effect.key });
    } else if (effect.kind === "patch") {
      queryClient.setQueryData(effect.key, effect.update);
    }
  }
}

function isRealtimeFrame(frame: unknown): frame is RealtimeFrame {
  return (
    typeof frame === "object" && frame !== null && "type" in frame && typeof frame.type === "string"
  );
}

export function RealtimeProvider({
  children,
  networkSource,
  getActiveQueryKeys,
  reopenVisibleTransports,
}: RealtimeProviderProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const alertClientRef = useRef<AlertSocketClient | null>(null);
  const alertSocketState = useConnectionStore((state) => state.alertSocket);

  useEffect(() => {
    const alertClient = new AlertSocketClient(buildAlertsSocketUrl);
    const productionNetworkSource = networkSource ? null : createProductionNetworkSource();
    const activeNetworkSource = networkSource ?? productionNetworkSource;
    alertClientRef.current = alertClient;
    useConnectionStore.getState().setAlertSocket(alertClient.state);

    const applyFrame = (frame: unknown) => {
      if (isRealtimeFrame(frame)) {
        void applyCacheEffects(queryClient, effectsForFrame(frame));
      }
    };
    const refetchRecoveryQueries = async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.sessions() }),
        queryClient.invalidateQueries({ queryKey: qk.workspaces() }),
        queryClient.invalidateQueries({ queryKey: qk.hosts() }),
        queryClient.invalidateQueries({ queryKey: qk.agents() }),
      ]);
      for (const key of getActiveQueryKeys?.() ?? []) {
        await queryClient.refetchQueries({ queryKey: key, type: "active" });
      }
    };
    let hasOpened = false;
    let previousAlertSocketState = alertClient.state;
    const unsubscribeState = alertClient.subscribe((state) => {
      const previous = previousAlertSocketState;
      previousAlertSocketState = state;
      useConnectionStore.getState().setAlertSocket(state);
      if (state === "open") {
        productionNetworkSource?.reportSocketOpen();
        if (hasOpened) {
          void refetchRecoveryQueries();
        }
        hasOpened = true;
      } else if (previous === "open" && state === "reconnecting") {
        productionNetworkSource?.reportSocketFailure();
      }
    });
    const unsubscribeAlertFrames = alertClient.onFrame((frame) => {
      if (frame.type === "alert") {
        const { type: _type, ...alert } = frame;
        useAlertStore.getState().receive(alert);
      }
      applyFrame(frame);
    });
    const unsubscribeSessionFrames = subscribeSessionSignalFrames((_sessionId, frame) => {
      applyFrame(frame);
    });
    const unsubscribeHostFrames = subscribeHostSignalFrames((_hostId, frame) => {
      applyFrame(frame);
    });
    const lifecycle = installRealtimeLifecycle({
      retireAll: (reason) => {
        retireAll();
        retireRegisteredGenerations(reason);
      },
      resume: {
        reconnectSockets: () => alertClient.connect(),
        refetchActiveQueries: refetchRecoveryQueries,
        reopenVisibleTransports: async () => {
          await reopenRegisteredGenerations();
          await reopenVisibleTransports?.();
        },
      },
      ...(activeNetworkSource ? { networkSource: activeNetworkSource } : {}),
    });

    alertClient.connect();
    return () => {
      lifecycle.dispose();
      retireAll();
      retireRegisteredGenerations("background");
      unsubscribeState();
      unsubscribeAlertFrames();
      unsubscribeSessionFrames();
      unsubscribeHostFrames();
      alertClient.close();
      alertClientRef.current = null;
    };
  }, [getActiveQueryKeys, networkSource, queryClient, reopenVisibleTransports]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      alertSocketState,
      reconnect: () => alertClientRef.current?.hardReconnect(),
      retire: () => {
        retireAll();
        retireRegisteredGenerations("background");
      },
    }),
    [alertSocketState],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const value = useContext(RealtimeContext);
  if (!value) {
    throw new Error("useRealtime must be used inside RealtimeProvider");
  }
  return value;
}
