"use client";

import { ArrowRightLeft, ChevronDown, CircleAlert, Download, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TransfersApi } from "@/components/files/transfers-provider";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress";
import {
  CANCEL_TRANSFER_LABEL,
  CLEAR_FINISHED_LABEL,
  countingNotice,
  HIDE_TRANSFERS_LABEL,
  interruptedNotice,
  PREPARING_NOTICE,
  preparingNotice,
  queuedNotice,
  REMOVE_TRANSFER_LABEL,
  RESUME_LABEL,
  RETRY_LABEL,
  TRANSFER_CANCELLED,
  TRANSFERS_TITLE,
  transferDoneSummary,
  transferFailedSummary,
  transferProgress,
  transfersSummary,
  transferTitle,
} from "@/lib/files/copy";
import { formatSize } from "@/lib/files/format";
import type { HubView } from "@/lib/files/transfer-hub";
import { cn } from "@/lib/utils";

/**
 * The Transfers tray: every upload, download and send this tab shows, over
 * whatever page is on screen, so leaving the folder a transfer started from
 * leaves it running. Collapsed, it is one line ("2 transfers · 45%"); it opens
 * by itself when a transfer starts, asks a question, or stops part-way.
 *
 * It sits above the workspace launcher in the bottom-right corner (and above
 * the touch modifier bar on phones), never over a toast.
 */

function isFinished(view: HubView): boolean {
  return view.phase === "done" || view.phase === "failed" || view.phase === "cancelled";
}

function needsYou(view: HubView): boolean {
  return view.question !== null || view.phase === "interrupted";
}

function percentOf(views: readonly HubView[]): number | null {
  let total = 0;
  let done = 0;
  for (const view of views) {
    total += view.totalBytes;
    done += Math.min(view.doneBytes, view.totalBytes);
  }
  return total > 0 ? Math.round((done / total) * 100) : null;
}

function trayLine(views: readonly HubView[]): string {
  const active = views.filter((view) => !isFinished(view));
  return transfersSummary({
    waiting: views.filter(needsYou).length,
    active: active.length,
    percent: percentOf(active),
  });
}

function statusLine(view: HubView): string {
  const host = view.verb === "upload" ? (view.to ?? "") : (view.from ?? view.to ?? "");
  switch (view.phase) {
    case "queued":
      return queuedNotice(view.to ?? view.from ?? "");
    case "planning":
      return view.verb === "upload" ? PREPARING_NOTICE : countingNotice(host, view.counted);
    case "waiting":
      return "";
    case "running":
      if (view.preparing !== null && view.preparing !== undefined)
        return preparingNotice(view.preparing);
      return transferProgress({
        doneBytes: view.doneBytes,
        totalBytes: view.totalBytes,
        doneItems: view.doneItems,
        totalItems: view.totalItems,
        secondsLeft: view.secondsLeft,
        formatBytes: formatSize,
      });
    case "interrupted":
      return interruptedNotice(
        view.interruption?.cause ?? "lost-touch",
        view.interruption?.host ?? host,
      );
    case "done":
      return transferDoneSummary({
        items: view.totalItems - view.skipped,
        bytes: view.doneBytes,
        skipped: view.skipped,
        formatBytes: formatSize,
      });
    case "failed":
      return view.error ?? transferFailedSummary(view.failed, view.verb);
    case "cancelled":
      return TRANSFER_CANCELLED;
  }
}

const VERB_ICON = { upload: Upload, download: Download, send: ArrowRightLeft } as const;

function TransferCard({ view, api }: { view: HubView; api: TransfersApi }) {
  const [applyToOthers, setApplyToOthers] = useState(false);
  const Icon = VERB_ICON[view.verb];
  const title = transferTitle({
    verb: view.verb,
    names: view.names,
    from: view.from ?? undefined,
    to: view.to ?? undefined,
    folder: view.folder ?? undefined,
    finished: view.phase === "done",
  });
  const line = statusLine(view);
  const question = view.question;
  const progress =
    view.phase === "running" || view.phase === "interrupted"
      ? view.totalBytes > 0
        ? (view.doneBytes / view.totalBytes) * 100
        : view.phase === "running"
          ? "indeterminate"
          : 0
      : view.phase === "queued" || view.phase === "planning"
        ? "indeterminate"
        : null;
  return (
    <li
      aria-label={title}
      className="flex flex-col gap-1.5 border-b border-border px-3 py-2.5 last:border-b-0"
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            view.phase === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          {/* Two lines before it is cut: a title names the folder and both hosts. */}
          <p className="line-clamp-2 break-words text-xs font-medium text-foreground" title={title}>
            {title}
          </p>
          {line && (
            <p
              className={cn(
                "mt-0.5 text-[11px] leading-snug",
                view.phase === "failed"
                  ? "text-destructive"
                  : view.phase === "interrupted"
                    ? "text-warning"
                    : "text-muted-foreground",
              )}
            >
              {line}
            </p>
          )}
        </div>
        {view.canDismiss ? (
          <button
            type="button"
            aria-label={REMOVE_TRANSFER_LABEL}
            onClick={() => api.dismiss(view.id)}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      {progress !== null && (
        <ProgressBar
          value={progress}
          label={title}
          tone={view.phase === "interrupted" ? "warning" : "primary"}
          className="ml-6"
        />
      )}

      {question && (
        <div className="ml-6 flex flex-col gap-2 rounded-md bg-warning-soft px-2.5 py-2">
          <p className="flex gap-1.5 text-xs leading-snug text-foreground">
            <CircleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <span>{question.text}</span>
          </p>
          {question.kind === "relay" ? (
            <div className="flex flex-wrap justify-end gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => api.answer(view.id, { kind: "relay", proceed: false })}
              >
                {CANCEL_TRANSFER_LABEL}
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => api.answer(view.id, { kind: "relay", proceed: true })}
              >
                {question.proceed}
              </Button>
            </div>
          ) : (
            <>
              {question.othersLabel && (
                <label className="flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={applyToOthers}
                    onChange={(event) => setApplyToOthers(event.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  {question.othersLabel}
                </label>
              )}
              <div className="flex flex-wrap justify-end gap-1.5">
                {question.choices.map((choice) => (
                  <Button
                    key={choice.decision}
                    size="sm"
                    variant={choice.decision === "keep-both" ? "default" : "outline"}
                    className="h-7 text-xs"
                    onClick={() =>
                      api.answer(view.id, {
                        kind: "conflict",
                        decision: choice.decision,
                        applyToOthers,
                      })
                    }
                  >
                    {choice.label}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {view.notes.length > 0 && (
        <ul className="ml-6 list-none space-y-0.5 text-[11px] text-muted-foreground">
          {view.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {view.failures.length > 0 && (
        <details className="ml-6 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none text-foreground">
            {transferFailedSummary(view.failed, view.verb)}
          </summary>
          <ul className="mt-1 max-h-32 list-none space-y-1 overflow-y-auto">
            {view.failures.map((failure) => (
              <li key={failure.rel}>
                <span className="font-mono text-foreground">{failure.rel}</span> — {failure.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {(view.canResume || view.canRetry || (view.canCancel && !question)) && (
        <div className="ml-6 flex flex-wrap justify-end gap-1.5">
          {view.canCancel && !question && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => api.cancel(view.id)}
            >
              {CANCEL_TRANSFER_LABEL}
            </Button>
          )}
          {view.canRetry && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => api.retry(view.id)}
            >
              {RETRY_LABEL}
            </Button>
          )}
          {view.canResume && (
            <Button size="sm" className="h-7 text-xs" onClick={() => api.resume(view.id)}>
              {RESUME_LABEL}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export function TransferTray({ api, views }: { api: TransfersApi; views: readonly HubView[] }) {
  const [open, setOpen] = useState(true);
  const line = trayLine(views);
  // Opens by itself when something new starts or asks for the person.
  const attention = views
    .filter(needsYou)
    .map((view) => `${view.id}:${view.phase}:${view.question?.text ?? ""}`)
    .join("|");
  const count = useRef(views.length);
  useEffect(() => {
    if (views.length > count.current) setOpen(true);
    count.current = views.length;
  }, [views.length]);
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  const anyFinished = views.some(isFinished);

  return (
    <section
      aria-label={TRANSFERS_TITLE}
      className={cn(
        "fixed right-3 z-40 flex flex-col items-end",
        "left-3 sm:left-auto",
        // Clear of the launcher in the corner, and of the touch modifier bar.
        "bottom-[calc(var(--safe-bottom)+3.5rem)] [@media(pointer:coarse)]:bottom-[calc(var(--safe-bottom)+7rem)]",
      )}
    >
      {open ? (
        <div className="flex max-h-[min(28rem,calc(var(--vv-height)-9rem))] w-full flex-col overflow-hidden rounded-xl border border-popover-border bg-popover text-popover-foreground shadow-2xl shadow-black/30 sm:w-[22rem]">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <h2 className="flex-1 text-xs font-semibold">{TRANSFERS_TITLE}</h2>
            {anyFinished && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => api.clearFinished()}
              >
                {CLEAR_FINISHED_LABEL}
              </Button>
            )}
            <button
              type="button"
              aria-label={HIDE_TRANSFERS_LABEL}
              onClick={() => setOpen(false)}
              className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
          </div>
          <ul className="min-h-0 flex-1 list-none overflow-y-auto">
            {views.map((view) => (
              <TransferCard key={view.id} view={view} api={api} />
            ))}
          </ul>
          <p className="sr-only" aria-live="polite">
            {line}
          </p>
        </div>
      ) : (
        <button
          type="button"
          aria-label={`${TRANSFERS_TITLE}: ${line}`}
          onClick={() => setOpen(true)}
          className={cn(
            "flex h-8 items-center gap-2 rounded-full border border-popover-border bg-popover px-3 text-xs font-medium text-popover-foreground shadow-lg",
            views.some(needsYou) && "border-warning/40 text-warning",
          )}
        >
          <ArrowRightLeft className="size-3.5" aria-hidden />
          <span aria-live="polite">{line}</span>
        </button>
      )}
    </section>
  );
}
