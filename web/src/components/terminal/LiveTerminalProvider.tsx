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
import type { SessionConnectionInfo } from "@/components/terminal/ConnectionChip";
import { Terminal, type TerminalHandle } from "@/components/terminal/Terminal";
import type { AgentNotice } from "@/lib/agent-notice";
import type { DisplayControlState } from "@/lib/ws";

// Insert a prompt newline for mobile Return (same as the agent page/panes).
const MOBILE_PROMPT_NEWLINE = "\x1b[200~\n\x1b[201~";
// How many terminals stay warm (connected, rendered) in the background. The
// foreground one is never evicted; the least-recently-active parked ones go
// first once this is exceeded. Sized for the panes that can be on screen at
// once rather than for one grid's worth: a split window shows two workspaces
// side by side, and a pane that is on screen holds its terminal against
// eviction, so a pool sized for one grid would be entirely spoken for by what
// is visible and keep nothing warm behind it.
const WARM_LIMIT = 10;

export type SessionLive = {
  connInfo: SessionConnectionInfo | null;
  displayState: DisplayControlState | null;
  /** What the agent's own status bar is saying, read off the live screen. */
  agentNotice: AgentNotice | null;
};

const EMPTY_SESSION_LIVE: SessionLive = {
  connInfo: null,
  displayState: null,
  agentNotice: null,
};

/** Stable actions — this context value never changes, so a placeholder's
 *  `attach` ref callback (which depends on it) never re-fires spuriously. */
type Actions = {
  claim: (sessionId: string, container: HTMLElement, token: symbol) => void;
  release: (sessionId: string, token: symbol) => void;
  getHandle: (sessionId: string) => TerminalHandle | null;
};
/** Reactive state — changes as terminals connect / move foreground. */
type State = {
  live: Record<string, SessionLive>;
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
  const [live, setLive] = useState<Record<string, SessionLive>>({});
  // Monotonic clock without Date.now in render; bumped per claim for LRU order.
  const clockRef = useRef(0);
  const nextClock = useCallback(() => {
    clockRef.current += 1;
    return clockRef.current;
  }, []);

  const evict = useCallback((sessionId: string) => {
    const entry = entriesRef.current.get(sessionId);
    if (!entry || entry.token !== null) return; // never evict a claimed terminal
    entriesRef.current.delete(sessionId);
    entry.host.parentElement?.removeChild(entry.host);
    setWarmIds((ids) => ids.filter((id) => id !== sessionId));
    setClaimed((m) => {
      if (!(sessionId in m)) return m;
      const { [sessionId]: _drop, ...rest } = m;
      return rest;
    });
    setLive((m) => {
      if (!(sessionId in m)) return m;
      const { [sessionId]: _drop, ...rest } = m;
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
    (sessionId: string, container: HTMLElement, token: symbol) => {
      let entry = entriesRef.current.get(sessionId);
      if (!entry) {
        const host = document.createElement("div");
        host.style.display = "contents";
        entry = { host, handleRef: { current: null }, token, lastAt: nextClock() };
        entriesRef.current.set(sessionId, entry);
        setWarmIds((ids) => (ids.includes(sessionId) ? ids : [...ids, sessionId]));
      }
      entry.token = token;
      entry.lastAt = nextClock();
      if (entry.host.parentElement !== container) container.appendChild(entry.host);
      setClaimed((m) => (m[sessionId] ? m : { ...m, [sessionId]: true }));
      enforceLimit();
    },
    [enforceLimit, nextClock],
  );

  const release = useCallback((sessionId: string, token: symbol) => {
    const entry = entriesRef.current.get(sessionId);
    if (!entry || entry.token !== token) return; // superseded by a newer claim
    entry.token = null;
    const park = parkRef.current;
    if (park && entry.host.parentElement !== park) park.appendChild(entry.host);
    setClaimed((m) => (m[sessionId] ? { ...m, [sessionId]: false } : m));
  }, []);

  const getHandle = useCallback(
    (sessionId: string) => entriesRef.current.get(sessionId)?.handleRef.current ?? null,
    [],
  );

  const onInfo = useCallback((sessionId: string, connInfo: SessionConnectionInfo) => {
    setLive((m) => ({
      ...m,
      [sessionId]: { ...EMPTY_SESSION_LIVE, ...m[sessionId], connInfo },
    }));
  }, []);
  const onDisplay = useCallback((sessionId: string, displayState: DisplayControlState) => {
    setLive((m) => ({
      ...m,
      [sessionId]: { ...EMPTY_SESSION_LIVE, ...m[sessionId], displayState },
    }));
  }, []);
  const onAgentNotice = useCallback((sessionId: string, agentNotice: AgentNotice | null) => {
    setLive((m) => ({
      ...m,
      [sessionId]: { ...EMPTY_SESSION_LIVE, ...m[sessionId], agentNotice },
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
              sessionId={id}
              active={!!claimed[id]}
              host={entry.host}
              handleRef={entry.handleRef}
              onInfo={onInfo}
              onDisplay={onDisplay}
              onAgentNotice={onAgentNotice}
            />
          );
        })}
      </StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

function PooledTerminal({
  sessionId,
  active,
  host,
  handleRef,
  onInfo,
  onDisplay,
  onAgentNotice,
}: {
  sessionId: string;
  active: boolean;
  host: HTMLDivElement;
  handleRef: { current: TerminalHandle | null };
  onInfo: (sessionId: string, info: SessionConnectionInfo) => void;
  onDisplay: (sessionId: string, state: DisplayControlState) => void;
  onAgentNotice: (sessionId: string, notice: AgentNotice | null) => void;
}) {
  return createPortal(
    <div className="size-full @container/term">
      <Terminal
        ref={handleRef}
        sessionId={sessionId}
        rawInput
        mobileReturnMode="newline"
        mobileReturnBytes={MOBILE_PROMPT_NEWLINE}
        imagePasteMode="bracketed-path"
        active={active}
        onConnectionInfo={(info) => onInfo(sessionId, info)}
        onDisplayControl={(state) => onDisplay(sessionId, state)}
        onAgentNotice={(notice) => onAgentNotice(sessionId, notice)}
      />
    </div>,
    host,
  );
}

/**
 * Which sessions currently have a pane on screen.
 *
 * A session is "claimed" while a placeholder holds its terminal, and the grid
 * only renders the active tab's tiles — so this is the honest answer to "can
 * the user already see this happening?", which is what an alert needs before
 * deciding it has anything to tell them.
 */
export function useClaimedSessions(): Record<string, boolean> {
  return useContext(StateCtx).claimed;
}

/**
 * Reach any live terminal by id, from outside its pane.
 *
 * The pool already keys handles by session, so a surface that is not a pane —
 * an alert asking to be taken to the session it is about — can focus the right
 * terminal without the workspace grid having to route the request. Returns
 * null for a session with no live terminal yet, so callers retry rather than
 * assume.
 */
export function useTerminalHandles(): (sessionId: string) => TerminalHandle | null {
  const actions = useContext(ActionsCtx);
  if (!actions) throw new Error("useTerminalHandles must be used within LiveTerminalProvider");
  return actions.getHandle;
}

/** Claim the shared warm terminal for `sessionId` into a placeholder. Attach the
 *  returned `attach` ref to the div where the terminal body should render. */
export function useLiveTerminal(sessionId: string | null) {
  const actions = useContext(ActionsCtx);
  if (!actions) throw new Error("useLiveTerminal must be used within LiveTerminalProvider");
  const tokenRef = useRef<symbol | null>(null);
  if (!tokenRef.current) tokenRef.current = Symbol("live-terminal");
  const containerRef = useRef<HTMLElement | null>(null);

  const attach = useCallback(
    (el: HTMLElement | null) => {
      containerRef.current = el;
      if (el && sessionId) actions.claim(sessionId, el, tokenRef.current as symbol);
    },
    [sessionId, actions],
  );

  useEffect(() => {
    if (sessionId && containerRef.current) {
      actions.claim(sessionId, containerRef.current, tokenRef.current as symbol);
    }
    return () => {
      if (sessionId) actions.release(sessionId, tokenRef.current as symbol);
    };
  }, [sessionId, actions]);

  const info = useSessionLive(sessionId);
  return {
    attach,
    getHandle: useCallback(
      () => (sessionId ? actions.getHandle(sessionId) : null),
      [sessionId, actions],
    ),
    connInfo: info.connInfo,
    displayState: info.displayState,
    agentNotice: info.agentNotice,
  };
}

/** Reactive live info for one session (connInfo/displayState/agentNotice); empty if not warm. */
export function useSessionLive(sessionId: string | null): SessionLive {
  const { live } = useContext(StateCtx);
  return (sessionId ? live[sessionId] : null) ?? EMPTY_SESSION_LIVE;
}

/** Connection state for a session, for indicators. */
export type SessionConnState = "connected" | "connecting" | "warm" | "off";
export function useSessionConnState(sessionId: string | null): SessionConnState {
  const { live, warm, claimed } = useContext(StateCtx);
  if (!sessionId || !warm[sessionId]) return "off";
  const sock = live[sessionId]?.connInfo?.socketState;
  if (sock === "open") return claimed[sessionId] ? "connected" : "warm";
  return "connecting";
}
