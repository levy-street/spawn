"use client";

import { type ReactNode, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Promise-based confirmation dialog, replacing every `window.confirm` /
 * inline-confirm pattern. A module singleton in the settings-dialog-store
 * style: `ConfirmHost` is mounted once in the app shell, and any surface can
 * `await confirm({...})` without providers or local dialog state.
 */
export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type PendingConfirm = ConfirmOptions & { resolve: (confirmed: boolean) => void };

let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function settle(confirmed: boolean) {
  const current = pending;
  pending = null;
  emit();
  current?.resolve(confirmed);
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  // A second request while one is showing cancels the first — the surfaces
  // that could race are both modal, so this only happens on stray re-entry.
  pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { ...options, resolve };
    emit();
  });
}

/** Stable accessor for components; identical to importing `confirm` directly. */
export function useConfirm() {
  return confirm;
}

export function ConfirmHost() {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const request = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
    () => null,
  );

  if (request === null) return null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : settle(false))}>
      <DialogContent
        size="sm"
        hideClose
        // Destructive confirms make the user reach for the button
        // deliberately; safe ones take Enter immediately.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (request.destructive ? cancelRef : confirmRef).current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          {request.body != null ? (
            <DialogDescription>{request.body}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{request.title}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" size="sm" onClick={() => settle(false)}>
            {request.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            ref={confirmRef}
            variant={request.destructive ? "destructive" : "default"}
            size="sm"
            onClick={() => settle(true)}
          >
            {request.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
