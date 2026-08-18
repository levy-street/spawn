"use client";

import { useSyncExternalStore } from "react";

/**
 * Sidebar ↔ grid hover-highlight contract (§5.2): hovering a sidebar session
 * row highlights the matching grid tile, and vice versa. A module-level store
 * keeps this out of React context — both sides may live in different trees.
 */

let highlightedSessionId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const highlightStore = {
  get(): string | null {
    return highlightedSessionId;
  },
  set(sessionId: string | null): void {
    if (highlightedSessionId === sessionId) return;
    highlightedSessionId = sessionId;
    emit();
  },
  clear(): void {
    highlightStore.set(null);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The currently hover-highlighted session id, reactively. */
export function useHighlightedSession(): string | null {
  return useSyncExternalStore(highlightStore.subscribe, highlightStore.get, () => null);
}
