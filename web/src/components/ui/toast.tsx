"use client";

import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

/**
 * Transient notifications, replacing inline error banners. A module singleton
 * in the `confirm()` style: `ToastHost` is mounted once in the app shell, and
 * any surface calls `toast("...")` / `toast.error("...")` without providers.
 *
 * Toasts stack top-right under the header, auto-dismiss (errors linger
 * longer), can be dismissed by hand, and identical messages coalesce instead
 * of stacking — a polling surface that fails every 5 s produces one toast, not
 * a column of them. When more arrive than fit, the newest win: an old notice
 * is the one worth losing.
 *
 * A toast can carry a second line and a leading mark (`detail`, `icon`) for
 * cases where "what happened" and "where it happened" are different facts —
 * an agent alert names the agent on the first line and the workspace and
 * window it belongs to on the second.
 */
export type ToastKind = "info" | "error";

export interface ToastOptions {
  /** Second line, dimmer — context rather than outcome. */
  detail?: string;
  /** Leading mark, replacing the kind glyph. A workspace avatar, usually. */
  icon?: ReactNode;
  /** Override the auto-dismiss delay. */
  durationMs?: number;
  /** Makes the notice actionable — "take me to the thing this is about".
   *  The row becomes a button; dismissing still works independently. */
  onClick?: () => void;
  /** Accessible name for that action, e.g. "Open Claude Code". */
  actionLabel?: string;
}

type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  icon?: ReactNode;
  onClick?: () => void;
  actionLabel?: string;
  expiresAt: number;
  /** Playing its exit animation; removed a beat later. */
  leaving?: boolean;
};

const INFO_MS = 5_000;
const ERROR_MS = 8_000;
/** Long enough to read two lines and decide whether to go and look. */
export const ALERT_TOAST_MS = 7_000;
const MAX_VISIBLE = 5;
/** Matches the exit animation, but is not read from it: nothing about the
 *  removal depends on the animation actually running (DESIGN.md rule 6), so
 *  reduced motion drops the movement and keeps the timing. */
const EXIT_MS = 180;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function durationFor(kind: ToastKind, options?: ToastOptions): number {
  if (options?.durationMs !== undefined) return options.durationMs;
  return kind === "error" ? ERROR_MS : INFO_MS;
}

function push(kind: ToastKind, message: string, options?: ToastOptions) {
  const text = message.trim();
  if (!text) return;
  const now = Date.now();
  const ttl = durationFor(kind, options);
  const duplicate = toasts.find(
    (item) =>
      !item.leaving &&
      item.kind === kind &&
      item.message === text &&
      item.detail === options?.detail,
  );
  if (duplicate) {
    // Refresh rather than repeat: the same event keeps one toast alive.
    toasts = toasts.map((item) => (item === duplicate ? { ...item, expiresAt: now + ttl } : item));
    emit();
    return;
  }
  const entry: Toast = {
    id: nextId++,
    kind,
    message: text,
    detail: options?.detail,
    icon: options?.icon,
    onClick: options?.onClick,
    actionLabel: options?.actionLabel,
    expiresAt: now + ttl,
  };
  // Keep the newest MAX_VISIBLE. Anything already on its way out does not
  // count against the budget, so a burst never shows a half-faded corpse in
  // place of a live notice.
  const live = toasts.filter((item) => !item.leaving);
  const leaving = toasts.filter((item) => item.leaving);
  const kept = [...live, entry].slice(-MAX_VISIBLE);
  const evicted = live
    .filter((item) => !kept.includes(item))
    .map((item) => ({ ...item, leaving: true }));
  toasts = [...leaving, ...evicted, ...kept];
  emit();
  for (const item of evicted) scheduleRemoval(item.id);
}

/** Begin the exit animation; the row leaves the DOM after EXIT_MS. */
function dismiss(id: number) {
  const target = toasts.find((item) => item.id === id);
  if (!target || target.leaving) return;
  toasts = toasts.map((item) => (item.id === id ? { ...item, leaving: true } : item));
  emit();
  scheduleRemoval(id);
}

function scheduleRemoval(id: number) {
  window.setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== id);
    emit();
  }, EXIT_MS);
}

export function toast(message: string, options?: ToastOptions): void {
  push("info", message, options);
}
toast.error = (message: string, options?: ToastOptions): void => {
  push("error", message, options);
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
    const live = items.filter((item) => !item.leaving);
    if (live.length === 0) return;
    const soonest = Math.min(...live.map((item) => item.expiresAt));
    const timer = window.setTimeout(
      () => {
        const now = Date.now();
        for (const item of toasts) {
          if (!item.leaving && item.expiresAt <= now) dismiss(item.id);
        }
      },
      Math.max(0, soonest - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [items]);

  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      /*
       * Top-right, under the mobile header rather than over it, and clear of
       * the notch. Newest sits at the top of the column, closest to where the
       * eye lands.
       */
      className="pointer-events-none fixed right-4 z-[120] flex w-80 max-w-[calc(100vw-2rem)] flex-col-reverse gap-2 top-[calc(3.5rem+var(--safe-top))] @md/shell:top-[calc(1rem+var(--safe-top))]"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.kind === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg",
            item.leaving
              ? "animate-out fade-out-0 slide-out-to-right-4 fill-mode-forwards duration-150"
              : "animate-in fade-in-0 slide-in-from-right-4 duration-200 ease-swift",
            item.kind === "error" ? "border-destructive/40" : "border-border",
          )}
        >
          {item.icon ? (
            <span className="mt-0.5 shrink-0">{item.icon}</span>
          ) : item.kind === "error" ? (
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          )}
          {item.onClick ? (
            // A real button rather than a click handler on the row: the row is
            // the live region, and an action inside it needs its own name,
            // keyboard behaviour and focus ring.
            <button
              type="button"
              aria-label={item.actionLabel}
              onClick={() => {
                item.onClick?.();
                dismiss(item.id);
              }}
              className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <p className="break-words leading-5">{item.message}</p>
              {item.detail ? (
                <p className="mt-0.5 break-words text-xs leading-4 text-muted-foreground">
                  {item.detail}
                </p>
              ) : null}
            </button>
          ) : (
            <div className="min-w-0 flex-1">
              <p className="break-words leading-5">{item.message}</p>
              {item.detail ? (
                <p className="mt-0.5 break-words text-xs leading-4 text-muted-foreground">
                  {item.detail}
                </p>
              ) : null}
            </div>
          )}
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
