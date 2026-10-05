"use client";

import { ArrowRightLeft, Copy, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  ANOTHER_HOST,
  CANCEL_LABEL,
  CLIPBOARD_BLOCKED_TOAST,
  COPY_NOTE_LABEL,
  conflictsLine,
  copyingLine,
  DISMISS_LABEL,
  failureCopy,
  KEEP_OPEN_LINE,
  movingElsewhereLine,
  movingLine,
  NOTE_COPIED_TOAST,
  NOTE_FAILED_BANNER,
  puttingBackLine,
  RESOLVE_LABEL,
  RESUMING_LINE,
  resumeOnLabel,
  screenBanner,
  startFreshOnLabel,
  startingLine,
  stoppingLine,
  TRY_AGAIN_LABEL,
  takeThereLabel,
  USE_TERMINAL_NOW_LABEL,
} from "@/lib/move/copy";
import type { HubMove } from "@/lib/move/move-hub";
import { displayPath } from "@/lib/places";
import type { MoveNoteState } from "./use-move-note";

function Panel({ children, label, role }: { children: ReactNode; label: string; role?: "status" }) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-background/75 p-3 backdrop-blur-[2px]">
      <section
        aria-label={label}
        role={role}
        className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-popover p-4 text-sm shadow-lg"
      >
        {children}
      </section>
    </div>
  );
}

/** Whether a move this browser knows should cover its pane. */
export function moveCoversPane(move: HubMove | null): move is HubMove {
  if (!move || move.lost) return false;
  if (move.view.phase === "moved") return false;
  if (move.view.phase === "ended") return move.mine && move.view.actions.length > 0;
  return true;
}

/**
 * The move over the pane it moves, on every tab of this browser: its steps
 * ("Stopping Claude Code on dream…", "Copying the conversation · 3.1 of
 * 12.4 MB", "Starting on mac…"), Cancel while copying, and a stopped move's
 * reason with its choices. The tab running it is the one that acts; the
 * others ask it.
 */
export function MoveProgressOverlay({
  move,
  onControl,
  onDismiss,
  onStartFresh,
  onTryAgain,
  onResolve,
}: {
  move: HubMove;
  onControl: (action: "cancel" | "retry" | "resume_source" | "take_there") => void;
  onDismiss: () => void;
  /** The source was offline: a new conversation on the target instead. */
  onStartFresh: () => void;
  /** The move ended before anything moved: start it again from the dialog. */
  onTryAgain: () => void;
  onResolve: () => void;
}) {
  const { view } = move;
  const source = move.sourceName;
  const target = move.targetName || ANOTHER_HOST;
  const names = { source, target, cwd: displayPath(move.targetCwd) };
  const label = movingLine(target);

  if (view.phase === "paused" || view.phase === "ended") {
    const copy = view.failure ? failureCopy(view.failure, names, view.detail) : null;
    return (
      <Panel label={label}>
        <p role="alert" className="text-foreground">
          {copy?.message}
        </p>
        {copy?.detail && <p className="text-xs text-muted-foreground">{copy.detail}</p>}
        {view.conflicts && <p className="text-xs text-warning">{conflictsLine(source)}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {view.phase === "ended" && (
            <Button variant="outline" size="sm" onClick={onDismiss}>
              {DISMISS_LABEL}
            </Button>
          )}
          {view.actions.includes("resume_source") && (
            <Button variant="outline" size="sm" onClick={() => onControl("resume_source")}>
              {resumeOnLabel(source)}
            </Button>
          )}
          {view.actions.includes("resolve") && (
            <Button variant="outline" size="sm" onClick={onResolve}>
              {RESOLVE_LABEL}
            </Button>
          )}
          {view.actions.includes("take_there") && (
            <Button size="sm" onClick={() => onControl("take_there")}>
              {takeThereLabel(target)}
            </Button>
          )}
          {view.actions.includes("start_fresh") && (
            <Button size="sm" onClick={onStartFresh}>
              {startFreshOnLabel(target)}
            </Button>
          )}
          {view.actions.includes("retry") && (
            <Button
              size="sm"
              onClick={() => (view.phase === "paused" ? onControl("retry") : onTryAgain())}
            >
              {TRY_AGAIN_LABEL}
            </Button>
          )}
        </div>
      </Panel>
    );
  }

  const line =
    view.phase === "starting"
      ? movingLine(target)
      : view.phase === "stopping"
        ? stoppingLine(source)
        : view.phase === "copying"
          ? copyingLine(view.bytes, view.total)
          : view.phase === "putting_back"
            ? puttingBackLine(source)
            : startingLine(target);
  return (
    <Panel label={label}>
      <p className="flex items-center gap-2 font-medium">
        <ArrowRightLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {label}
      </p>
      <div className="flex flex-col gap-1.5">
        {/* The step is what changes: it is the one read out. */}
        <p className="text-muted-foreground" aria-live="polite" aria-atomic="true">
          {line}
        </p>
        <ProgressBar
          value={
            view.phase === "copying" && view.total > 0
              ? (100 * view.bytes) / view.total
              : "indeterminate"
          }
          label={line}
        />
        <p className="text-xs text-muted-foreground">{KEEP_OPEN_LINE}</p>
      </div>
      {view.actions.includes("cancel") && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => onControl("cancel")}>
            {CANCEL_LABEL}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/**
 * A window moving that this browser is not moving — another device's move,
 * or one whose tab went: "Moving to another host…" (named where this browser
 * heard it) with Resolve as the only thing to do.
 */
export function MovingElsewhereOverlay({
  target,
  onResolve,
}: {
  target: string | null;
  onResolve: () => void;
}) {
  const line = movingElsewhereLine(target);
  return (
    <Panel label={line}>
      <p className="flex items-center gap-2 font-medium">
        <Spinner size={14} />
        {line}
      </p>
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onResolve}>
          {RESOLVE_LABEL}
        </Button>
      </div>
    </Panel>
  );
}

/** Keys that only move focus: everything else typed at the guard is the
 *  person taking the terminal back. */
const FOCUS_KEYS = new Set(["Tab", "Shift", "Control", "Alt", "Meta", "CapsLock"]);

/**
 * "Resuming the conversation…" over the terminal until the note is placed.
 * It blocks keystrokes: a person typing while it is up would interleave
 * with the note and the Enter after it. The terminal's own focus moves to
 * the guard as it appears, so keys go nowhere near the shell; any key but
 * one that moves focus is taken as "Use the terminal now".
 */
export function ResumingGuard({ onUseTerminal }: { onUseTerminal: () => void }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const pane = wrapper.current?.parentElement;
    const active = document.activeElement;
    if (pane && active instanceof HTMLElement && pane.contains(active)) {
      active.blur();
      button.current?.focus({ preventScroll: true });
    }
  }, []);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only catches keys meant for the terminal underneath.
    <div
      ref={wrapper}
      onKeyDown={(event) => {
        if (FOCUS_KEYS.has(event.key) || event.key === "Enter" || event.key === " ") return;
        event.preventDefault();
        onUseTerminal();
      }}
    >
      <Panel label={RESUMING_LINE} role="status">
        <p className="flex items-center gap-2 font-medium">
          <Spinner size={14} />
          {RESUMING_LINE}
        </p>
        <div className="flex justify-end">
          <Button ref={button} variant="outline" size="sm" onClick={onUseTerminal}>
            {USE_TERMINAL_NOW_LABEL}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

async function copyNote(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(NOTE_COPIED_TOAST);
  } catch {
    toast.error(CLIPBOARD_BLOCKED_TOAST);
  }
}

/**
 * What Claude Code shows after the move, said at the top of the pane and
 * never answered for the person: the trust question, the Bypass Permissions
 * warning, the long conversation's resume choice, a sign-in, any other
 * question it asks, a missing conversation or Claude Code, or the note
 * SPAWN D could not place (to copy).
 */
export function MoveNoteBanner({ state }: { state: MoveNoteState }) {
  const { banner, note } = state;
  if (!banner) return null;
  const text =
    banner === "note_failed"
      ? NOTE_FAILED_BANNER
      : screenBanner(banner, note?.target ?? ANOTHER_HOST, note?.cwd ?? "this folder");
  if (!text) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-2">
      <div
        role="status"
        className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs shadow-lg"
      >
        <span className="min-w-0 text-foreground">{text}</span>
        {banner === "conversation_not_found" && (
          <button
            type="button"
            onClick={state.tryAgain}
            className="inline-flex h-7 shrink-0 items-center rounded-md bg-primary px-2.5 font-medium text-primary-foreground"
          >
            {TRY_AGAIN_LABEL}
          </button>
        )}
        {banner === "note_failed" && note && (
          <button
            type="button"
            onClick={() => void copyNote(note.text)}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-primary-foreground"
          >
            <Copy className="size-3.5" aria-hidden />
            {COPY_NOTE_LABEL}
          </button>
        )}
        <button
          type="button"
          aria-label={DISMISS_LABEL}
          onClick={state.dismissBanner}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
