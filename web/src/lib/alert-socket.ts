"use client";

import {
  ALERTS_WS_SUBPROTOCOL,
  type AlertEvent,
  type DataEvent,
  parseAlertFrame,
  type TrustEvent,
} from "@/lib/alerts";
import {
  backoffDelay,
  buildAlertsWsUrl,
  notifySocketUnauthorized,
  socketCloseAction,
} from "@/lib/ws";

/**
 * The owner's attention stream: one socket per tab, opened once, kept alive
 * for as long as anything is listening.
 *
 * A module singleton rather than component state, for the reason AppShell
 * documents about itself — the router remounts the shell on every route
 * change, workspace switches included. A socket owned by a component would be
 * torn down and redialed every time you clicked a workspace, which is both
 * wasteful and the exact window in which an alert would be missed.
 *
 * Why a socket at all rather than the existing 5 s session poll: the poll is
 * skipped entirely while the tab is hidden (TanStack gates interval refetches
 * on `focusManager.isFocused()`), which is precisely when an alert matters.
 * A socket delivers in about a second and keeps delivering with the tab in
 * the background.
 */

export type AlertSocketState = "idle" | "connecting" | "open" | "closed" | "unauthorized";

type AlertListener = (event: AlertEvent) => void;
type TrustListener = (event: TrustEvent) => void;
type DataListener = (event: DataEvent) => void;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
/** Server pings every 25 s; three misses means the link is gone even if the
 *  browser still thinks the socket is open (sleep/resume leaves half-open
 *  sockets that never fire `onclose`). */
const WATCHDOG_MS = 80_000;
/** Grace before closing a socket nobody is listening to. Covers the remount
 *  gap between one AppShell unmounting and the next one mounting. */
const LINGER_MS = 15_000;

const listeners = new Set<AlertListener>();
const trustListeners = new Set<TrustListener>();
const dataListeners = new Set<DataListener>();
const stateListeners = new Set<() => void>();

/** All three families share one socket, so any of them keeps it alive. */
function hasSubscribers(): boolean {
  return listeners.size > 0 || trustListeners.size > 0 || dataListeners.size > 0;
}

let socket: WebSocket | null = null;
let state: AlertSocketState = "idle";
let attempt = 0;
let reconnectTimer: number | null = null;
let lingerTimer: number | null = null;
let watchdogTimer: number | null = null;
let installed = false;
let stopped = false;
let protocolRequired = false;

function setState(next: AlertSocketState): void {
  if (state === next) return;
  state = next;
  for (const listener of stateListeners) listener();
}

function clearTimer(id: number | null): null {
  if (id !== null) window.clearTimeout(id);
  return null;
}

function armWatchdog(): void {
  watchdogTimer = clearTimer(watchdogTimer);
  watchdogTimer = window.setTimeout(() => {
    // Nothing at all for well over a keepalive interval: assume the link is
    // dead rather than trusting readyState, and redial.
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already gone; onclose will schedule the retry.
      }
    }
  }, WATCHDOG_MS);
}

function scheduleReconnect(): void {
  if (stopped || protocolRequired || !hasSubscribers()) return;
  reconnectTimer = clearTimer(reconnectTimer);
  // Exponential with a ceiling, jittered so many tabs waking together do not
  // redial in lockstep.
  const delay = backoffDelay(attempt, { base: RECONNECT_MIN_MS, cap: RECONNECT_MAX_MS });
  attempt = Math.min(attempt + 1, 6);
  reconnectTimer = window.setTimeout(connect, delay);
}

function connect(): void {
  if (stopped || protocolRequired || !hasSubscribers()) return;
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  )
    return;
  reconnectTimer = clearTimer(reconnectTimer);
  setState("connecting");

  let ws: WebSocket;
  try {
    ws = new WebSocket(buildAlertsWsUrl(), ALERTS_WS_SUBPROTOCOL);
  } catch {
    setState("closed");
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    setState("open");
    armWatchdog();
  };

  ws.onmessage = (message) => {
    if (socket !== ws) return;
    armWatchdog();
    if (typeof message.data !== "string") return;
    const frame = parseAlertFrame(message.data);
    if (!frame) return;
    attempt = 0;
    if (frame.type === "trust") {
      const { type: _trustType, ...trustEvent } = frame;
      for (const listener of [...trustListeners]) {
        try {
          listener(trustEvent);
        } catch {
          // One bad consumer must not stop the others hearing about it.
        }
      }
      return;
    }
    if (frame.type === "data") {
      const { type: _dataType, ...dataEvent } = frame;
      for (const listener of [...dataListeners]) {
        try {
          listener(dataEvent);
        } catch {
          // One bad consumer must not stop the others hearing about it.
        }
      }
      return;
    }
    if (frame.type !== "alert") return;
    const { type: _type, ...event } = frame;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One bad consumer must not stop the others hearing about it.
      }
    }
  };

  const onGone = (event: Event) => {
    if (socket !== ws) return;
    socket = null;
    watchdogTimer = clearTimer(watchdogTimer);
    const action = socketCloseAction(
      "code" in event && typeof event.code === "number" ? event.code : 1006,
    );
    if (action === "client_stale") {
      protocolRequired = true;
      reconnectTimer = clearTimer(reconnectTimer);
      window.dispatchEvent(new CustomEvent("spawn:client-stale", { detail: { hard: true } }));
      return;
    }
    if (action === "unauthorized") {
      stopped = true;
      reconnectTimer = clearTimer(reconnectTimer);
      setState("unauthorized");
      notifySocketUnauthorized();
      return;
    }
    if (action === "client_bug") {
      stopped = true;
      reconnectTimer = clearTimer(reconnectTimer);
      setState("closed");
      console.error("SPAWN D alert signalling stopped after a client protocol error.");
      return;
    }
    setState("closed");
    if (action === "reconnect_immediately") {
      reconnectTimer = window.setTimeout(connect, 0);
      return;
    }
    scheduleReconnect();
  };
  ws.onclose = onGone;
  // The close frame carries the protocol-required code; handling an error
  // first would throw that information away and start a reconnect too early.
  ws.onerror = () => {
    if (socket === ws) setState("closed");
  };
}

function wake(): void {
  // Coming back from a hidden tab or a dropped network is the moment a
  // half-open socket gets discovered, so retry immediately rather than
  // waiting out the backoff.
  if (!hasSubscribers() || stopped || protocolRequired) return;
  if (socket && socket.readyState === WebSocket.OPEN) return;
  attempt = 0;
  connect();
}

function installGlobalListeners(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
  window.addEventListener("pagehide", () => {
    // Bfcache: let the socket go rather than restoring a corpse.
    watchdogTimer = clearTimer(watchdogTimer);
  });
}

/** Listen for alerts. Opens the socket on the first subscriber. */
function subscribe(add: () => void, remove: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  installGlobalListeners();
  stopped = false;
  add();
  lingerTimer = clearTimer(lingerTimer);
  connect();
  return () => {
    remove();
    if (hasSubscribers()) return;
    lingerTimer = clearTimer(lingerTimer);
    lingerTimer = window.setTimeout(() => {
      if (hasSubscribers()) return;
      closeAlertSocket();
    }, LINGER_MS);
  };
}

export function subscribeToAlerts(listener: AlertListener): () => void {
  return subscribe(
    () => listeners.add(listener),
    () => listeners.delete(listener),
  );
}

/** Device-approval knocks and their resolutions, for the prompt in AppShell. */
export function subscribeToTrustEvents(listener: TrustListener): () => void {
  return subscribe(
    () => trustListeners.add(listener),
    () => trustListeners.delete(listener),
  );
}

/** Data-changed frames, for the cache invalidation in AppShell. */
export function subscribeToDataEvents(listener: DataListener): () => void {
  return subscribe(
    () => dataListeners.add(listener),
    () => dataListeners.delete(listener),
  );
}

export function subscribeToAlertSocketState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function getAlertSocketState(): AlertSocketState {
  return state;
}

/** Tear the socket down for good — signing out, or the last listener going
 *  away and staying away. */
export function closeAlertSocket(): void {
  stopped = true;
  reconnectTimer = clearTimer(reconnectTimer);
  lingerTimer = clearTimer(lingerTimer);
  watchdogTimer = clearTimer(watchdogTimer);
  const current = socket;
  socket = null;
  attempt = 0;
  if (current) {
    try {
      current.close();
    } catch {
      // Nothing to do; the handlers are already detached.
    }
  }
  setState("idle");
}
