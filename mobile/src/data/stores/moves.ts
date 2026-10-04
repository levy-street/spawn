import { create } from "zustand";
import type { MovePhase, MoveRun } from "@/components/workspace-detail/move-conversation";

/**
 * The moves this device is carrying, by window: memory only, like the
 * transfer queue — a move names hosts and folders, and lives as long as the
 * app does. Each run goes on while the person moves between screens; the
 * runner (`move-runner.tsx`) keeps the screen awake while one is under way,
 * stops it safely past the background deadline, and opens the moved window
 * when it lands. A move this device lost (the app was closed) is resolved
 * from the hosts' own records, on any device (`move-resolve.ts`).
 */
export interface MoveEntry {
  readonly run: MoveRun;
  readonly phase: MovePhase;
  /** The sheet that shows it is up; a run stays when the sheet is put away. */
  readonly visible: boolean;
}

interface MovesState {
  readonly moves: Readonly<Record<string, MoveEntry>>;
  /** The one the progress sheet shows. */
  readonly shown: string | null;
  add(run: MoveRun): void;
  setPhase(sessionId: string, phase: MovePhase): void;
  show(sessionId: string): void;
  hide(): void;
  remove(sessionId: string): void;
  reset(): void;
}

export const useMovesStore = create<MovesState>((set, get) => ({
  moves: {},
  shown: null,
  add(run) {
    const previous = get().moves[run.sessionId];
    previous?.run.dispose();
    set((state) => ({
      moves: {
        ...state.moves,
        [run.sessionId]: { run, phase: run.phase, visible: true },
      },
      shown: run.sessionId,
    }));
  },
  setPhase(sessionId, phase) {
    set((state) => {
      const entry = state.moves[sessionId];
      if (!entry) return state;
      return { moves: { ...state.moves, [sessionId]: { ...entry, phase } } };
    });
  },
  show(sessionId) {
    if (get().moves[sessionId]) set({ shown: sessionId });
  },
  hide() {
    set({ shown: null });
  },
  remove(sessionId) {
    const entry = get().moves[sessionId];
    entry?.run.dispose();
    set((state) => {
      const { [sessionId]: _gone, ...rest } = state.moves;
      return { moves: rest, shown: state.shown === sessionId ? null : state.shown };
    });
  },
  reset() {
    for (const entry of Object.values(get().moves)) entry.run.dispose();
    set({ moves: {}, shown: null });
  },
}));

/** Whether a phase is a move still under way (keep-awake, the deadline):
 *  carrying it forward, or putting it back. */
export function moveUnderWay(phase: MovePhase): boolean {
  return (
    phase.step === "beginning" ||
    phase.step === "stopping" ||
    phase.step === "copying" ||
    phase.step === "starting" ||
    phase.step === "restoring"
  );
}
