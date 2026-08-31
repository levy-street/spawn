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

/** A button on the notice itself, for a notice that asks rather than tells. */
export interface ToastAction {
  label: string;
  onClick: () => void;
  /** `primary` is the one the notice is recommending. */
  variant?: "primary" | "secondary";
}

/**
 * How far along, when a notice is reporting work rather than an event.
 *
 * `"indeterminate"` is a bar that moves without claiming a position, and is
 * the honest answer nearly everywhere: the daemon reports update *state* and
 * no byte counts, and `expo-updates` exposes no progress at all. A number is
 * only ever passed where something real is being counted — the desktop app's
 * updater, which hands us bytes downloaded against a content length.
 */
export type ToastProgress = "indeterminate" | number;

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
  /**
   * Stays until something dismisses it. For a notice about a *condition*
   * rather than an event — an update waiting to be taken is still waiting
   * five seconds later, and a notice that expires on its own has told the
   * person nothing they can act on.
   */
  persistent?: boolean;
  /** Buttons on the notice. Rendered under the text, primary last. */
  actions?: ToastAction[];
  /** Draws a progress bar under the text. */
  progress?: ToastProgress;
}

type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  icon?: ReactNode;
  onClick?: () => void;
  actionLabel?: string;
  persistent?: boolean;
  actions?: ToastAction[];
  progress?: ToastProgress;
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

function push(kind: ToastKind, message: string, options?: ToastOptions): number {
  const text = message.trim();
  if (!text) return 0;
  const now = Date.now();
  const ttl = durationFor(kind, options);
  // A persistent notice never expires, so it carries no deadline to refresh.
  const expiresAt = options?.persistent ? Number.POSITIVE_INFINITY : now + ttl;
  const duplicate = toasts.find(
    (item) =>
      !item.leaving &&
      item.kind === kind &&
      item.message === text &&
      item.detail === options?.detail,
  );
  if (duplicate) {
    // Refresh rather than repeat: the same event keeps one toast alive.
    toasts = toasts.map((item) => (item === duplicate ? { ...item, expiresAt } : item));
    emit();
    return duplicate.id;
  }
  const entry: Toast = {
    id: nextId++,
    kind,
    message: text,
    detail: options?.detail,
    icon: options?.icon,
    onClick: options?.onClick,
    actionLabel: options?.actionLabel,
    persistent: options?.persistent,
    actions: options?.actions,
    progress: options?.progress,
    expiresAt,
  };
  // Keep the newest MAX_VISIBLE. Anything already on its way out does not
  // count against the budget, so a burst never shows a half-faded corpse in
  // place of a live notice.
  //
  // Persistent notices are held back from eviction first. One of them is a
  // condition someone still has to answer — an update waiting to be taken —
  // and losing it to a burst of five transient notices would silently drop
  // the only notice on screen that was asking a question.
  const live = toasts.filter((item) => !item.leaving);
  const leaving = toasts.filter((item) => item.leaving);
  const candidates = [...live, entry];
  const sticky = candidates.filter((item) => item.persistent);
  const transient = candidates.filter((item) => !item.persistent);
  const room = Math.max(0, MAX_VISIBLE - sticky.length);
  const kept = [...sticky, ...transient.slice(-room)];
  const evicted = live
    .filter((item) => !kept.includes(item))
    .map((item) => ({ ...item, leaving: true }));
  toasts = [...leaving, ...evicted, ...kept];
  emit();
  for (const item of evicted) scheduleRemoval(item.id);
  return entry.id;
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

/** Returns the notice's id, which a persistent one needs to update or drop. */
export function toast(message: string, options?: ToastOptions): number {
  return push("info", message, options);
}
toast.error = (message: string, options?: ToastOptions): number => {
  return push("error", message, options);
};
/**
 * Change a notice already on screen, in place.
 *
 * A notice that is reporting work has to be able to move — "update available"
 * becomes "updating…" with a bar, and then goes away — and re-pushing would
 * animate a new row in beside the old one rather than changing this one.
 * Unknown ids are ignored: the notice may have been dismissed by hand while
 * the work that owns it was still running.
 */
toast.update = (id: number, patch: Partial<Omit<ToastOptions, "durationMs">>): void => {
  const target = toasts.find((item) => item.id === id && !item.leaving);
  if (!target) return;
  toasts = toasts.map((item) => (item.id === id ? { ...item, ...patch } : item));
  emit();
};
toast.dismiss = (id: number): void => {
  dismiss(id);
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
    // A persistent notice has an infinite deadline, so it is not merely
    // skipped here — it must not be the one the timer is scheduled against,
    // or setTimeout would be handed Infinity and nothing would ever expire.
    const live = items.filter(
      (item) => !item.leaving && item.expiresAt !== Number.POSITIVE_INFINITY,
    );
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
              {item.progress !== undefined ? <ToastProgressBar progress={item.progress} /> : null}
              {item.actions?.length ? (
                <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                  {item.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={action.onClick}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        action.variant === "primary"
                          ? "bg-primary text-primary-foreground hover:bg-primary/90"
                          : "border border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
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

/**
 * The bar under a notice that is reporting work.
 *
 * Indeterminate is a stripe that travels the track: it says "still going"
 * without claiming a position, which is all we honestly know for a daemon
 * update (the daemon reports state, never byte counts) or a mobile OTA.
 * A number is only passed where something real is counted, and is clamped
 * because a content-length that disagrees with the bytes actually delivered
 * should not paint outside the track.
 */
export function ToastProgressBar({ progress }: { progress: ToastProgress }) {
  const determinate = typeof progress === "number";
  const percent = determinate ? Math.max(0, Math.min(100, Math.round(progress))) : undefined;
  return (
    <div className="mt-2 flex items-center gap-2">
      <div
        role="progressbar"
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={percent}
        aria-valuetext={determinate ? `${percent}%` : "in progress"}
        className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
      >
        {determinate ? (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-swift"
            style={{ width: `${percent}%` }}
          />
        ) : (
          // Reduced motion keeps a still, part-filled track: the notice's own
          // text is what carries the meaning, and a frozen stripe reads as
          // stalled (DESIGN.md rule 6 — nothing depends on the animation).
          <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-toast-progress motion-reduce:w-1/2" />
        )}
      </div>
      {determinate ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{percent}%</span>
      ) : null}
    </div>
  );
}
