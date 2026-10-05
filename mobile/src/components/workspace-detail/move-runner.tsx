import { useQuery, useQueryClient } from "@tanstack/react-query";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { type Href, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useToast } from "@/components/ui/toast";
import type { MoveAction, MoveRun } from "@/components/workspace-detail/move-conversation";
import * as copy from "@/components/workspace-detail/move-copy";
import { MoveProgressSheet, moveStepLine } from "@/components/workspace-detail/move-sheets";
import { moveWindowFresh } from "@/components/workspace-detail/move-window";
import { getHost } from "@/data/api/endpoints/hosts";
import { listSessions } from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import { isMovingSession } from "@/data/selectors/session";
import {
  holdsWindowMoving,
  moveUnderWay,
  resolvedUnderneath,
  useMovesStore,
} from "@/data/stores/moves";
import { subscribeDeviceIdentityAccount } from "@/lib/crypto/identity";

const KEEP_AWAKE_TAG = "spawn-move-conversation";
/** The host connections retire this long after the app leaves the screen
 *  (`HostTransportSurface`); a move cannot outlive them. */
export const MOVE_BACKGROUND_DEADLINE_MS = 3_000;

/**
 * Register a confirmed move and start it. The runner below follows it from
 * here wherever the person goes.
 */
export function launchMove(run: MoveRun): void {
  const store = useMovesStore.getState();
  store.add(run);
  run.subscribe((phase) => useMovesStore.getState().setPhase(run.sessionId, phase));
  void run.start();
}

function names(run: MoveRun) {
  return { from: run.plan.request.from.name, to: run.plan.request.to.name };
}

/**
 * Runs the moves this device carries, for the whole signed-in app: mounted
 * once beside the navigator (as the transfer runner is), so a move goes on
 * while the person moves between screens. It keeps the screen awake while
 * one is under way, because a phone that locks takes SPAWN D off the screen
 * and its host connections with it; past the three-second background
 * deadline it stops a move where it is — held, nothing lost — and says so
 * on return (checked on the return too, since the runtime can pause
 * timers). A move whose target had already committed is finished on return
 * without asking: from there it only goes forward. When a move lands, the
 * moved window opens full screen — the opening takes control of the new
 * incarnation, so the resume line and the note can be typed into it.
 */
export function MoveRunner(): React.JSX.Element | null {
  const toast = useToast();
  const router = useRouter();
  const client = useQueryClient();
  const moves = useMovesStore((state) => state.moves);
  const shown = useMovesStore((state) => state.shown);
  const [busy, setBusy] = useState(false);
  const announced = useRef(new Set<string>());
  const hiddenToast = useRef<string | null>(null);
  const underWay = Object.values(moves).some((entry) => moveUnderWay(entry.phase));

  useEffect(() => subscribeDeviceIdentityAccount(() => useMovesStore.getState().reset()), []);

  // A move held "moving" here that another device or a host's page has
  // settled since: its sheet would say the window stays moving, untrue, and
  // Try again would chase a transfer that is gone. Once the server's row,
  // seen moving while it was held, no longer is, the move is let go. The
  // rows are read while anything is held.
  const held = Object.values(moves).filter(
    (entry) => holdsWindowMoving(entry.phase) && !entry.run.running,
  );
  const rows = useQuery({
    queryKey: qk.sessions(),
    queryFn: () => listSessions(),
    enabled: held.length > 0,
    refetchInterval: held.length > 0 ? 5_000 : false,
  });
  const seenMoving = useRef(new Map<string, string | null>());
  useEffect(() => {
    for (const [sessionId, entry] of Object.entries(moves)) {
      const card =
        holdsWindowMoving(entry.phase) && !entry.run.running
          ? `${sessionId}:${entry.run.transferId}`
          : null;
      const row = rows.data?.find((session) => session.id === sessionId);
      if (card !== null && !row) continue;
      const next = resolvedUnderneath(
        card,
        row ? isMovingSession(row) : false,
        seenMoving.current.get(sessionId) ?? null,
      );
      seenMoving.current.set(sessionId, next.seen);
      if (next.dismiss) useMovesStore.getState().remove(sessionId);
    }
  }, [moves, rows.data]);

  useEffect(() => {
    if (!underWay) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    };
  }, [underWay]);

  useEffect(() => {
    let leftAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const interruptUnderWay = () => {
      for (const entry of Object.values(useMovesStore.getState().moves)) {
        if (moveUnderWay(entry.phase)) entry.run.interrupt();
      }
    };
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") {
        leftAt = Date.now();
        timer ??= setTimeout(() => {
          timer = null;
          interruptUnderWay();
        }, MOVE_BACKGROUND_DEADLINE_MS);
        return;
      }
      if (next !== "active") return;
      if (timer) clearTimeout(timer);
      timer = null;
      const away = leftAt === null ? 0 : Date.now() - leftAt;
      leftAt = null;
      if (away >= MOVE_BACKGROUND_DEADLINE_MS) interruptUnderWay();
      // Committed before the phone left: it only goes forward.
      for (const entry of Object.values(useMovesStore.getState().moves)) {
        if (entry.phase.step === "failed" && entry.run.committed && !entry.run.running) {
          void entry.run.retry();
        }
      }
    });
    return () => {
      subscription.remove();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // What a move's end means for the rest of the app.
  useEffect(() => {
    for (const [sessionId, entry] of Object.entries(moves)) {
      const { phase, run } = entry;
      const key = `${sessionId}:${phase.step}`;
      if (phase.step === "done" && !announced.current.has(key)) {
        announced.current.add(key);
        void client.invalidateQueries({ queryKey: qk.sessions() });
        const { to } = names(run);
        toast.success(
          phase.outcome === "archived"
            ? copy.moveDoneArchived(to)
            : phase.outcome === "landed"
              ? copy.moveLanded(to)
              : phase.state === "idle"
                ? copy.moveDoneIdle(to)
                : copy.moveDoneWorking(to),
        );
        useMovesStore.getState().remove(sessionId);
        // Opened only where this device's commit made the incarnation: the
        // opening takes control, and the resume is this device's to type. A
        // move another device finished is that device's to open.
        if (phase.outcome === "launched") router.push(`/terminal/${sessionId}` as Href);
      } else if (
        (phase.step === "failed" || phase.step === "restored") &&
        !announced.current.has(key)
      ) {
        announced.current.add(key);
        void client.invalidateQueries({ queryKey: qk.sessions() });
        // A failure or a put-back is told on the sheet, brought back if the
        // person had put it away.
        if (useMovesStore.getState().shown !== sessionId) useMovesStore.getState().show(sessionId);
      } else if (moveUnderWay(phase)) {
        for (const step of ["failed", "restored"]) announced.current.delete(`${sessionId}:${step}`);
      }
    }
  }, [client, moves, router, toast]);

  const entry = shown ? (moves[shown] ?? null) : null;
  // A sheet put away while its move runs leaves a notice that follows it.
  const hiddenUnderWay = Object.values(moves).find(
    (candidate) => moveUnderWay(candidate.phase) && candidate.run.sessionId !== shown,
  );
  useEffect(() => {
    if (!hiddenUnderWay) {
      if (hiddenToast.current) toast.dismiss(hiddenToast.current);
      hiddenToast.current = null;
      return;
    }
    const message = copy.moveProgressTitle(names(hiddenUnderWay.run).to);
    const detail = moveStepLine(hiddenUnderWay.phase, names(hiddenUnderWay.run)) ?? undefined;
    const progress =
      hiddenUnderWay.phase.step === "copying" && hiddenUnderWay.phase.total > 0
        ? hiddenUnderWay.phase.sent / hiddenUnderWay.phase.total
        : ("indeterminate" as const);
    const sessionId = hiddenUnderWay.run.sessionId;
    if (hiddenToast.current) {
      toast.update(hiddenToast.current, { ...(detail ? { detail } : {}), progress });
    } else {
      hiddenToast.current = toast.show(message, {
        ...(detail ? { detail } : {}),
        persistent: true,
        progress,
        actions: [
          { label: copy.MOVE_SHOW, onPress: () => useMovesStore.getState().show(sessionId) },
        ],
      });
    }
  }, [hiddenUnderWay, toast]);

  if (!entry) return null;
  const { run, phase } = entry;
  const label = names(run);

  const act = async (action: MoveAction) => {
    const store = useMovesStore.getState();
    if (action === "close") {
      // Removing the run disposes it, which drops a resume line still
      // waiting on a commit that never answered.
      store.remove(run.sessionId);
      return;
    }
    setBusy(true);
    try {
      if (action === "retry") await run.retry();
      else if (action === "give_up") await run.giveUp();
      else if (action === "take_there") await run.takeThere();
      else if (action === "resume_source") {
        await run.putBack();
        if (run.phase.step === "restored") {
          store.remove(run.sessionId);
          router.push(`/terminal/${run.sessionId}` as Href);
        }
      } else if (action === "start_fresh") {
        const { session, to, cwd, agent } = run.plan.request;
        const host = await client.ensureQueryData({
          queryKey: qk.host(to.id),
          queryFn: () => getHost(to.id),
        });
        store.remove(run.sessionId);
        await moveWindowFresh(client, session, host, cwd, [agent]);
        router.push(`/terminal/${session.id}` as Href);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.MOVE_COMMIT_FAILED);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MoveProgressSheet
      busy={busy}
      cancellable={!run.committed && phase.step !== "restoring"}
      names={label}
      onAction={(action) => void act(action)}
      onCancel={() => run.cancel()}
      onHide={() => {
        if (moveUnderWay(phase)) useMovesStore.getState().hide();
        else if (phase.step === "failed" || phase.step === "restored") {
          useMovesStore.getState().remove(run.sessionId);
        } else useMovesStore.getState().hide();
      }}
      phase={phase}
      visible
    />
  );
}
