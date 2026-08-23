"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Which alert channels this browser is allowed to use, and which sessions it
 * has been told to shut up about.
 *
 * Per-browser rather than per-account, deliberately: "notify me" is a property
 * of the device you are holding, not of the account. A phone in your pocket
 * and a laptop you walked away from want different answers, and neither needs
 * an endpoint or a migration to say so. The tradeoff is real and worth knowing
 * — a session muted on the laptop is still noisy on the phone.
 *
 * Storage shape and failure behaviour follow `lib/theme.ts`: every access is
 * wrapped, and blocked storage degrades to defaults instead of throwing. A
 * notification preference is not worth breaking a page over.
 */

export const NOTIFY_STORAGE_KEY = "spawn.notify.prefs";

/** Delivery channels, each independently switchable. */
export interface NotifyChannels {
  /** In-page toast while the tab is visible. The only default-on channel:
   *  it costs nothing, needs no permission, and cannot follow you out of the
   *  tab. */
  toast: boolean;
  /** A short synthesized cue. Off by default; needs a user gesture to arm. */
  sound: boolean;
  /** OS notification while the tab is hidden. Off by default; needs the
   *  Notification permission, which needs an explicit click. */
  system: boolean;
  /** `navigator.vibrate`. Off by default; Android/Chromium only. */
  haptics: boolean;
}

export interface NotifyPrefs extends NotifyChannels {
  /** Alert when an agent hands the foreground back to the shell. */
  onFinished: boolean;
  /** Alert when a running agent goes quiet — the end of a turn. For agent
   *  CLIs this is the common case: they idle at a prompt rather than exit. */
  onAwaiting: boolean;
  /** Alert when a session exits or is killed. */
  onDied: boolean;
  /** Session ids this browser suppresses every channel for. */
  mutedSessions: string[];
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  toast: true,
  sound: false,
  system: false,
  haptics: false,
  onFinished: true,
  onAwaiting: true,
  onDied: true,
  mutedSessions: [],
};

export type NotifyChannelKey = keyof NotifyChannels;
export const NOTIFY_CHANNEL_KEYS: NotifyChannelKey[] = ["toast", "sound", "system", "haptics"];

/** Coerce anything that came out of storage into a usable preference set. */
export function normalizeNotifyPrefs(value: unknown): NotifyPrefs {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_NOTIFY_PREFS };
  const raw = value as Record<string, unknown>;
  const flag = (key: keyof NotifyPrefs): boolean =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : (DEFAULT_NOTIFY_PREFS[key] as boolean);
  const muted = Array.isArray(raw.mutedSessions)
    ? raw.mutedSessions.filter((item): item is string => typeof item === "string")
    : [];
  return {
    toast: flag("toast"),
    sound: flag("sound"),
    system: flag("system"),
    haptics: flag("haptics"),
    onFinished: flag("onFinished"),
    onAwaiting: flag("onAwaiting"),
    onDied: flag("onDied"),
    // Bounded so a long-lived browser cannot grow this list without limit.
    mutedSessions: [...new Set(muted)].slice(-200),
  };
}

export function readStoredNotifyPrefs(): NotifyPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_NOTIFY_PREFS };
  try {
    const stored = window.localStorage.getItem(NOTIFY_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_NOTIFY_PREFS };
    return normalizeNotifyPrefs(JSON.parse(stored));
  } catch {
    // Private browsing, blocked storage, or a corrupt value. Defaults are a
    // perfectly good answer and this is not worth surfacing.
    return { ...DEFAULT_NOTIFY_PREFS };
  }
}

// --- store -----------------------------------------------------------------
// A module singleton, like theme/toast/settings: the alert hook reads this
// from a component tree that remounts on every route change, and Settings
// writes it from a dialog that is not an ancestor of anything it affects.

const listeners = new Set<() => void>();
let prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS };
let initialised = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function ensureInitialised(): void {
  if (initialised || typeof window === "undefined") return;
  initialised = true;
  prefs = readStoredNotifyPrefs();
}

function persist(): void {
  try {
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage refused; the choice still applies for this session.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  ensureInitialised();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotifyPrefs(): NotifyPrefs {
  ensureInitialised();
  return prefs;
}

export function setNotifyPref<K extends keyof NotifyPrefs>(key: K, value: NotifyPrefs[K]): void {
  ensureInitialised();
  prefs = { ...prefs, [key]: value };
  persist();
}

export function isSessionMuted(sessionId: string): boolean {
  return getNotifyPrefs().mutedSessions.includes(sessionId);
}

export function setSessionMuted(sessionId: string, muted: boolean): void {
  ensureInitialised();
  const current = new Set(prefs.mutedSessions);
  if (muted) current.add(sessionId);
  else current.delete(sessionId);
  prefs = { ...prefs, mutedSessions: [...current].slice(-200) };
  persist();
}

export function toggleSessionMuted(sessionId: string): boolean {
  const next = !isSessionMuted(sessionId);
  setSessionMuted(sessionId, next);
  return next;
}

/** Subscribe outside React (the alert hook's socket handler does this). */
export function subscribeToNotifyPrefs(listener: () => void): () => void {
  return subscribe(listener);
}

export function useNotifyPrefs(): {
  prefs: NotifyPrefs;
  setPref: <K extends keyof NotifyPrefs>(key: K, value: NotifyPrefs[K]) => void;
} {
  const value = useSyncExternalStore(subscribe, getNotifyPrefs, () => DEFAULT_NOTIFY_PREFS);
  const setPref = useCallback(
    <K extends keyof NotifyPrefs>(key: K, next: NotifyPrefs[K]) => setNotifyPref(key, next),
    [],
  );
  return useMemo(() => ({ prefs: value, setPref }), [value, setPref]);
}

/** Reactive read for one session's mute state (the pane menu uses this). */
export function useSessionMuted(sessionId: string | null | undefined): boolean {
  const value = useSyncExternalStore(subscribe, getNotifyPrefs, () => DEFAULT_NOTIFY_PREFS);
  return sessionId ? value.mutedSessions.includes(sessionId) : false;
}

/** Whether an event class is wanted at all, before any channel is consulted. */
export function alertKindEnabled(prefsValue: NotifyPrefs, kind: string): boolean {
  if (kind === "agent.finished") return prefsValue.onFinished;
  if (kind === "agent.awaiting_input") return prefsValue.onAwaiting;
  if (kind === "session.died") return prefsValue.onDied;
  return false;
}
