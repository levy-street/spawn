"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDaemonConnections } from "@/components/hosts/DaemonConnectionsProvider";
import { toast } from "@/components/ui/toast";
import { type Host, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { DaemonConnection } from "@/lib/daemon-connection";
import { HostControlClient } from "@/lib/hostControl";
import type { CarrierClient } from "@/lib/move/conv";
import {
  ANOTHER_HOST,
  BEFORE_UNLOAD_MOVE,
  backOnSourceToast,
  conflictsLine,
  failureCopy,
  movedArchivedToast,
  movedGoneToast,
  movedToast,
} from "@/lib/move/copy";
import {
  type HubBus,
  type HubMove,
  MoveHub,
  type MoveRecord,
  webLockClaims,
} from "@/lib/move/move-hub";
import {
  type MoveHostsPort,
  MoveOrchestrator,
  type MovePlan,
  type MoveView,
} from "@/lib/move/orchestrator";
import { displayPath } from "@/lib/places";
import { browserTabId } from "@/lib/tab-id";
import { createLocalLaunch, moveServer } from "./move-launch";

/**
 * Moves outlive the page they were started from: the hub lives here, beside
 * the host connections and transfers, for as long as the tab is open, and a
 * move runs in the tab that holds the target's connection (`MoveHub`).
 *
 * Each move reaches each host through consumer channels of its own — none a
 * file list or terminal uses — opened for the move and closed when it ends.
 * What is typed afterwards is queued here, in the tab that asked for the
 * move, for the window as it will run on the target: its terminal there
 * takes control as the mover's (`openIntent`), drains the line
 * (`pendingLaunch`) and places the note (`pendingNote`).
 */

export interface StartMove {
  plan: MovePlan;
  record: Omit<MoveRecord, "runner" | "requester" | "view">;
}

export interface MovesApi {
  start(move: StartMove): void;
  control(transferId: string, action: "cancel" | "retry" | "resume_source" | "take_there"): void;
  dismiss(transferId: string): void;
}

const MovesContext = createContext<MovesApi | null>(null);
const MovesListContext = createContext<readonly HubMove[]>([]);

export function useMoves(): MovesApi | null {
  return useContext(MovesContext);
}

/** Every move this browser knows of. */
export function useMovesList(): readonly HubMove[] {
  return useContext(MovesListContext);
}

/** The move a window is in, as this browser knows it, or null. */
export function useMoveFor(sessionId: string | null | undefined): HubMove | null {
  const moves = useContext(MovesListContext);
  if (!sessionId) return null;
  return moves.find((move) => move.sessionId === sessionId) ?? null;
}

const READY_MS = 15_000;

/** A consumer channel of its own to each end of one move. */
function hostsPort(
  plan: MovePlan,
  connections: { current: ReadonlyMap<string, DaemonConnection> },
  opened: Set<HostControlClient>,
): MoveHostsPort {
  const current: Record<"source" | "target", HostControlClient | null> = {
    source: null,
    target: null,
  };
  const open = async (side: "source" | "target"): Promise<CarrierClient> => {
    const existing = current[side];
    if (existing && existing.getState() === "ready") return existing;
    existing?.close();
    const hostId = plan[side].hostId;
    const connection = connections.current.get(hostId);
    if (!connection) throw new Error("This device has no connection to the host");
    const client = new HostControlClient(hostId, { sharedConnection: connection });
    current[side] = client;
    opened.add(client);
    client.connect();
    await client.waitUntilReady(READY_MS);
    return client;
  };
  return {
    source: () => open("source"),
    target: () => open("target"),
    reset: (side) => {
      current[side]?.close();
      current[side] = null;
    },
  };
}

/** What the asking tab says when a move it asked for ends. */
function announce(move: HubMove, view: MoveView): boolean {
  const names = {
    source: move.sourceName,
    target: move.targetName || ANOTHER_HOST,
    cwd: displayPath(move.targetCwd),
  };
  if (view.phase === "moved") {
    toast(movedToast(names.target, move.state));
    return true;
  }
  if (view.phase !== "ended") return false;
  // An ended move that still offers something stays over the pane.
  if (view.actions.length > 0) return false;
  if (view.outcome === "moved_archived") toast(movedArchivedToast(names.target));
  else if (view.outcome === "moved_gone") toast(movedGoneToast(names.target));
  else if (view.failure && view.failure !== "cancelled") {
    const copy = failureCopy(view.failure, names, view.detail);
    toast.error(copy.message, copy.detail ? { detail: copy.detail } : undefined);
  } else if (view.outcome === "put_back" || view.outcome === "put_back_restarted")
    toast(
      backOnSourceToast(names.source),
      view.conflicts ? { detail: conflictsLine(names.source), persistent: true } : undefined,
    );
  else if (view.failure === "cancelled") toast(failureCopy("cancelled", names).message);
  return true;
}

export function MovesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth({ probe: "hinted" });
  const accountId = user?.id ?? null;
  const queryClient = useQueryClient();
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
  const [tick, setTick] = useState(0);
  const [hub, setHub] = useState<MoveHub | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    if (!accountId) {
      setHub(null);
      return;
    }
    let bus: HubBus | null = null;
    try {
      bus = new BroadcastChannel(`spawn.moves.v1:${accountId}`) as unknown as HubBus;
    } catch {
      bus = null;
    }
    const clientsByMove = new Map<string, Set<HostControlClient>>();
    const created = new MoveHub({
      tabId: browserTabId(),
      bus,
      ownerOf: (hostId) => connectionsRef.current.get(hostId)?.ownerPage?.() ?? null,
      createRun: (plan, launcher, emit) => {
        const opened = new Set<HostControlClient>();
        clientsByMove.set(plan.transferId, opened);
        return new MoveOrchestrator(
          plan,
          { server: moveServer, hosts: hostsPort(plan, connectionsRef, opened), launcher },
          (view) => {
            emit(view);
            // Its channels go once the move is over; a paused move keeps them.
            if (view.phase === "moved" || view.phase === "ended") {
              for (const client of opened) client.close();
              clientsByMove.delete(plan.transferId);
            }
          },
        );
      },
      local: createLocalLaunch(queryClient),
      claims: webLockClaims(),
      onChange: () => setTick((n) => n + 1),
    });
    setHub(created);
    return () => {
      created.close();
      bus?.close();
      for (const opened of clientsByMove.values()) for (const client of opened) client.close();
      setHub((current) => (current === created ? null : current));
    };
  }, [accountId, queryClient]);

  // Leaving with a move running here asks first; going away tells the tabs.
  useEffect(() => {
    if (!hub) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hub.busy()) return;
      event.preventDefault();
      event.returnValue = BEFORE_UNLOAD_MOVE;
    };
    const goodbye = () => hub.goodbye();
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", goodbye);
    document.addEventListener("freeze", goodbye);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", goodbye);
      document.removeEventListener("freeze", goodbye);
    };
  }, [hub]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the hub's change signal.
  const moves = useMemo(() => hub?.moves() ?? [], [hub, tick]);

  // The tab that asked for a move says how it ended, once.
  useEffect(() => {
    if (!hub) return;
    const me = browserTabId();
    for (const move of moves) {
      if (move.requester !== me || announced.current.has(move.transferId)) continue;
      if (announce(move, move.view)) {
        announced.current.add(move.transferId);
        if (move.view.phase === "moved" || move.view.actions.length === 0)
          hub.dismiss(move.transferId);
      }
    }
  }, [hub, moves]);

  const api = useMemo<MovesApi | null>(() => {
    if (!hub) return null;
    return {
      start: ({ plan, record }) => hub.start(plan, record),
      control: (transferId, action) => hub.control(transferId, action),
      dismiss: (transferId) => hub.dismiss(transferId),
    };
  }, [hub]);

  return (
    <MovesContext.Provider value={api}>
      <MovesListContext.Provider value={moves}>{children}</MovesListContext.Provider>
    </MovesContext.Provider>
  );
}
