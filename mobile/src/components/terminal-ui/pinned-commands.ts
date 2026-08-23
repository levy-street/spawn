import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

import type { TerminalAgentKind } from "@/components/terminal-ui/terminal-commands";

export const PINNED_COMMANDS_KEY = "spawn.terminal.pinned";
/** The strip scrolls, but a pin list longer than this is a keyboard again. */
export const MAX_PINNED_COMMANDS = 8;

export type PinnedCommands = Record<TerminalAgentKind, readonly string[]>;

export interface PinnedCommandStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * What each agent starts with above the keyboard.
 *
 * Four plates: enough to cover what a session is mostly made of — stop it, change
 * its mode, open its menu, write a second line — while leaving the strip reading
 * as an edge rather than a rank of keys.
 */
export const DEFAULT_PINNED_COMMANDS: Readonly<PinnedCommands> = Object.freeze({
  "claude-code": ["key-Escape", "key-BackTab", "text-/", "key-ShiftEnter"],
  codex: ["key-Escape", "key-BackTab", "text-/", "key-ShiftEnter"],
  opencode: ["key-Escape", "key-BackTab", "text-/", "key-ShiftEnter"],
  aider: ["text-/", "key-Escape", "ctrl-c", "key-ShiftEnter"],
  agent: ["key-Escape", "key-BackTab", "text-/", "key-ShiftEnter"],
  shell: ["key-Tab", "ctrl-c", "key-ArrowUp", "ctrl-l"],
});

const AGENT_KINDS = Object.keys(DEFAULT_PINNED_COMMANDS) as TerminalAgentKind[];

function parseIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].slice(0, MAX_PINNED_COMMANDS);
}

export function parsePinnedCommands(encoded: string | null): PinnedCommands {
  const fallback = { ...DEFAULT_PINNED_COMMANDS };
  if (encoded === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;

  const stored = parsed as Record<string, unknown>;
  const pinned = { ...fallback };
  for (const kind of AGENT_KINDS) {
    // An empty list is a deliberate choice — a bare strip — not a missing one.
    const ids = parseIds(stored[kind]);
    if (ids !== null) pinned[kind] = ids;
  }
  return pinned;
}

/**
 * Read once per launch and shared by every terminal on screen.
 *
 * The tab shell keeps several terminals mounted at once, so a pin made in one
 * has to land in the others without a remount; each hook subscribes to the one
 * copy rather than holding its own.
 */
let cache: PinnedCommands | null = null;
let inflight: Promise<PinnedCommands> | null = null;
const listeners = new Set<(pinned: PinnedCommands) => void>();

export function resetPinnedCommandsCache(): void {
  cache = null;
  inflight = null;
}

export async function loadPinnedCommands(
  storage: PinnedCommandStorage = AsyncStorage,
): Promise<PinnedCommands> {
  if (cache !== null) return cache;
  inflight ??= (async () => {
    try {
      return parsePinnedCommands(await storage.getItem(PINNED_COMMANDS_KEY));
    } catch {
      return { ...DEFAULT_PINNED_COMMANDS };
    }
  })();
  const loaded = await inflight;
  cache ??= loaded;
  return cache;
}

export async function savePinnedCommands(
  pinned: PinnedCommands,
  storage: PinnedCommandStorage = AsyncStorage,
): Promise<void> {
  await storage.setItem(PINNED_COMMANDS_KEY, JSON.stringify(pinned));
}

function publish(pinned: PinnedCommands): void {
  cache = pinned;
  for (const listener of [...listeners]) listener(pinned);
}

/** Adds when absent, removes when present, and refuses to grow past the cap. */
export function togglePinnedCommand(
  ids: readonly string[],
  id: string,
): { ids: readonly string[]; changed: boolean } {
  if (ids.includes(id)) return { ids: ids.filter((pinned) => pinned !== id), changed: true };
  if (ids.length >= MAX_PINNED_COMMANDS) return { ids, changed: false };
  return { ids: [...ids, id], changed: true };
}

export interface PinnedCommandsState {
  pinned: readonly string[];
  /** False while the stored list is still being read, so nothing flashes. */
  ready: boolean;
  /** Returns false when the cap refused the pin, so the caller can say so. */
  toggle: (id: string) => boolean;
}

export function usePinnedCommands(kind: TerminalAgentKind): PinnedCommandsState {
  const [all, setAll] = useState<PinnedCommands | null>(cache);

  useEffect(() => {
    listeners.add(setAll);
    let active = true;
    void loadPinnedCommands().then((loaded) => {
      if (active) setAll(loaded);
    });
    return () => {
      active = false;
      listeners.delete(setAll);
    };
  }, []);

  const toggle = useCallback(
    (id: string): boolean => {
      const current = cache ?? { ...DEFAULT_PINNED_COMMANDS };
      const { ids, changed } = togglePinnedCommand(current[kind], id);
      if (!changed) return false;
      const next = { ...current, [kind]: ids };
      publish(next);
      void savePinnedCommands(next).catch(() => undefined);
      return true;
    },
    [kind],
  );

  return { pinned: all?.[kind] ?? DEFAULT_PINNED_COMMANDS[kind], ready: all !== null, toggle };
}
