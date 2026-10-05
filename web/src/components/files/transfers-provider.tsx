"use client";

import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TransferTray } from "@/components/files/transfer-tray";
import { useDaemonConnections } from "@/components/hosts/DaemonConnectionsProvider";
import { type Host, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { DaemonConnection } from "@/lib/daemon-connection";
import { BEFORE_UNLOAD_TRANSFERS, UNNAMED_HOST } from "@/lib/files/copy";
import { chooseDownloadSink } from "@/lib/files/download-sink";
import type { LocalPick } from "@/lib/files/drop-walk";
import {
  type DownloadSpec,
  type TransferAnswer,
  TransferEngine,
  type TransferEnv,
  type TransferView,
} from "@/lib/files/transfer-engine";
import { type HubBus, type HubView, TransferHub } from "@/lib/files/transfer-hub";
import type { ConflictPolicy, WalkSource } from "@/lib/files/transfer-plan";
import { HostControlClient, HostControlError } from "@/lib/hostControl";
import { pathFlavorForHostOS } from "@/lib/paths";
import { browserTabId } from "@/lib/tab-id";

/**
 * Transfers outlive the page they were started from: the engine lives here,
 * beside the host connections, for as long as the tab is open, and the tray
 * draws over whatever page is on screen.
 *
 * Every host is reached through a transfer consumer of its own — a channel on
 * this browser's shared connection that no file list or terminal uses — kept
 * while a transfer needs it and closed a little after the last one ends.
 * Uploads and sends are handed to the tab that holds the connection
 * (`TransferHub`); downloads run here, where their bytes are saved.
 */

export interface TransfersApi {
  /** Files and folders from this device into `dir` on the host. */
  upload(input: {
    hostId: string;
    dir: string;
    dirLabel: string;
    pick: LocalPick;
    policy?: ConflictPolicy;
  }): void;
  /** Items on one host into a folder on another, through this device. */
  send(input: {
    from: string;
    to: string;
    sources: WalkSource[];
    destDir: string;
    destLabel: string;
    policy: ConflictPolicy;
  }): void;
  /**
   * Save from a host. Call it from the click itself: a save picker needs the
   * gesture. `archive` names the zip a folder or several items go into.
   */
  download(input: { hostId: string; sources: WalkSource[]; archive: string | null }): Promise<void>;
  cancel(id: string): void;
  resume(id: string): void;
  /** Failed items again; a download asks where to save again, so call it from a click. */
  retry(id: string): void;
  answer(id: string, answer: TransferAnswer): void;
  dismiss(id: string): void;
  clearFinished(): void;
  /** Called with each job that has just finished (done or failed). */
  onFinished(listener: (view: TransferView) => void): () => void;
}

const TransfersContext = createContext<TransfersApi | null>(null);
const TransferViewsContext = createContext<readonly HubView[]>([]);

/** Null outside the provider (a test harness, a page outside the app). Stable across renders. */
export function useTransfers(): TransfersApi | null {
  return useContext(TransfersContext);
}

/** Every transfer this tab shows: its own, and those it handed to the tab holding the connection. */
export function useTransferViews(): readonly HubView[] {
  return useContext(TransferViewsContext);
}

/** Consumers no transfer has needed for this long are closed. */
const IDLE_CONSUMER_MS = 30_000;
const READY_MS = 15_000;

function untilReady(client: HostControlClient, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Transfer cancelled", "AbortError"));
      return;
    }
    const onAbort = () => reject(new DOMException("Transfer cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    client.waitUntilReady(READY_MS).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface Runtime {
  engine: TransferEngine;
  hub: TransferHub;
  close(): void;
}

function createRuntime(
  accountId: string,
  connections: { current: ReadonlyMap<string, DaemonConnection> },
  hostRecords: { current: ReadonlyMap<string, Host> },
  changed: () => void,
): Runtime {
  const consumers = new Map<string, { client: HostControlClient; connection: DaemonConnection }>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const closeConsumers = () => {
    for (const { client } of consumers.values()) client.close();
    consumers.clear();
  };
  const snapshot = (hostId: string) => connections.current.get(hostId)?.getSnapshot() ?? null;
  const env: TransferEnv = {
    host: async (hostId, signal) => {
      const connection = connections.current.get(hostId);
      if (!connection) {
        throw new HostControlError(
          "connection_closed",
          "This device has no connection to the host",
        );
      }
      let entry = consumers.get(hostId);
      if (entry && entry.connection !== connection) {
        // The connection was rebuilt (an identity change, a retirement).
        entry.client.close();
        consumers.delete(hostId);
        entry = undefined;
      }
      if (!entry) {
        const client = new HostControlClient(hostId, { sharedConnection: connection });
        client.connect();
        entry = { client, connection };
        consumers.set(hostId, entry);
      }
      await untilReady(entry.client, signal);
      return entry.client;
    },
    hostName: (hostId) => hostRecords.current.get(hostId)?.name ?? UNNAMED_HOST,
    flavor: (hostId) => pathFlavorForHostOS(hostRecords.current.get(hostId)?.os),
    pathKind: (hostId) => snapshot(hostId)?.info?.kind ?? null,
    rttMs: (hostId) => snapshot(hostId)?.info?.rttMs ?? null,
    connected: (hostId) => snapshot(hostId)?.state === "ready",
    lastOwnerRelease: (hostId) => connections.current.get(hostId)?.lastOwnerRelease?.() ?? null,
    tabId: browserTabId(),
    now: () => Date.now(),
  };
  let hub: TransferHub | null = null;
  const engine = new TransferEngine(env, () => {
    hub?.engineChanged();
    // The consumers go once nothing has needed them for a while.
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = engine.busy() ? null : setTimeout(closeConsumers, IDLE_CONSUMER_MS);
    changed();
  });
  let bus: HubBus | null = null;
  try {
    bus = new BroadcastChannel(`spawn.transfers.v1:${accountId}`) as unknown as HubBus;
  } catch {
    bus = null;
  }
  hub = new TransferHub(engine, {
    tabId: browserTabId(),
    bus,
    ownerOf: (hostId) => connections.current.get(hostId)?.ownerPage?.() ?? null,
    hostName: env.hostName,
    onChange: changed,
  });
  const runtimeHub = hub;
  return {
    engine,
    hub: runtimeHub,
    close: () => {
      runtimeHub.close();
      bus?.close();
      for (const view of engine.views()) engine.forget(view.id);
      if (idleTimer) clearTimeout(idleTimer);
      closeConsumers();
    },
  };
}

export function TransfersProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth({ probe: "hinted" });
  const accountId = user?.id ?? null;
  const connections = useDaemonConnections();
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    staleTime: 30_000,
    enabled: accountId !== null,
  });
  const hostRecords = useRef<ReadonlyMap<string, Host>>(new Map());
  hostRecords.current = new Map((hostsQ.data ?? []).map((host) => [host.id, host]));
  const [, setTick] = useState(0);
  const finishedListeners = useRef(new Set<(view: TransferView) => void>());
  const phases = useRef(new Map<string, TransferView["phase"]>());

  // Made in an effect, not during render: what it opens (a bus, host
  // consumers, timers) is closed by the same effect's cleanup, and a remount
  // makes a fresh one rather than reviving a closed one.
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  useEffect(() => {
    if (!accountId) {
      setRuntime(null);
      return;
    }
    const created = createRuntime(accountId, connectionsRef, hostRecords, () =>
      setTick((n) => n + 1),
    );
    setRuntime(created);
    return () => {
      created.close();
      setRuntime((current) => (current === created ? null : current));
    };
  }, [accountId]);

  // Leaving with work in flight asks first; going away tells the tabs this one runs jobs for.
  useEffect(() => {
    if (!runtime) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!runtime.engine.busy()) return;
      event.preventDefault();
      event.returnValue = BEFORE_UNLOAD_TRANSFERS;
    };
    const goodbye = () => runtime.hub.goodbye();
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", goodbye);
    document.addEventListener("freeze", goodbye);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", goodbye);
      document.removeEventListener("freeze", goodbye);
    };
  }, [runtime]);

  const views = runtime ? runtime.hub.views() : [];

  // Tell whoever listens (a file list that should show what just arrived).
  useEffect(() => {
    const seen = phases.current;
    for (const view of views) {
      const before = seen.get(view.id);
      const finished = view.phase === "done" || view.phase === "failed";
      if (finished && before !== view.phase) {
        for (const listener of finishedListeners.current) listener(view);
      }
      seen.set(view.id, view.phase);
    }
  });

  const download = useCallback(
    async (input: { hostId: string; sources: WalkSource[]; archive: string | null }) => {
      if (!runtime) return;
      // First, while the click still counts: a save picker needs it.
      const sink = await chooseDownloadSink(input.archive ?? input.sources[0]?.name ?? "download");
      if (!sink) return;
      runtime.hub.submit({ kind: "download", ...input, sink });
    },
    [runtime],
  );

  const api = useMemo<TransfersApi | null>(() => {
    if (!runtime) return null;
    const { engine, hub } = runtime;
    return {
      upload: ({ hostId, dir, dirLabel, pick, policy = "ask" }) => {
        if (pick.items.length === 0 && pick.emptyDirs.length === 0) return;
        hub.submit({
          kind: "upload",
          hostId,
          dir,
          dirLabel,
          items: pick.items,
          emptyDirs: pick.emptyDirs,
          policy,
        });
      },
      send: (input) => {
        hub.submit({ kind: "send", ...input });
      },
      download,
      cancel: (id) => hub.cancel(id),
      resume: (id) => hub.resume(id),
      retry: (id) => {
        const spec = engine.spec(id);
        if (spec?.kind !== "download") {
          hub.retry(id);
          return;
        }
        const { sink: _sink, ...again } = spec as DownloadSpec;
        void chooseDownloadSink(again.archive ?? again.sources[0]?.name ?? "download").then(
          (sink) => {
            if (!sink) return;
            engine.dismiss(id);
            hub.submit({ ...again, sink });
          },
        );
      },
      answer: (id, answer) => hub.answer(id, answer),
      dismiss: (id) => hub.dismiss(id),
      clearFinished: () => hub.clearFinished(),
      onFinished: (listener) => {
        finishedListeners.current.add(listener);
        return () => finishedListeners.current.delete(listener);
      },
    };
  }, [download, runtime]);

  return (
    <TransfersContext.Provider value={api}>
      <TransferViewsContext.Provider value={views}>
        {children}
        {api && views.length > 0 && <TransferTray api={api} views={views} />}
      </TransferViewsContext.Provider>
    </TransfersContext.Provider>
  );
}
