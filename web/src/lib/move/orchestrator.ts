/**
 * One move of a Claude Code window to another host with its conversation,
 * driven by the device that moves it (the contract both D2 and the server
 * wrote for M6; proto/README.md, "The conversation carrier").
 *
 *   begin (server: "moving") → export (source: retire, the single-writer
 *   fence) → import (target: staging) → pump → stream.committed →
 *   retire.commit (source) → commit (server: rebind, launch there) → the
 *   relaunch line and note, typed by the device that holds the new
 *   incarnation.
 *
 * Every failure is one of two kinds, and the line between them is the
 * target's `stream.committed`:
 *
 * - Before it, the move can be put back: cancel the import on the target
 *   and wait for `cancelled`, abort the retire on the source (which puts
 *   the files back), abort on the server, and restart the window on the
 *   source when the retire stopped it. A host that cannot be reached for
 *   its half leaves the move unresolved — the window stays "moving" with
 *   Resolve — rather than guessed at.
 * - After it, the move is never aborted: it is finished, the server commit
 *   retried until it lands. A commit the server refuses as already settled
 *   is read again rather than believed (`server.ts`): a move put back
 *   underneath this carry by another device is begun again and committed,
 *   and a window that cannot follow its conversation is said so, with the
 *   offer to take it there.
 *
 * A carry whose channel goes is resumed, not restarted: the target's
 * `conv.import.status` says where it stands and the source re-exports from
 * there under the same transfer id.
 *
 * Nothing here touches React, the network or a timer it does not own: hosts,
 * server and launcher are ports, so the whole failure matrix runs in unit
 * tests against a fake daemon pair and a fake server (`orchestrator.test.ts`).
 */

import { planRelaunch, type RelaunchAgent, type RelaunchPlan } from "@/lib/agent-relaunch";
import { type ConversationState, canonicalConversationId } from "@/lib/conversation";
import { type BulkGate, CarryError, carryConversation } from "./carrier";
import {
  abortRetire,
  type CarrierClient,
  cancelImport,
  commitRetire,
  type ExportDeclaration,
  errorCode,
  importStatus,
  listTransfers,
  outcomeUnknown,
  type TransferStatus,
} from "./conv";
import { putBackLine, readPutBackFacts } from "./put-back";
import {
  type MoveServerPort,
  readAfterCommitConflict,
  serverCode,
  takeWindowThere,
} from "./server";

export type { MoveServerPort } from "./server";

/** One end of a move, as the device knows it. */
export interface MoveEnd {
  hostId: string;
  /** The host's name, from the server's row. */
  name: string;
  /** The host's OS, from the server's row. */
  os: string | null;
  /** The folder: the window's on the source, the one picked on the target. */
  cwd: string;
}

/** Everything the person confirmed, and the facts the dialog gathered. */
export interface MovePlan {
  /** The transfer id: a UUIDv4 this device chose, naming the move on both hosts. */
  transferId: string;
  sessionId: string;
  agent: RelaunchAgent;
  conversationId: string;
  source: MoveEnd;
  target: MoveEnd;
  /** `conv.inspect`'s state when the person confirmed. */
  state: ConversationState;
  /** The permission mode Claude Code starts in on the target. */
  permissionMode: string;
  /** The target's login shell (`conv.probe`), which spells the line. */
  targetShell: string | null;
  /** The target's memory folder (`conv.probe`), for the note. */
  memoryPath: string | null;
  /** Whether the window was running when the move began: a stopped window
   *  stays stopped when a move is put back. */
  wasRunning: boolean;
}

/** A dedicated consumer channel to each host, opened on demand. */
export interface MoveHostsPort {
  /** A ready client for the host, or a rejection once it cannot be had. */
  source(): Promise<CarrierClient>;
  target(): Promise<CarrierClient>;
  /** Forget a client whose channel went, so the next call opens a fresh one. */
  reset(side: "source" | "target"): void;
}

/** Who types what the move leaves to type. */
export interface MoveLauncherPort {
  /** Before the commit: the line and note are queued for the window as it
   *  will run on the target, and its terminal there takes control. */
  prepare(plan: RelaunchPlan | null): Promise<void>;
  /** The commit did not happen, or nothing should be typed: drop the queue. */
  abandon(): void;
  /** Put back: restart the window on the source, `line` queued for this
   *  device to type there — it takes the window's display to do it — or,
   *  when no line could be said, the ordinary restart. */
  restartOnSource(line: string | null): Promise<void>;
  /** The server's picture of the window may be stale. */
  refetch(): void;
}

export interface MovePorts {
  server: MoveServerPort;
  hosts: MoveHostsPort;
  launcher: MoveLauncherPort;
  gate?: BulkGate;
  sleep?: (ms: number) => Promise<void>;
  /** How long a carry may hear nothing before it is lost. */
  silenceMs?: number;
  /** Reads at most `limit` bytes of a file on a host as text (`fs.read`):
   *  the source's settings, for the mode a put-back resumes in. */
  readText?: (client: CarrierClient, path: string, limit: number) => Promise<string | null>;
}

export type MovePhase =
  /** Asking the server to mark the window moving. */
  | "starting"
  /** The source is stopping Claude Code and setting its files aside. */
  | "stopping"
  /** Bytes are moving. */
  | "copying"
  /** The target has the conversation: settling the source and the server. */
  | "finishing"
  /** Done: the window runs on the target and the relaunch is queued. */
  | "moved"
  /** Stopped with the person's choice to make; the window is still moving. */
  | "paused"
  /** Putting the conversation back on the source. */
  | "putting_back"
  /** Over: nothing was moved, or it was put back, or someone else settled it. */
  | "ended";

/** Why a move stopped, for the copy (`lib/move/copy.ts`). */
export type MoveFailure =
  // begin
  | "source_offline"
  | "move_in_progress"
  | "move_conflict"
  | "workspace_archived"
  | "gone"
  | "begin_failed"
  // the source's export
  | "conversation_live_elsewhere"
  | "conversation_changed"
  | "agent_still_running"
  | "window_restarted"
  | "window_unavailable"
  | "transfer_unresolved"
  | "too_large"
  | "too_many_tasks"
  | "export_failed"
  // the target's import, or the pump
  | "conversation_live_here"
  | "folder_missing"
  | "store_missing"
  | "insufficient_space"
  | "too_many_transfers"
  | "integrity_mismatch"
  | "file_changed"
  | "connection_lost"
  | "copy_failed"
  | "cancelled"
  // after the target committed
  | "commit_target_offline"
  | "commit_failed"
  | "resolved_elsewhere"
  /** The conversation is on the target, the window is not (put back
   *  underneath the carry and not to be begun again). */
  | "conversation_on_target"
  // putting back
  | "unresolved_source"
  | "unresolved_target"
  /** The server would not take the move off the window yet (its abort
   *  failed): the window stays moving for Resolve. */
  | "abort_failed";

/** How a move that ended left the window. */
export type MoveOutcome =
  /** Moved; the relaunch is queued on the target. */
  | "moved"
  /** Moved into an archived workspace: it starts when that is restored. */
  | "moved_archived"
  /** Moved, but the window was closed before the launch went out. */
  | "moved_gone"
  /** Nothing moved; the window carries on where it was. */
  | "untouched"
  /** Put back and running on the source as before. */
  | "put_back"
  /** Put back and restarted on the source. */
  | "put_back_restarted"
  /** Put back; the window was stopped before the move and stays stopped. */
  | "put_back_stopped"
  /** Another device finished or put back the move. */
  | "elsewhere"
  /** Left "moving" for Resolve: a host it needed could not be reached. */
  | "unresolved"
  /** The conversation is on the target and the window is not. */
  | "on_target";

export type MoveAction =
  | "cancel"
  | "retry"
  | "resume_source"
  | "start_fresh"
  | "resolve"
  /** The conversation is on the target: move the window there to it. */
  | "take_there";

export interface MoveView {
  transferId: string;
  sessionId: string;
  phase: MovePhase;
  /** Bytes the target has taken, and the bundle's length (0 until known). */
  bytes: number;
  total: number;
  failure: MoveFailure | null;
  /** The host's own words for a failure, where it gave some. */
  detail: string | null;
  outcome: MoveOutcome | null;
  /** Files a put-back found already in place: resolve by hand. */
  conflicts: boolean;
  /** What the person can do now. */
  actions: MoveAction[];
}

/** How many times a lost carry resumes on its own before it asks. */
const AUTO_RESUMES = 3;
/** Waits between server commits the target's absence refused. */
const COMMIT_BACKOFF_MS = [1_000, 2_000, 4_000];
/** How many times a move put back underneath its carry is begun again. */
const MAX_REBEGINS = 3;

const EXPORT_REFUSALS: ReadonlyMap<string, MoveFailure> = new Map([
  ["conversation_live_elsewhere", "conversation_live_elsewhere"],
  ["conversation_changed", "conversation_changed"],
  ["agent_still_running", "agent_still_running"],
  ["window_restarted", "window_restarted"],
  ["window_unavailable", "window_unavailable"],
  ["transfer_unresolved", "transfer_unresolved"],
  ["too_large", "too_large"],
  ["store_too_large", "too_large"],
  ["too_many_tasks", "too_many_tasks"],
]);

const CARRY_FAILURES: ReadonlyMap<string, MoveFailure> = new Map([
  ["conversation_live_here", "conversation_live_here"],
  ["folder_missing", "folder_missing"],
  ["outside_root", "folder_missing"],
  ["store_missing", "store_missing"],
  ["store_unavailable", "store_missing"],
  ["insufficient_space", "insufficient_space"],
  ["too_many_transfers", "too_many_transfers"],
  ["too_many_streams", "too_many_transfers"],
  ["integrity_mismatch", "integrity_mismatch"],
  ["file_changed", "file_changed"],
  ["too_many_tasks", "too_many_tasks"],
]);

export class MoveOrchestrator {
  private view: MoveView;
  private readonly sleep: (ms: number) => Promise<void>;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  /** The export answered once: the source's retire ran. */
  private exported = false;
  /** An export was sent and its answer never came: it may have run. */
  private exportUncertain = false;
  /** The source said it stopped the window (`stopped`, `lingering`). */
  private stoppedByRetire = false;
  /** A begin was sent to the target: it may hold staging. */
  private importBegun = false;
  private length: number | null = null;
  private digest: string | null = null;
  private nextSequence = 0;
  /** What the target committed: from here on the move only finishes. */
  private committed: {
    length: number;
    sha256: string;
    cwd: string | null;
    memory: string | null;
  } | null = null;
  private retireCommitted = false;
  /** A carried commit's answer never came: it may have landed. */
  private commitUncertain = false;
  /** The person cancelled: the put-back is under way. */
  private cancelling = false;

  constructor(
    readonly plan: MovePlan,
    private readonly ports: MovePorts,
    private readonly emit: (view: MoveView) => void = () => {},
  ) {
    this.sleep = ports.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.view = {
      transferId: plan.transferId,
      sessionId: plan.sessionId,
      phase: "starting",
      bytes: 0,
      total: 0,
      failure: null,
      detail: null,
      outcome: null,
      conflicts: false,
      actions: [],
    };
  }

  getView(): MoveView {
    return this.view;
  }

  private update(patch: Partial<MoveView>): void {
    this.view = { ...this.view, ...patch };
    this.emit(this.view);
  }

  /** Start the move. Resolves when it has moved, paused, or ended. */
  start(): Promise<void> {
    this.running ??= this.guard(() => this.begin());
    return this.running;
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      // Nothing above throws on purpose; an unexpected one leaves the move
      // for Resolve rather than in a phase that claims progress.
      this.update({
        phase: "paused",
        failure: this.committed ? "commit_failed" : "copy_failed",
        detail: error instanceof Error ? error.message : String(error),
        actions: this.committed ? ["retry"] : ["retry", "resume_source"],
      });
    }
  }

  // ---- the person's choices --------------------------------------------------------

  /** Cancel while copying, or give up a paused move: put it back. Refused
   *  once the target has committed — from there the move only finishes. */
  cancel(): Promise<void> {
    if (this.committed) return Promise.resolve();
    if (this.view.phase === "copying" || this.view.phase === "stopping") {
      // Said at once: a retire under way is waited for (it cannot be
      // stopped part-way), and then put back.
      this.cancelling = true;
      this.update({ phase: "putting_back", failure: "cancelled", actions: [] });
      this.controller?.abort();
      return this.running ?? Promise.resolve();
    }
    if (this.view.phase === "paused") {
      this.running = this.guard(() => this.putBack("cancelled"));
      return this.running;
    }
    return Promise.resolve();
  }

  /** Paused: carry on from where it stands — the copy, or the commit. */
  retry(): Promise<void> {
    if (this.view.phase !== "paused") return Promise.resolve();
    this.running = this.guard(async () => {
      if (this.committed) {
        await this.finish();
        return;
      }
      this.update({ phase: "copying", failure: null, detail: null, actions: ["cancel"] });
      if (await this.readBack()) await this.carry();
    });
    return this.running;
  }

  /** Paused before the target committed: put the conversation back — the
   *  person's choice, so it ends as a cancel, whatever had paused it. */
  resumeOnSource(): Promise<void> {
    if (this.view.phase !== "paused" || this.committed) return Promise.resolve();
    this.running = this.guard(() => this.putBack("cancelled"));
    return this.running;
  }

  /** The conversation is on the target and the window is not: take the
   *  window there, into its conversation (a fresh move naming it). */
  takeThere(): Promise<void> {
    const committed = this.committed;
    if (!committed || !this.view.actions.includes("take_there")) return Promise.resolve();
    this.running = this.guard(async () => {
      this.update({ phase: "finishing", failure: null, detail: null, actions: [] });
      const plan = this.relaunchPlan(committed);
      const result = await takeWindowThere(
        this.ports.server,
        {
          prepare: () => this.ports.launcher.prepare(plan),
          abandon: () => this.ports.launcher.abandon(),
        },
        {
          sessionId: this.plan.sessionId,
          targetHostId: this.plan.target.hostId,
          cwd: this.plan.target.cwd,
          conversationId: canonicalConversationId(this.plan.conversationId) ?? "",
        },
      );
      this.ports.launcher.refetch();
      if (result === "moved" || result === "arrived") {
        this.update({ phase: "moved", outcome: "moved", actions: [] });
        return;
      }
      if (result === "gone") return this.end("moved_gone", null);
      const failure: MoveFailure =
        result === "move_in_progress" || result === "workspace_archived"
          ? result
          : result === "target_offline"
            ? "commit_target_offline"
            : "conversation_on_target";
      this.end("on_target", failure, ["take_there"]);
    });
    return this.running;
  }

  // ---- the steps ---------------------------------------------------------------------

  private end(outcome: MoveOutcome, failure: MoveFailure | null, actions: MoveAction[] = []): void {
    this.update({ phase: "ended", outcome, failure, actions });
  }

  private async begin(): Promise<void> {
    this.update({ phase: "starting" });
    try {
      await this.ports.server.begin(this.plan.sessionId, this.plan.source.hostId);
    } catch (error) {
      const code = serverCode(error);
      if (code === "source_offline")
        return this.end("untouched", "source_offline", ["start_fresh"]);
      if (code === "move_in_progress")
        return this.end("untouched", "move_in_progress", ["resolve"]);
      if (code === "move_conflict") {
        this.ports.launcher.refetch();
        return this.end("untouched", "move_conflict");
      }
      if (code === "workspace_archived") return this.end("untouched", "workspace_archived");
      if (code === "not_found") return this.end("untouched", "gone");
      return this.end("untouched", "begin_failed", ["retry"]);
    }
    this.update({ phase: "stopping", actions: ["cancel"] });
    await this.carry();
  }

  /** Carry until the target commits, resuming a lost channel on its own a few times. */
  private async carry(): Promise<void> {
    let losses = 0;
    for (;;) {
      this.controller = new AbortController();
      // A cancel that came before this carry had anything to abort.
      if (this.cancelling) this.controller.abort();
      let source: CarrierClient;
      let target: CarrierClient;
      try {
        [source, target] = await Promise.all([
          this.ports.hosts.source(),
          this.ports.hosts.target(),
        ]);
      } catch {
        losses += 1;
        if (losses <= AUTO_RESUMES) {
          await this.sleep(1_000 * losses);
          continue;
        }
        return this.pause("connection_lost", null);
      }
      if (!this.exported) this.exportUncertain = true;
      try {
        const result = await carryConversation({
          source,
          target,
          sourceHostId: this.plan.source.hostId,
          targetHostId: this.plan.target.hostId,
          transferId: this.plan.transferId,
          conversationId: this.plan.conversationId,
          sessionId: this.plan.sessionId,
          sourceCwd: this.plan.source.cwd,
          targetCwd: this.plan.target.cwd,
          fromSequence: this.nextSequence,
          knownLength: this.length,
          onExported: (declaration) => this.exportedOnce(declaration),
          onProgress: (bytes, total) => this.update({ bytes, total }),
          onDigest: (sha256) => {
            this.digest = sha256;
          },
          signal: this.controller.signal,
          ...(this.ports.gate ? { gate: this.ports.gate } : {}),
          ...(this.ports.silenceMs ? { silenceMs: this.ports.silenceMs } : {}),
        });
        this.committed = {
          length: result.length,
          sha256: result.sha256,
          cwd: result.result.cwd,
          memory: result.result.memory,
        };
        await this.finish();
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Where the cancel caught it is not known: an import may have begun.
          if (this.exported) this.importBegun = true;
          await this.putBack("cancelled");
          return;
        }
        if (!(error instanceof CarryError)) throw error;
        if (error.stage === "import" || error.stage === "pump") this.importBegun = true;
        if (error.lost) {
          this.ports.hosts.reset(error.side === "target" ? "target" : "source");
          if (error.side === "device") {
            this.ports.hosts.reset("source");
            this.ports.hosts.reset("target");
          }
          losses += 1;
          if (losses > AUTO_RESUMES) return this.pause("connection_lost", null);
          await this.sleep(500 * losses);
          if (!(await this.readBack())) return;
          continue;
        }
        if (error.stage === "export" && !this.exported) {
          // The source refused before any byte moved: the fence put back
          // whatever it had touched, so there is nothing to carry back.
          this.exportUncertain = false;
          return this.exportRefused(error.code, error.message);
        }
        if (error.stage === "export") {
          // A resumed export refused: the source still holds the files
          // aside, for a retry or an abort.
          return this.pause(EXPORT_REFUSALS.get(error.code) ?? "copy_failed", error.message);
        }
        if (error.code === "cancelled" || error.code === "transfer_cancelled") {
          // The import was cancelled there — another device resolving the
          // move. Its half on the source is theirs to settle.
          return this.end("elsewhere", "resolved_elsewhere");
        }
        if (error.code === "superseded") {
          // Another device resumed this transfer: it is carrying it now.
          return this.end("elsewhere", "resolved_elsewhere");
        }
        if (error.code === "transfer_committed") {
          // The target committed already: read back what, and finish.
          if (await this.readBack()) continue;
          return;
        }
        return this.pause(CARRY_FAILURES.get(error.code) ?? "copy_failed", error.message);
      }
    }
  }

  private exportedOnce(declaration: ExportDeclaration): void {
    this.exported = true;
    this.exportUncertain = false;
    this.length = declaration.length;
    if (declaration.stopped === "stopped" || declaration.stopped === "lingering")
      this.stoppedByRetire = true;
    if (this.cancelling) this.update({ total: declaration.length });
    else this.update({ phase: "copying", total: declaration.length, actions: ["cancel"] });
  }

  private pause(failure: MoveFailure, detail: string | null): void {
    this.update({
      phase: "paused",
      failure,
      detail,
      actions: this.committed ? ["retry"] : ["retry", "resume_source"],
    });
  }

  /**
   * After a lost channel: where does the transfer stand? True to carry on
   * from `nextSequence`; false when this settled the move another way.
   */
  private async readBack(): Promise<boolean> {
    let target: CarrierClient;
    try {
      target = await this.ports.hosts.target();
    } catch {
      this.pause("connection_lost", null);
      return false;
    }
    let status: Awaited<ReturnType<typeof importStatus>>;
    try {
      status = await importStatus(target, this.plan.transferId);
    } catch (error) {
      if (outcomeUnknown(error)) this.ports.hosts.reset("target");
      this.pause("connection_lost", null);
      return false;
    }
    if (status.state === "committed") {
      const committed = await this.committedLength();
      if (!committed) {
        this.pause("connection_lost", null);
        return false;
      }
      this.committed = { ...committed, cwd: null, memory: null };
      await this.finish();
      return false;
    }
    if (status.state === "cancelled") {
      // Someone cancelled it there — another device resolving the move.
      // The source half is theirs to settle; this device stops.
      this.end("elsewhere", "resolved_elsewhere");
      return false;
    }
    if (status.state === "absent") {
      // Never begun there, or forgotten (bytes that failed their digest).
      this.nextSequence = 0;
      return true;
    }
    this.importBegun = true;
    this.nextSequence = status.nextSequence;
    return true;
  }

  /** What the target committed when its own answer was lost: the length and
   *  the source's digest, from this device's memory or the source's record. */
  private async committedLength(): Promise<{ length: number; sha256: string } | null> {
    if (this.length !== null && this.digest) return { length: this.length, sha256: this.digest };
    try {
      const source = await this.ports.hosts.source();
      const transfers = await listTransfers(source);
      const outgoing = transfers.outgoing.find(
        (entry) => entry.transferId === this.plan.transferId,
      );
      if (outgoing?.length != null && outgoing.sha256)
        return { length: outgoing.length, sha256: outgoing.sha256 };
    } catch {
      // Unreachable: the commit waits for the source to come back.
    }
    return null;
  }

  private async exportRefused(code: string, detail: string): Promise<void> {
    const failure = EXPORT_REFUSALS.get(code) ?? "export_failed";
    this.update({ phase: "putting_back", failure, detail, actions: [] });
    // A refusal says the fence put back what it had touched — except when
    // putting it back failed too: the transfer is then left stranded on the
    // source under the refusal's own code. So the source is asked, and a
    // transfer it still holds is put back in the contract's order.
    let held: boolean;
    try {
      const source = await this.ports.hosts.source();
      held = (await listTransfers(source)).outgoing.some(
        (entry) => entry.transferId === this.plan.transferId,
      );
    } catch (error) {
      if (outcomeUnknown(error)) this.ports.hosts.reset("source");
      return this.end("unresolved", "unresolved_source", ["resolve"]);
    }
    if (held) {
      this.exportUncertain = true;
      return this.putBack(failure);
    }
    const outcome = await this.abortOnServer();
    if (outcome === null) return;
    const retry: MoveAction[] =
      failure === "agent_still_running" ||
      failure === "conversation_changed" ||
      failure === "window_unavailable" ||
      failure === "too_many_tasks" ||
      failure === "export_failed"
        ? ["retry"]
        : [];
    this.update({ phase: "ended", outcome, failure, detail, actions: retry });
  }

  /**
   * Put the conversation back, in the contract's order: the target first,
   * the source only once the target has said `cancelled`, then the server.
   */
  private async putBack(reason: MoveFailure): Promise<void> {
    this.update({ phase: "putting_back", failure: reason, actions: [] });
    if (this.importBegun || this.exported || this.exportUncertain) {
      // Only the target's own `cancelled` lets the source take its files
      // back: without it the target may have committed, or may yet. An
      // unreachable target leaves the move for Resolve, whether or not an
      // import was begun there.
      let answer: TransferStatus;
      try {
        const target = await this.ports.hosts.target();
        answer = await cancelImport(target, this.plan.transferId);
      } catch (error) {
        if (errorCode(error) === "transfer_committed") {
          // It landed after all: finish instead.
          if (await this.finishCommitted()) return;
        }
        this.ports.hosts.reset("target");
        return this.end("unresolved", "unresolved_target", ["resolve"]);
      }
      if (answer.state === "committed" && (await this.finishCommitted())) return;
      if (answer.state !== "cancelled")
        return this.end("unresolved", "unresolved_target", ["resolve"]);
    }
    let restoredBySource = false;
    if (this.exported || this.exportUncertain) {
      try {
        const source = await this.ports.hosts.source();
        await abortRetire(source, this.plan.transferId);
        restoredBySource = true;
      } catch (error) {
        const code = errorCode(error);
        if (code === "already_exists") {
          restoredBySource = true;
          this.update({ conflicts: true });
        } else if (code !== "transfer_not_found" && code !== "transfer_aborted") {
          // The source holds the conversation aside and cannot be asked to
          // put it back: the window stays moving for Resolve.
          this.ports.hosts.reset("source");
          return this.end("unresolved", "unresolved_source", ["resolve"]);
        }
      }
    }
    // The export's own answer says whether the retire stopped Claude; when
    // that answer was lost, a transfer the source still held says it ran —
    // and stopped the window, if the window was running.
    const outcome = await this.abortOnServer(
      this.stoppedByRetire || (!this.exported && restoredBySource && this.plan.wasRunning),
    );
    if (outcome === null) return;
    this.update({ phase: "ended", outcome, failure: reason, actions: [] });
  }

  /** The target committed after all: finish with what it took. False when
   *  what it committed cannot be read back yet. */
  private async finishCommitted(): Promise<boolean> {
    const committed = await this.committedLength();
    if (!committed) return false;
    this.committed = { ...committed, cwd: null, memory: null };
    await this.finish();
    return true;
  }

  /**
   * End the server's move and bring the window back where it was. Null when
   * the server's answer settled the move some other way (already ended).
   */
  private async abortOnServer(retireStopped = this.stoppedByRetire): Promise<MoveOutcome | null> {
    let status: string;
    try {
      status = (await this.ports.server.abort(this.plan.sessionId, this.plan.source.hostId)).status;
    } catch (error) {
      const code = serverCode(error);
      this.ports.launcher.refetch();
      if (code === "move_conflict") {
        this.end("elsewhere", "resolved_elsewhere");
        return null;
      }
      if (code === "not_found") {
        this.end("untouched", "gone");
        return null;
      }
      // The server, not a host, would not end the move: said as such, and
      // the window stays moving for Resolve.
      this.end("unresolved", "abort_failed", ["resolve"]);
      return null;
    }
    this.ports.launcher.refetch();
    // Restart where the retire stopped Claude, whatever the server saw: a
    // lingering worker reports no exit, and an exit still on its way can
    // land after the abort. A window that was stopped before the move stays
    // stopped, with its ordinary Restart.
    const restart = retireStopped || (status === "killed" && this.plan.wasRunning);
    if (restart) {
      try {
        await this.ports.launcher.restartOnSource(await this.putBackLine());
      } catch {
        // The stopped pane offers Restart itself.
      }
      return "put_back_restarted";
    }
    return status === "killed" ? "put_back_stopped" : "put_back";
  }

  /** The line that resumes the conversation back on the source
   *  (`put-back.ts`), its mode explicit; asked of the source, which has just
   *  answered the abort. */
  private async putBackLine(): Promise<string | null> {
    const source = await this.ports.hosts.source().catch(() => null);
    const facts = await readPutBackFacts(
      source,
      { conversationId: this.plan.conversationId, cwd: this.plan.source.cwd },
      this.ports.readText,
    );
    return putBackLine(this.plan.agent, this.plan.conversationId, facts);
  }

  /** The target has the conversation: settle the source, then the server. */
  private async finish(): Promise<void> {
    const committed = this.committed;
    if (!committed) return;
    this.update({
      phase: "finishing",
      failure: null,
      detail: null,
      actions: [],
      bytes: committed.length,
      total: committed.length,
    });
    if (!this.retireCommitted) {
      // Retired on the source, exactly what the target committed. A failure
      // here leaves the source holding it aside, outside Claude's lookup
      // path; Resolve on any device commits it later. The window moves on.
      try {
        const source = await this.ports.hosts.source();
        await commitRetire(source, {
          transferId: this.plan.transferId,
          length: committed.length,
          sha256: committed.sha256,
        });
        this.retireCommitted = true;
      } catch (error) {
        const code = errorCode(error);
        if (code === "transfer_committed") this.retireCommitted = true;
        else if (outcomeUnknown(error)) this.ports.hosts.reset("source");
      }
    }
    await this.commitCarried(this.relaunchPlan(committed));
  }

  /** The resume line and note for the target, from what it committed. */
  private relaunchPlan(committed: {
    cwd: string | null;
    memory: string | null;
  }): RelaunchPlan | null {
    return planRelaunch({
      agent: this.plan.agent,
      conversation: { resume: this.plan.conversationId },
      permissionMode: this.plan.permissionMode,
      shell: this.plan.targetShell,
      note: {
        from: { name: this.plan.source.name, os: this.plan.source.os },
        to: { name: this.plan.target.name, os: this.plan.target.os },
        cwd: committed.cwd ?? this.plan.target.cwd,
        memoryPath: committed.memory ?? this.plan.memoryPath,
        state: this.plan.state,
      },
    });
  }

  /**
   * The server's carried commit, retried until it lands; never an abort.
   * A refusal as settled is read again (`readAfterCommitConflict`), never
   * believed: the conversation is on the target whatever the row says.
   */
  private async commitCarried(plan: RelaunchPlan | null): Promise<void> {
    let rebegun = 0;
    for (let attempt = 0; ; attempt += 1) {
      await this.ports.launcher.prepare(plan);
      let status: string;
      try {
        status = (
          await this.ports.server.commit(this.plan.sessionId, {
            host_id: this.plan.target.hostId,
            cwd: this.plan.target.cwd,
            expected_host_id: this.plan.source.hostId,
            agent_session_id: canonicalConversationId(this.plan.conversationId) ?? "",
            carried: true,
          })
        ).status;
      } catch (error) {
        const code = serverCode(error);
        if (code === "move_conflict" || code === "move_in_progress") {
          this.ports.launcher.refetch();
          const reading = await readAfterCommitConflict(this.ports.server, {
            sessionId: this.plan.sessionId,
            sourceHostId: this.plan.source.hostId,
            targetHostId: this.plan.target.hostId,
          });
          if (reading === "arrived") {
            // Finished: by an earlier commit of this device whose answer
            // was lost — its relaunch stays queued — or by another device,
            // which typed its own.
            if (!this.commitUncertain) this.ports.launcher.abandon();
            this.update({ phase: "moved", outcome: "moved", failure: null, actions: [] });
            return;
          }
          this.ports.launcher.abandon();
          if (reading === "rebegun" && rebegun < MAX_REBEGINS) {
            // Put back underneath the carry: begun again, committed again.
            rebegun += 1;
            attempt = -1;
            continue;
          }
          if (reading === "gone") return this.end("moved_gone", null);
          if (reading === "unknown") return this.pause("commit_failed", null);
          return this.end("on_target", "conversation_on_target", ["take_there"]);
        }
        this.ports.launcher.abandon();
        if (code === "not_found") {
          this.ports.launcher.refetch();
          return this.end("moved_gone", null);
        }
        if (code === "network") this.commitUncertain = true;
        const delay = COMMIT_BACKOFF_MS[attempt];
        if (delay === undefined) {
          return this.pause(
            code === "target_offline" ? "commit_target_offline" : "commit_failed",
            null,
          );
        }
        await this.sleep(delay);
        continue;
      }
      this.ports.launcher.refetch();
      if (status === "killed") {
        // An archived workspace: the move is complete, nothing is typed.
        this.ports.launcher.abandon();
        return this.end("moved_archived", null);
      }
      this.update({ phase: "moved", outcome: "moved", actions: [] });
      return;
    }
  }
}
