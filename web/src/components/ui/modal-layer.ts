"use client";

import { useEffect } from "react";
import { announceModalOpen, subscribeToModalOpen } from "@/lib/modal-layer";

/**
 * The React ends of `lib/modal-layer` — read that file for why a modal
 * dismisses the popups that predate it rather than simply outranking them.
 */

/** Dismiss this popup when a modal opens over it. No-op while it is closed,
 *  which is what keeps a popup deaf to the modal that spawned it. */
export function useDismissOnModalOpen(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    return subscribeToModalOpen(close);
  }, [open, close]);
}

/** The other side of the bargain, for a modal surface that mounts on open. */
export function useAnnounceModalOpen(): void {
  useEffect(() => announceModalOpen(), []);
}
