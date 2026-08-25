import { focusManager, onlineManager } from "@tanstack/react-query";
import { AppState, type AppStateStatus } from "react-native";

export interface NetworkSnapshot {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  type: string;
}

export interface NetworkSource {
  addEventListener(listener: (state: NetworkSnapshot) => void): () => void;
}

export type RetirementReason = "background" | "offline" | "interface-change";

export interface RealtimeGenerationTarget {
  retire(reason: RetirementReason): void;
  reopen(): void | Promise<void>;
}

const GENERATION_TARGETS = new Set<RealtimeGenerationTarget>();
const RETIREMENT_LISTENERS = new Set<(reason: RetirementReason) => void>();

export function subscribeRetirementReason(
  listener: (reason: RetirementReason) => void,
): () => void {
  RETIREMENT_LISTENERS.add(listener);
  return () => RETIREMENT_LISTENERS.delete(listener);
}

export function registerRealtimeGenerationTarget(target: RealtimeGenerationTarget): () => void {
  GENERATION_TARGETS.add(target);
  return () => {
    GENERATION_TARGETS.delete(target);
  };
}

export function retireRegisteredGenerations(reason: RetirementReason): void {
  for (const listener of RETIREMENT_LISTENERS) listener(reason);
  for (const target of GENERATION_TARGETS) {
    target.retire(reason);
  }
}

export async function reopenRegisteredGenerations(): Promise<void> {
  for (const target of GENERATION_TARGETS) {
    await target.reopen();
  }
}

export interface ResumeSweepSteps {
  reconnectSockets: () => void | Promise<void>;
  refetchActiveQueries: () => void | Promise<void>;
  reopenVisibleTransports: () => void | Promise<void>;
}

export async function runResumeSweep(steps: ResumeSweepSteps): Promise<void> {
  await steps.reconnectSockets();
  await steps.refetchActiveQueries();
  await steps.reopenVisibleTransports();
}

interface AppStateSource {
  currentState: AppStateStatus;
  addEventListener(type: "change", listener: (state: AppStateStatus) => void): { remove(): void };
}

interface LifecycleManagers {
  setFocused: (focused: boolean) => void;
  setOnline: (online: boolean) => void;
}

export interface LifecycleOptions {
  retireAll: (reason: RetirementReason) => void;
  resume: ResumeSweepSteps;
  networkSource?: NetworkSource;
  appStateSource?: AppStateSource;
  managers?: LifecycleManagers;
}

export interface LifecycleController {
  onAppState(next: AppStateStatus): void;
  onNetwork(next: NetworkSnapshot): void;
  whenIdle(): Promise<void>;
  dispose(): void;
}

function isReachable(state: NetworkSnapshot): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

export function installRealtimeLifecycle(options: LifecycleOptions): LifecycleController {
  const appStateSource = options.appStateSource ?? AppState;
  const managers = options.managers ?? {
    setFocused: (focused: boolean) => focusManager.setFocused(focused),
    setOnline: (online: boolean) => onlineManager.setOnline(online),
  };
  let currentAppState = appStateSource.currentState;
  let online = true;
  let networkType: string | null = null;
  let disposed = false;
  let recoveryQueue = Promise.resolve();

  const enqueueRecovery = () => {
    recoveryQueue = recoveryQueue.then(async () => {
      if (!disposed && currentAppState === "active" && online) {
        await runResumeSweep(options.resume);
      }
    });
  };

  const onAppState = (next: AppStateStatus) => {
    if (disposed || next === currentAppState) {
      return;
    }
    const previous = currentAppState;
    currentAppState = next;
    managers.setFocused(next === "active");

    if (next === "background") {
      options.retireAll("background");
      return;
    }
    if (next === "active" && previous !== "active" && online) {
      enqueueRecovery();
    }
  };

  const onNetwork = (next: NetworkSnapshot) => {
    if (disposed) {
      return;
    }
    const nextOnline = isReachable(next);
    const connectivityChanged = nextOnline !== online;
    const interfaceChanged = networkType !== null && next.type !== networkType;
    const reason: RetirementReason | null = !nextOnline
      ? connectivityChanged
        ? "offline"
        : null
      : interfaceChanged || connectivityChanged
        ? "interface-change"
        : null;

    online = nextOnline;
    networkType = next.type;
    managers.setOnline(nextOnline);
    if (reason) {
      options.retireAll(reason);
    }
    if (nextOnline && (interfaceChanged || connectivityChanged) && currentAppState === "active") {
      enqueueRecovery();
    }
  };

  managers.setFocused(currentAppState === "active");
  const appSubscription = appStateSource.addEventListener("change", onAppState);
  const unsubscribeNetwork = options.networkSource?.addEventListener(onNetwork);

  return {
    onAppState,
    onNetwork,
    whenIdle: () => recoveryQueue,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      appSubscription.remove();
      unsubscribeNetwork?.();
    },
  };
}
