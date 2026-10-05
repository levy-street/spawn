import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { decodeMoveArrival, pendingAgentInputs } from "@/components/launcher/pending-agent-input";
import {
  ARRIVAL_POLL_MS,
  type ArrivalEffect,
  type ArrivalState,
  giveUp,
  retryResume,
  startArrival,
  stepArrival,
} from "@/components/terminal-ui/move-arrival";
import * as copy from "@/components/workspace-detail/move-copy";
import { classifyClaudeScreen } from "@/data/selectors/claude-screen";
import type { TerminalSurfaceHandle } from "@/terminal/TerminalSurface";

/** Enter goes apart from the text: Claude Code reads one chunk as a paste,
 *  where a return is a newline rather than a send. */
const ENTER_GAP_MS = 150;

/**
 * Delivers what a moved window owes its agent, in the terminal that opened
 * it: the screen is read every 600 ms on the device, classified, and the
 * note typed only at Claude Code's ready prompt (`move-arrival.ts`). The
 * record is claimed before a key is typed, so it is typed at most once, by
 * this device, into this incarnation.
 */
export function useMoveArrival({
  sessionId,
  hostId,
  surface,
  onNotice,
}: {
  sessionId: string;
  hostId: string;
  surface: () => TerminalSurfaceHandle | null;
  onNotice: (message: string) => void;
}) {
  const [state, setState] = useState<ArrivalState | null>(null);
  const current = useRef<ArrivalState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const reading = useRef(false);

  const set = useCallback((next: ArrivalState | null) => {
    current.current = next;
    setState(next);
  }, []);

  const apply = useCallback(
    (effects: readonly ArrivalEffect[]) => {
      for (const effect of effects) {
        const target = surface();
        if (!target) return;
        if (effect.kind === "type") target.sendKey(effect.text);
        else if (effect.kind === "focus") target.focus();
        else {
          const enter = setTimeout(() => {
            enterTimers.current.delete(enter);
            surface()?.sendKey("\r");
          }, ENTER_GAP_MS);
          enterTimers.current.add(enter);
        }
      }
    },
    [surface],
  );

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(() => {
    stop();
    timer.current = setTimeout(async () => {
      timer.current = null;
      const before = current.current;
      if (!before || before.done || reading.current) return;
      reading.current = true;
      try {
        const screen = await surface()?.readScreen();
        const latest = current.current;
        if (!latest || latest !== before) return;
        const step = stepArrival(
          latest,
          screen ? classifyClaudeScreen(screen.lines) : null,
          Date.now(),
        );
        set(step.state);
        apply(step.effects);
        if (!step.state.done) poll();
      } finally {
        reading.current = false;
      }
    }, ARRIVAL_POLL_MS);
  }, [apply, set, stop, surface]);

  /** The resume line went out (or none was owed): claim what follows it. */
  const begin = useCallback(async () => {
    if (current.current) return;
    const read = await pendingAgentInputs.take(sessionId, hostId).catch(() => null);
    if (read?.status !== "ready") return;
    const arrival = decodeMoveArrival(read.record.command);
    if (!arrival) return;
    set(startArrival(arrival, Date.now()));
    poll();
  }, [hostId, poll, sessionId, set]);

  /** "Use the terminal now": nothing more is typed; the note can be copied. */
  const takeOver = useCallback(() => {
    stop();
    const latest = current.current;
    if (latest) set(giveUp(latest));
  }, [set, stop]);

  const retry = useCallback(() => {
    const latest = current.current;
    if (!latest) return;
    const step = retryResume(latest, Date.now());
    set(step.state);
    apply(step.effects);
    poll();
  }, [apply, poll, set]);

  const copyNote = useCallback(async () => {
    const note = current.current?.arrival.note?.text;
    if (!note) return;
    await Clipboard.setStringAsync(note);
    onNotice(copy.ARRIVAL_NOTE_COPIED);
    set(null);
  }, [onNotice, set]);

  const dismiss = useCallback(() => {
    stop();
    set(null);
  }, [set, stop]);

  // A new incarnation is a new arrival, and nothing of this one is typed there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the incarnation by design.
  useEffect(() => {
    const enters = enterTimers.current;
    return () => {
      stop();
      for (const enter of enters) clearTimeout(enter);
      enters.clear();
      current.current = null;
      setState(null);
    };
  }, [hostId, stop]);

  return { state, begin, takeOver, retry, copyNote, dismiss };
}
