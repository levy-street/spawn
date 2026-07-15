"use client";

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
import { createPortal } from "react-dom";
import type { AgentConnectionInfo } from "@/components/terminal/ConnectionChip";
import { Terminal, type TerminalHandle } from "@/components/terminal/Terminal";
import type { DisplayControlState } from "@/lib/ws";

// Insert a prompt newline for mobile Return (same as the agent page/panes).
const MOBILE_PROMPT_NEWLINE = "\x1b[200~\n\x1b[201~";
// How many terminals stay warm (connected, rendered) in the background. The
// foreground one is never evicted; the least-recently-active parked ones go
// first once this is exceeded.
const WARM_LIMIT = 6;

export type AgentLive = {
  connInfo: AgentConnectionInfo | null;
  displayState: DisplayControlState | null;
};

/** Stable actions — this context value never changes, so a placeholder's
 *  `attach` ref callback (which depends on it) never re-fires spuriously. */
type Actions = {
  claim: (agentId: string, container: HTMLElement, token: symbol) => void;
  release: (agentId: string, token: symbol) => void;
  getHandle: (agentId: string) => TerminalHandle | null;
};
/** Reactive state — changes as terminals connect / move foreground. */
type State = {
  live: Record<string, AgentLive>;
  warm: Record<string, boolean>;
  claimed: Record<string, boolean>;
};

const ActionsCtx = createContext<Actions | null>(null);
const StateCtx = createContext<State>({ live: {}, warm: {}, claimed: {} });

type PoolEntry = {
  host: HTMLDivElement;
  handleRef: { current: TerminalHandle | null };
  token: symbol | null;
  lastAt: number;
};

export function LiveTerminalProvider({ children }: { children: ReactNode }) {
  const entriesRef = useRef<Map<string, PoolEntry>>(new Map());
  const parkRef = useRef<HTMLDivElement | null>(null);
  const [warmIds, setWarmIds] = useState<string[]>([]);
  const [claimed, setClaimed] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState<Record<string, AgentLive>>({});
  // Monotonic clock without Date.now in render; bumped per claim for LRU order.
  const clockRef = useRef(0);
  const nextClock = useCallback(() => {
    clockRef.current += 1;
    return clockRef.current;
  }, []);

  const evict = useCallback((agentId: string) => {
    const entry = entriesRef.current.get(agentId);
    if (!entry || entry.token !== null) return; // never evict a claimed terminal
    entriesRef.current.delete(agentId);
    entry.host.parentElement?.removeChild(entry.host);
    setWarmIds((ids) => ids.filter((id) => id !== agentId));
    setClaimed((m) => {
      if (!(agentId in m)) return m;
      const { [agentId]: _drop, ...rest } = m;
      return rest;
    });
    setLive((m) => {
      if (!(agentId in m)) return m;
      const { [agentId]: _drop, ...rest } = m;
      return rest;
    });
  }, []);

  const enforceLimit = useCallback(() => {
    const entries = [...entriesRef.current.entries()];
    let over = entries.length - WARM_LIMIT;
    if (over <= 0) return;
    const parked = entries
      .filter(([, e]) => e.token === null)
      .sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (const [id] of parked) {
      if (over <= 0) break;
      evict(id);
      over -= 1;
    }
  }, [evict]);

  const claim = useCallback(
    (agentId: string, container: HTMLElement, token: symbol) => {
      let entry = entriesRef.current.get(agentId);
      if (!entry) {
        const host = document.createElement("div");
        host.style.display = "contents";
        entry = { host, handleRef: { current: null }, token, lastAt: nextClock() };
        entriesRef.current.set(agentId, entry);
        setWarmIds((ids) => (ids.includes(agentId) ? ids : [...ids, agentId]));
      }
      entry.token = token;
      entry.lastAt = nextClock();
      if (entry.host.parentElement !== container) container.appendChild(entry.host);
      setClaimed((m) => (m[agentId] ? m : { ...m, [agentId]: true }));
      enforceLimit();
    },
    [enforceLimit, nextClock],
  );

  const release = useCallback((agentId: string, token: symbol) => {
    const entry = entriesRef.current.get(agentId);
    if (!entry || entry.token !== token) return; // superseded by a newer claim
    entry.token = null;
    const park = parkRef.current;
    if (park && entry.host.parentElement !== park) park.appendChild(entry.host);
    setClaimed((m) => (m[agentId] ? { ...m, [agentId]: false } : m));
  }, []);

  const getHandle = useCallback(
    (agentId: string) => entriesRef.current.get(agentId)?.handleRef.current ?? null,
    [],
  );

  const onInfo = useCallback((agentId: string, connInfo: AgentConnectionInfo) => {
    setLive((m) => ({
      ...m,
      [agentId]: { ...m[agentId], connInfo, displayState: m[agentId]?.displayState ?? null },
    }));
  }, []);
  const onDisplay = useCallback((agentId: string, displayState: DisplayControlState) => {
    setLive((m) => ({
      ...m,
      [agentId]: { ...m[agentId], displayState, connInfo: m[agentId]?.connInfo ?? null },
    }));
  }, []);

  const actions = useMemo<Actions>(
    () => ({ claim, release, getHandle }),
    [claim, release, getHandle],
  );
  const warm = useMemo(() => Object.fromEntries(warmIds.map((id) => [id, true])), [warmIds]);
  const state = useMemo<State>(() => ({ live, warm, claimed }), [live, warm, claimed]);

  return (
    <ActionsCtx.Provider value={actions}>
      <StateCtx.Provider value={state}>
        {children}
        {/* Offscreen park: parked hosts live here, staying connected + warm.
            Given a real size so xterm has a valid container (parked instances
            don't fit anyway — see Terminal's `active` guard). */}
        <div
          ref={parkRef}
          aria-hidden
          style={{
            position: "fixed",
            left: "-99999px",
            top: 0,
            width: "1024px",
            height: "768px",
            overflow: "hidden",
            visibility: "hidden",
            pointerEvents: "none",
          }}
        />
        {warmIds.map((id) => {
          const entry = entriesRef.current.get(id);
          if (!entry) return null;
          return (
            <PooledTerminal
              key={id}
              agentId={id}
              active={!!claimed[id]}
              host={entry.host}
              handleRef={entry.handleRef}
              onInfo={onInfo}
              onDisplay={onDisplay}
            />
          );
        })}
      </StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

function PooledTerminal({
  agentId,
  active,
  host,
  handleRef,
  onInfo,
  onDisplay,
}: {
  agentId: string;
  active: boolean;
  host: HTMLDivElement;
  handleRef: { current: TerminalHandle | null };
  onInfo: (agentId: string, info: AgentConnectionInfo) => void;
  onDisplay: (agentId: string, state: DisplayControlState) => void;
}) {
  return createPortal(
    <div className="size-full @container/term">
      <Terminal
        ref={handleRef}
        agentId={agentId}
        rawInput
        mobileReturnMode="newline"
        mobileReturnBytes={MOBILE_PROMPT_NEWLINE}
        imagePasteMode="bracketed-path"
        active={active}
        autoTakeControl={active}
        onConnectionInfo={(info) => onInfo(agentId, info)}
        onDisplayControl={(state) => onDisplay(agentId, state)}
      />
    </div>,
    host,
  );
}

/** Claim the shared warm terminal for `agentId` into a placeholder. Attach the
 *  returned `attach` ref to the div where the terminal body should render. */
export function useLiveTerminal(agentId: string | null) {
  const actions = useContext(ActionsCtx);
  if (!actions) throw new Error("useLiveTerminal must be used within LiveTerminalProvider");
  const tokenRef = useRef<symbol | null>(null);
  if (!tokenRef.current) tokenRef.current = Symbol("live-terminal");
  const containerRef = useRef<HTMLElement | null>(null);

  const attach = useCallback(
    (el: HTMLElement | null) => {
      containerRef.current = el;
      if (el && agentId) actions.claim(agentId, el, tokenRef.current as symbol);
    },
    [agentId, actions],
  );

  useEffect(() => {
    if (agentId && containerRef.current) {
      actions.claim(agentId, containerRef.current, tokenRef.current as symbol);
    }
    return () => {
      if (agentId) actions.release(agentId, tokenRef.current as symbol);
    };
  }, [agentId, actions]);

  const info = useAgentLive(agentId);
  return {
    attach,
    getHandle: useCallback(() => (agentId ? actions.getHandle(agentId) : null), [agentId, actions]),
    connInfo: info.connInfo,
    displayState: info.displayState,
  };
}

/** Reactive live info for one agent (connInfo/displayState); {} if not warm. */
export function useAgentLive(agentId: string | null): AgentLive {
  const { live } = useContext(StateCtx);
  return (agentId ? live[agentId] : null) ?? { connInfo: null, displayState: null };
}

/** Connection state for an agent, for indicators. */
export type AgentConnState = "connected" | "connecting" | "warm" | "off";
export function useAgentConnState(agentId: string | null): AgentConnState {
  const { live, warm, claimed } = useContext(StateCtx);
  if (!agentId || !warm[agentId]) return "off";
  const sock = live[agentId]?.connInfo?.socketState;
  if (sock === "open") return claimed[agentId] ? "connected" : "warm";
  return "connecting";
}
