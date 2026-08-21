"use client";

import { ALERTS_WS_SUBPROTOCOL, type AlertEvent, parseAlertFrame } from "@/lib/alerts";
import { buildAlertsWsUrl } from "@/lib/ws";

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

export type AlertSocketState = "idle" | "connecting" | "open" | "closed";

type AlertListener = (event: AlertEvent) => void;

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
const stateListeners = new Set<() => void>();

let socket: WebSocket | null = null;
let state: AlertSocketState = "idle";
let attempt = 0;
let reconnectTimer: number | null = null;
let lingerTimer: number | null = null;
let watchdogTimer: number | null = null;
let installed = false;
let stopped = false;

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
  if (stopped || listeners.size === 0) return;
  reconnectTimer = clearTimer(reconnectTimer);
  // Exponential with a ceiling, jittered so many tabs waking together do not
  // redial in lockstep.
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
  const delay = base * (0.7 + Math.random() * 0.6);
  attempt = Math.min(attempt + 1, 6);
  reconnectTimer = window.setTimeout(connect, delay);
}

function connect(): void {
  if (stopped || listeners.size === 0) return;
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
    attempt = 0;
    setState("open");
    armWatchdog();
  };

  ws.onmessage = (message) => {
    if (socket !== ws) return;
    armWatchdog();
    if (typeof message.data !== "string") return;
    const frame = parseAlertFrame(message.data);
    if (!frame || frame.type !== "alert") return;
    const { type: _type, ...event } = frame;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One bad consumer must not stop the others hearing about it.
      }
    }
  };

  const onGone = () => {
    if (socket !== ws) return;
    socket = null;
    watchdogTimer = clearTimer(watchdogTimer);
    setState("closed");
    scheduleReconnect();
  };
  ws.onclose = onGone;
  ws.onerror = onGone;
}

function wake(): void {
  // Coming back from a hidden tab or a dropped network is the moment a
  // half-open socket gets discovered, so retry immediately rather than
  // waiting out the backoff.
  if (listeners.size === 0 || stopped) return;
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
  window.addEventListener("pagehide", () => {
    // Bfcache: let the socket go rather than restoring a corpse.
    watchdogTimer = clearTimer(watchdogTimer);
  });
}

/** Listen for alerts. Opens the socket on the first subscriber. */
export function subscribeToAlerts(listener: AlertListener): () => void {
  if (typeof window === "undefined") return () => {};
  installGlobalListeners();
  stopped = false;
  listeners.add(listener);
  lingerTimer = clearTimer(lingerTimer);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    lingerTimer = clearTimer(lingerTimer);
    lingerTimer = window.setTimeout(() => {
      if (listeners.size > 0) return;
      closeAlertSocket();
    }, LINGER_MS);
  };
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
