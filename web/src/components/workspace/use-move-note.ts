"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionConnectionInfo } from "@/components/terminal/ConnectionChip";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import {
  extendNoteWait,
  NOTE_ENTER_GAP_MS,
  NOTE_READY_WAIT_MS,
  type NoteStep,
  nextNoteStep,
  pendingNote,
  type QueuedNote,
  type RetryMark,
  screenSinceRetry,
} from "@/lib/move/note-delivery";
import { type ClaudeScreenState, claudeScreenAsksPerson } from "@/lib/move/screen";
import type { DisplayControlState } from "@/lib/ws";
import { attachedLaunchHost, pendingLaunch } from "./pending-launch";

/** What the pane shows while a moved window's note finds its place. */
export interface MoveNoteState {
  /** A dialog or a failure Claude shows: said in the pane, never answered. */
  banner: ClaudeScreenState | "note_failed" | null;
  /** "Resuming the conversation…" over the terminal, until the note is placed. */
  guard: boolean;
  /** The note as composed, for Copy note. */
  note: QueuedNote | null;
  /** Let the person use the terminal now; the note stays to copy. */
  useTerminalNow: () => void;
  /** Type the relaunch line again (no conversation found). */
  tryAgain: () => void;
  dismissBanner: () => void;
}

const TICK_MS = 1_000;

/**
 * Place a moved window's note once its relaunch line is typed: watch the
 * screen (`agentScreen`, read by the terminal only while a note waits), type
 * the note into Claude's ready prompt — sent only when Claude was mid-turn
 * and the line could not carry it — and surface every dialog as a banner.
 * Nothing here ever answers Claude: no Enter, no arrow, no digit goes into a
 * dialog. Only the pane holding the window's display types.
 */
export function useMoveNoteDelivery({
  sessionId,
  session,
  connInfo,
  displayState,
  getHandle,
  agentScreen,
}: {
  sessionId: string;
  session: { host_id: string } | undefined;
  connInfo: SessionConnectionInfo | null;
  displayState: DisplayControlState | null;
  getHandle: () => TerminalHandle | null;
  agentScreen: ClaudeScreenState | null;
}): MoveNoteState {
  const hostId = session?.host_id ?? null;
  const attached = attachedLaunchHost(session, connInfo);
  const owner = displayState?.owner === true;
  const waiting = hostId ? pendingNote.peek(sessionId, hostId) : null;
  const noteRef = useRef<QueuedNote | null>(null);
  if (waiting) noteRef.current = waiting;
  const startedAt = useRef<number | null>(null);
  /** When a typed note gives up, in ms after the line was typed. */
  const deadline = useRef(NOTE_READY_WAIT_MS);
  const placed = useRef(false);
  // The screen Try again was pressed on, stale until the terminal reads another.
  const retry = useRef<RetryMark | null>(null);
  const [banner, setBanner] = useState<MoveNoteState["banner"]>(null);
  const [guard, setGuard] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The clock starts once the line has gone into the shell on the new host.
  const lineTyped =
    waiting !== null &&
    hostId !== null &&
    attached === hostId &&
    owner &&
    !pendingLaunch.has(sessionId, hostId);
  if (lineTyped && startedAt.current === null) {
    startedAt.current = Date.now();
    deadline.current = NOTE_READY_WAIT_MS;
    placed.current = false;
  }
  const active = waiting !== null && startedAt.current !== null;

  // The line is typed by the launch drain, in an effect that renders nothing:
  // look again shortly, so the clock starts without waiting for other news.
  const queued = waiting !== null;
  useEffect(() => {
    if (!queued || active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [queued, active]);

  useEffect(() => {
    if (!active) return;
    setGuard(waiting?.delivery !== "positional");
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active, waiting?.delivery]);

  const finish = useCallback(() => {
    pendingNote.clear(sessionId);
    startedAt.current = null;
    setGuard(false);
  }, [sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` drives the timeouts.
  useEffect(() => {
    if (!active || !waiting || startedAt.current === null) return;
    const seen = screenSinceRetry(agentScreen ?? "unknown", retry.current, Date.now());
    retry.current = seen.retry;
    const elapsed = Date.now() - startedAt.current;
    const step: NoteStep = nextNoteStep(
      waiting.delivery,
      seen.screen,
      elapsed,
      placed.current,
      deadline.current,
    );
    switch (step.kind) {
      case "wait":
        return;
      case "banner":
        // The person is answering Claude: the note waits longer for it.
        deadline.current = extendNoteWait(deadline.current, elapsed);
        setBanner(step.state);
        return;
      case "stop":
        setBanner(step.state);
        finish();
        return;
      case "give_up":
        setBanner("note_failed");
        finish();
        return;
      case "type": {
        const handle = getHandle();
        if (!handle || !owner) return;
        placed.current = true;
        setBanner(null);
        handle.sendInput(waiting.text);
        if (step.enter) window.setTimeout(() => handle.sendInput("\r"), NOTE_ENTER_GAP_MS);
        requestAnimationFrame(() => handle.focus());
        finish();
        return;
      }
      case "done":
        if (agentScreen === "busy" || agentScreen === "agent_ready") setBanner(null);
        finish();
    }
  }, [active, agentScreen, now, owner, getHandle, finish]);

  // A banner for a question goes once Claude Code is up past it.
  useEffect(() => {
    if (
      banner !== null &&
      banner !== "note_failed" &&
      claudeScreenAsksPerson(banner) &&
      (agentScreen === "agent_ready" || agentScreen === "busy")
    )
      setBanner(null);
  }, [agentScreen, banner]);

  return {
    banner,
    // A question Claude asks is answered in the terminal: the guard gives
    // way to it, and the note still waits for the ready prompt.
    guard: guard && active && banner === null,
    note: noteRef.current,
    useTerminalNow: () => {
      setGuard(false);
      setBanner("note_failed");
      finish();
      getHandle()?.focus();
    },
    tryAgain: () => {
      const note = noteRef.current;
      const handle = getHandle();
      if (!note || !handle || !hostId) return;
      setBanner(null);
      pendingNote.set(sessionId, { ...note, hostId });
      startedAt.current = Date.now();
      deadline.current = NOTE_READY_WAIT_MS;
      placed.current = false;
      retry.current = { on: agentScreen ?? "unknown", at: Date.now() };
      handle.sendInput(`${note.line}\r`);
    },
    dismissBanner: () => setBanner(null),
  };
}
