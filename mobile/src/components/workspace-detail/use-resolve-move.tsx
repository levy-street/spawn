import { useCallback, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { moveHostOf } from "@/components/workspace-detail/move-channels";
import type { MoveHost } from "@/components/workspace-detail/move-conversation";
import * as copy from "@/components/workspace-detail/move-copy";
import {
  giveUpMove,
  type ResolveDeps,
  type ResolveOutcome,
  resolveMove,
  resolveToast,
} from "@/components/workspace-detail/move-resolve";
import { MoveResolveSheet, type MoveResolveState } from "@/components/workspace-detail/move-sheets";
import { sessionAgent } from "@/data/selectors/agent";
import { useMovesStore } from "@/data/stores/moves";
import type { AgentDef, Host, Session } from "@/data/types/domain";

/** Something to resolve that is not a moving window of this account: a
 *  transfer the host's page lists (`settleLeftover`). */
export interface ResolveTask {
  readonly sourceName: string;
  /** The window, when it still reads "moving" (giving up needs one). */
  readonly session: Session | null;
  readonly work: () => Promise<ResolveOutcome>;
}

/**
 * Resolve, wherever a window that reads "moving" offers it: the full-screen
 * window, the pane's ⋯ sheet, the host page's unfinished moves. It asks
 * before it acts and says what it will do (`MoveResolveSheet`); a host that
 * cannot answer leaves the move as it is, with "Give up the move" on offer.
 * A move this device is still carrying shows its own progress instead.
 */
export function useResolveMove({
  agents,
  hosts,
  deps,
  onResolving,
  onSettled,
  openWindow,
}: {
  agents: readonly AgentDef[];
  hosts: readonly Host[];
  /** The move's ports (`createMoveDeps`), made once by the caller. */
  deps: ResolveDeps;
  /** Resolve was confirmed: this device may be about to finish the move
   *  and type its resume. */
  onResolving?: (session: Session) => void;
  /** It ended — the caller refreshes what it lists. `finished` when this
   *  device finished it and the window runs on its new host. */
  onSettled?: (session: Session | null, outcome: ResolveOutcome) => void;
  /**
   * For a screen that does not show the window (a host's page): a move this
   * device settled leaves the window's resume queued here, and the toast
   * says it resumes when the window is opened, with this to open it. Screens
   * that show the window open it themselves (`onSettled`).
   */
  openWindow?: (session: Session) => void;
}): {
  open: (session: Session) => void;
  openTask: (task: ResolveTask) => void;
  sheet: React.JSX.Element;
} {
  const toast = useToast();
  const [task, setTask] = useState<ResolveTask | null>(null);
  const [state, setState] = useState<MoveResolveState>({ kind: "confirm" });
  const working = useRef(false);
  const session = task?.session ?? null;

  const hostMap = useMemo(
    () => new Map<string, MoveHost>(hosts.map((host) => [host.id, moveHostOf(host)])),
    [hosts],
  );

  const openTask = useCallback((next: ResolveTask) => {
    setTask(next);
    setState({ kind: "confirm" });
  }, []);

  const open = useCallback(
    (candidate: Session) => {
      // This device's own move: its sheet says where it stands.
      if (useMovesStore.getState().moves[candidate.id]) {
        useMovesStore.getState().show(candidate.id);
        return;
      }
      openTask({
        sourceName:
          hostMap.get(candidate.host_id)?.name ?? candidate.host_name ?? copy.MOVE_ANOTHER_HOST,
        session: candidate,
        work: () => {
          onResolving?.(candidate);
          return resolveMove(
            { session: candidate, agent: sessionAgent(candidate, agents), hosts: hostMap },
            deps,
          );
        },
      });
    },
    [agents, deps, hostMap, onResolving, openTask],
  );

  const close = useCallback(() => {
    if (working.current) return;
    setTask(null);
    setState({ kind: "confirm" });
  }, []);

  const settle = useCallback(
    (target: Session | null, outcome: ResolveOutcome) => {
      onSettled?.(target, outcome);
      const said = resolveToast(
        outcome,
        (hostId) => hostMap.get(hostId)?.name ?? copy.MOVE_ANOTHER_HOST,
        openWindow !== undefined,
      );
      if (said) {
        const window = said.openWindow;
        toast.success(said.message, {
          ...(said.detail ? { detail: said.detail } : {}),
          ...(said.persistent ? { persistent: true } : {}),
          ...(window && openWindow
            ? { actions: [{ label: copy.MOVE_OPEN_WINDOW, onPress: () => openWindow(window) }] }
            : {}),
        });
        setTask(null);
        setState({ kind: "confirm" });
        return;
      }
      // A host that cannot answer, files that need a person, a refusal:
      // the sheet says so, and what can still be done.
      setState({ kind: "outcome", outcome });
    },
    [hostMap, onSettled, openWindow, toast],
  );

  const run = useCallback(
    async (work: () => Promise<ResolveOutcome>) => {
      if (!task || working.current) return;
      working.current = true;
      setState({ kind: "resolving" });
      let outcome: ResolveOutcome;
      try {
        outcome = await work();
      } catch {
        outcome = { kind: "failed", message: copy.MOVE_RESOLVE_FAILED };
      } finally {
        working.current = false;
      }
      settle(task.session, outcome);
    },
    [settle, task],
  );

  const giveUp = useCallback(() => {
    const offered =
      state.kind === "outcome" && state.outcome.kind === "unreachable"
        ? state.outcome.giveUp
        : null;
    const target = task?.session;
    if (!offered || !task || !target) return;
    void run(() => giveUpMove(target, task.sourceName, deps));
  }, [deps, run, state, task]);

  const sheet = (
    <MoveResolveSheet
      canGiveUp={session?.status === "moving"}
      onDismiss={close}
      onGiveUp={giveUp}
      onResolve={() => {
        if (task) void run(task.work);
      }}
      sourceName={task?.sourceName ?? ""}
      state={state}
      visible={task !== null}
    />
  );
  return { open, openTask, sheet };
}
