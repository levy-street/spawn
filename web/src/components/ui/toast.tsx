"use client";

import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

/**
 * Transient notifications, replacing inline error banners. A module singleton
 * in the `confirm()` style: `ToastHost` is mounted once in the app shell, and
 * any surface calls `toast("...")` / `toast.error("...")` without providers.
 *
 * Toasts stack bottom-right, auto-dismiss (errors linger longer), can be
 * dismissed by hand, and identical consecutive messages coalesce instead of
 * stacking — a polling surface that fails every 5 s produces one toast, not a
 * column of them.
 */
export type ToastKind = "info" | "error";

type Toast = { id: number; kind: ToastKind; message: string; expiresAt: number };

const INFO_MS = 4_000;
const ERROR_MS = 8_000;
const MAX_VISIBLE = 4;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function push(kind: ToastKind, message: string) {
  const text = message.trim();
  if (!text) return;
  const now = Date.now();
  const duplicate = toasts.find((item) => item.kind === kind && item.message === text);
  if (duplicate) {
    // Refresh rather than repeat: the same failure keeps one toast alive.
    toasts = toasts.map((item) =>
      item === duplicate
        ? { ...item, expiresAt: now + (kind === "error" ? ERROR_MS : INFO_MS) }
        : item,
    );
    emit();
    return;
  }
  toasts = [
    ...toasts.slice(-(MAX_VISIBLE - 1)),
    { id: nextId++, kind, message: text, expiresAt: now + (kind === "error" ? ERROR_MS : INFO_MS) },
  ];
  emit();
}

function dismiss(id: number) {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

export function toast(message: string): void {
  push("info", message);
}
toast.error = (message: string): void => {
  push("error", message);
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Toast[] {
  return toasts;
}

/** Mounted once in the app shell; renders and expires the toast stack. */
export function ToastHost() {
  const items = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (items.length === 0) return;
    const soonest = Math.min(...items.map((item) => item.expiresAt));
    const timer = window.setTimeout(
      () => {
        const now = Date.now();
        toasts = toasts.filter((item) => item.expiresAt > now);
        emit();
      },
      Math.max(0, soonest - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [items]);

  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      // Bottom offset clears the pane launcher pinned beneath (launcher-fab).
      className="pointer-events-none fixed right-4 z-[120] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 bottom-[calc(4.5rem+var(--safe-bottom))]"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.kind === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg",
            "animate-in fade-in-0 slide-in-from-bottom-2 duration-150",
            item.kind === "error" ? "border-destructive/40" : "border-border",
          )}
        >
          {item.kind === "error" ? (
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          )}
          <p className="min-w-0 flex-1 break-words leading-5">{item.message}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(item.id)}
            className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
