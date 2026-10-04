/**
 * A move runs in the tab that holds this browser's connection to the host it
 * writes to (`lib/daemon-connection.ts`): every SPAWN D tab of a browser
 * shares one connection per host, and a tab that is not its owner reaches
 * the host through the owner, so a carry run anywhere else breaks whenever
 * the owner sleeps or closes. So the tab where the person confirmed hands the
 * move to the target's owner, as transfers do (`lib/files/transfer-hub.ts`),
 * and shows it as if it ran it.
 *
 * What is typed after the move is typed by the tab that asked for it — the
 * one showing the window, which takes control of its new incarnation: the
 * runner asks it to queue the line and note before the server's commit, and
 * queues them itself only when the asking tab will not. Exactly one tab ever
 * queues them, and exactly one restarts a window put back, and exactly one
 * runs the move: each is a claim (`HubClaims`) that one tab of the browser
 * takes for good — a Web Lock, held for as long as that tab lives — and
 * time decides nothing but who may try. A request carries a deadline: the
 * asking tab claims only before it (or when it holds the claim already), and
 * the other tab tries only after it. A tab that answered late, or a frozen
 * one that wakes, finds the claim taken and does nothing, so a relaunch is
 * never queued twice (it would be typed, with Enter, into the running
 * Claude) and a stale request to run a move is never run again.
 *
 * Every tab hears every move's progress, so a window that is moving reads
 * "Moving to mac…" in each tab of this browser — the server cannot name the
 * target before the commit. A runner that falls silent leaves its moves to
 * Resolve.
 *
 * The bus is a same-origin BroadcastChannel scoped to the account. What
 * crosses it — host names, folders, the relaunch line and note — stays in
 * this browser; nothing is stored, and nothing reaches the server.
 */

import type { RelaunchPlan } from "@/lib/agent-relaunch";
import type { ConversationState } from "@/lib/conversation";
import type {
  MoveAction,
  MoveLauncherPort,
  MoveOrchestrator,
  MovePlan,
  MoveView,
} from "./orchestrator";

export interface HubBus {
  postMessage(data: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** What tabs share about one move. */
export interface MoveRecord {
  transferId: string;
  sessionId: string;
  sourceHostId: string;
  sourceName: string;
  targetHostId: string;
  targetName: string;
  targetCwd: string;
  conversationId: string;
  state: ConversationState;
  view: MoveView;
  /** The tab running it. */
  runner: string;
  /** The tab that asked for it, which types what follows. */
  requester: string;
}

export interface HubMove extends MoveRecord {
  /** This tab runs it, or asked for it. */
  mine: boolean;
  /** The tab running it went quiet: the window is left to Resolve. */
  lost: boolean;
}

/** The window as it will run on the target, for what is typed there. */
export type LaunchTarget = Pick<
  MoveRecord,
  "sessionId" | "targetHostId" | "targetName" | "targetCwd"
>;
/** The window put back, and the conversation it comes back to. */
export type LaunchSource = Pick<MoveRecord, "sessionId" | "conversationId">;

/** What this tab can do for one of its windows. */
export interface LocalLaunch {
  prepare(target: LaunchTarget, plan: RelaunchPlan | null): Promise<void>;
  abandon(sessionId: string): void;
  restartOnSource(source: LaunchSource): Promise<void>;
  refetch(): void;
}

type Control = Extract<MoveAction, "cancel" | "retry" | "resume_source" | "take_there">;

type HubMessage =
  | { type: "submit"; to: string; plan: MovePlan; record: MoveRecord; deadline: number }
  | { type: "state"; moves: MoveRecord[] }
  | { type: "control"; to: string; transferId: string; action: Control }
  | {
      type: "prepare";
      to: string;
      transferId: string;
      nonce: string;
      deadline: number;
      plan: RelaunchPlan | null;
    }
  | { type: "abandon"; to: string; transferId: string }
  | { type: "restart"; to: string; transferId: string; nonce: string; deadline: number }
  /** A prepare or restart answered: `done` when this tab did it. */
  | { type: "answer"; to: string; nonce: string; done: boolean }
  | { type: "bye" };

type Wire = HubMessage & { v: 2; from: string };

/**
 * Claims one tab of this browser takes for good: `take` resolves true when
 * this tab has it now — and keeps it for as long as it lives — and false
 * when another tab holds it. Exclusive across the browser's tabs whatever
 * the timing (Web Locks: `webLockClaims`).
 */
export interface HubClaims {
  take(name: string): Promise<boolean>;
}

/** Claims on the browser's Web Locks, or null where it has none. */
export function webLockClaims(): HubClaims | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  const locks = navigator.locks;
  return {
    take: (name) =>
      new Promise<boolean>((resolve) => {
        locks
          .request(name, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve(false);
              return;
            }
            resolve(true);
            // Held until the page goes.
            return new Promise<void>(() => {});
          })
          .catch(() => resolve(false));
      }),
  };
}

const runClaim = (transferId: string) => `spawn.move.run:${transferId}`;
const launchClaim = (transferId: string) => `spawn.move.launch:${transferId}`;
const restartClaim = (transferId: string) => `spawn.move.restart:${transferId}`;

export interface MoveHubOptions {
  tabId: string;
  /** Null where BroadcastChannel is missing: everything runs here. */
  bus: HubBus | null;
  /** The tab holding the connection to a host now, if known. */
  ownerOf: (hostId: string) => string | null;
  /** An orchestrator for a plan, its hosts and server bound by the caller. */
  createRun: (
    plan: MovePlan,
    launcher: MoveLauncherPort,
    emit: (view: MoveView) => void,
  ) => MoveOrchestrator;
  local: LocalLaunch;
  onChange: () => void;
  /** Null where the browser has no Web Locks: the asking tab then always
   *  does what it is asked, and the other tab never does it in its place. */
  claims?: HubClaims | null;
  timing?: {
    heartbeatMs: number;
    silenceMs: number;
    handshakeMs: number;
    acceptMs: number;
    /** After a deadline, how long the other side's answer may still be on its way. */
    graceMs?: number;
  };
}

/**
 * An owner answers a submit at once with its first state. One that has not
 * by the submit's deadline (`acceptMs`) and has not claimed the run is
 * taken as gone, and the move runs in the asking tab; an owner that hears
 * the submit after its deadline ignores it. A prepare or restart may be
 * claimed by the asking tab for `handshakeMs`, and only then by the runner.
 */
const TIMING = {
  heartbeatMs: 2_000,
  silenceMs: 20_000,
  handshakeMs: 1_500,
  acceptMs: 3_000,
  graceMs: 250,
};

/** Phases in which a move still holds the window. */
function live(view: MoveView): boolean {
  return view.phase !== "moved" && view.phase !== "ended";
}

export class MoveHub {
  private readonly runs = new Map<string, { orchestrator: MoveOrchestrator; record: MoveRecord }>();
  private readonly asked = new Map<
    string,
    { record: MoveRecord; plan: MovePlan; heardAt: number; accepted: boolean; lost: boolean }
  >();
  private readonly heard = new Map<string, { record: MoveRecord; heardAt: number }>();
  /** Answers awaited, by nonce. */
  private readonly handshakes = new Map<string, (done: boolean) => void>();
  /** Claims this tab holds. */
  private readonly held = new Set<string>();
  /** Tabs that said goodbye: asked nothing, they answer as declining. */
  private readonly gone = new Set<string>();
  private readonly timing: Required<NonNullable<MoveHubOptions["timing"]>>;
  private readonly heartbeat: ReturnType<typeof setInterval> | null;
  private closed = false;

  constructor(private readonly options: MoveHubOptions) {
    this.timing = { ...TIMING, ...options.timing };
    if (options.bus) options.bus.onmessage = ({ data }) => this.receive(data);
    this.heartbeat = options.bus ? setInterval(() => this.tick(), this.timing.heartbeatMs) : null;
  }

  // ---- what the app calls -------------------------------------------------------------

  /** Start a confirmed move: here, or in the tab that owns the target's connection. */
  start(plan: MovePlan, record: Omit<MoveRecord, "runner" | "requester" | "view">): void {
    const runner = this.options.ownerOf(plan.target.hostId);
    const full: MoveRecord = {
      ...record,
      runner: runner ?? this.options.tabId,
      requester: this.options.tabId,
      view: {
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
      },
    };
    if (!this.options.bus || !runner || runner === this.options.tabId) {
      this.runHere(plan, { ...full, runner: this.options.tabId });
      return;
    }
    this.asked.set(plan.transferId, {
      record: full,
      plan,
      heardAt: Date.now(),
      accepted: false,
      lost: false,
    });
    const deadline = Date.now() + this.timing.acceptMs;
    this.post({ type: "submit", to: runner, plan, record: full, deadline });
    // An owner that has neither answered nor claimed the run by the
    // deadline is no owner: run it here instead. One that claimed it is
    // running it, and its state will follow.
    setTimeout(() => {
      const asked = this.asked.get(plan.transferId);
      if (!asked || asked.accepted || this.closed) return;
      void this.take(runClaim(plan.transferId), true).then((mine) => {
        if (this.closed || this.asked.get(plan.transferId) !== asked) return;
        if (!mine) {
          asked.accepted = true;
          asked.heardAt = Date.now();
          this.options.onChange();
          return;
        }
        if (asked.accepted) return;
        this.asked.delete(plan.transferId);
        this.runHere(plan, { ...full, runner: this.options.tabId });
      });
    }, this.timing.acceptMs + this.timing.graceMs);
    this.options.onChange();
  }

  control(transferId: string, action: Control): void {
    const run = this.runs.get(transferId);
    if (run) {
      if (action === "cancel") void run.orchestrator.cancel();
      else if (action === "retry") void run.orchestrator.retry();
      else if (action === "take_there") void run.orchestrator.takeThere();
      else void run.orchestrator.resumeOnSource();
      return;
    }
    const asked = this.asked.get(transferId);
    if (asked && !asked.lost) {
      this.post({ type: "control", to: asked.record.runner, transferId, action });
      return;
    }
    // Any tab of this browser showing the window may cancel or retry it.
    const heard = this.heard.get(transferId);
    if (heard) this.post({ type: "control", to: heard.record.runner, transferId, action });
  }

  /** Forget a move this tab shows once it has ended (dismissed). */
  dismiss(transferId: string): void {
    const run = this.runs.get(transferId);
    if (run && live(run.record.view)) return;
    this.runs.delete(transferId);
    this.asked.delete(transferId);
    this.heard.delete(transferId);
    this.options.onChange();
  }

  /** The move a window is in, as this tab knows it: its own first. */
  forSession(sessionId: string): HubMove | null {
    for (const { record } of this.runs.values())
      if (record.sessionId === sessionId) return { ...record, mine: true, lost: false };
    for (const asked of this.asked.values())
      if (asked.record.sessionId === sessionId)
        return { ...asked.record, mine: true, lost: asked.lost };
    let latest: { record: MoveRecord; heardAt: number } | null = null;
    for (const entry of this.heard.values())
      if (entry.record.sessionId === sessionId && (!latest || entry.heardAt > latest.heardAt))
        latest = entry;
    if (!latest) return null;
    const lost = Date.now() - latest.heardAt > this.timing.silenceMs;
    return { ...latest.record, mine: false, lost };
  }

  moves(): HubMove[] {
    const sessions = new Set<string>();
    for (const { record } of this.runs.values()) sessions.add(record.sessionId);
    for (const { record } of this.asked.values()) sessions.add(record.sessionId);
    for (const { record } of this.heard.values()) sessions.add(record.sessionId);
    return [...sessions].flatMap((id) => {
      const move = this.forSession(id);
      return move ? [move] : [];
    });
  }

  /** Whether any move runs here: leaving the page would interrupt it. */
  busy(): boolean {
    for (const { record } of this.runs.values()) if (live(record.view)) return true;
    return false;
  }

  goodbye(): void {
    this.post({ type: "bye" });
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.goodbye();
    if (this.options.bus) this.options.bus.onmessage = null;
  }

  // ---- running ---------------------------------------------------------------------------

  private runHere(plan: MovePlan, record: MoveRecord): void {
    const launcher =
      record.requester === this.options.tabId
        ? this.localLauncher(record)
        : this.remoteLauncher(record);
    const entry = { orchestrator: null as unknown as MoveOrchestrator, record };
    entry.orchestrator = this.options.createRun(plan, launcher, (view) => {
      entry.record = { ...entry.record, view };
      this.broadcast();
      this.options.onChange();
      // Run for another tab: kept a while for it to hear how it ended, then
      // forgotten here. The tab that asked forgets its own when dismissed.
      if (!live(view) && record.requester !== this.options.tabId)
        setTimeout(() => {
          if (this.runs.get(plan.transferId) === entry) this.runs.delete(plan.transferId);
        }, this.timing.silenceMs);
    });
    this.runs.set(plan.transferId, entry);
    this.broadcast();
    this.options.onChange();
    void entry.orchestrator.start();
  }

  private localLauncher(record: MoveRecord): MoveLauncherPort {
    const { local } = this.options;
    return {
      prepare: (plan) => local.prepare(record, plan),
      abandon: () => local.abandon(record.sessionId),
      restartOnSource: () => local.restartOnSource(record),
      refetch: () => local.refetch(),
    };
  }

  /** Take a claim for this tab: true when it holds it now. Without Web
   *  Locks, `alone` says what to do: the asking tab goes ahead, the other
   *  one never does in its place. */
  private async take(name: string, alone: boolean): Promise<boolean> {
    if (this.held.has(name)) return true;
    const claims = this.options.claims;
    const mine = claims ? await claims.take(name) : alone;
    if (mine) this.held.add(name);
    return mine;
  }

  /** Ask the asking tab, and wait for its answer until just past the deadline. */
  private ask(
    message: HubMessage & { to: string; nonce: string; deadline: number },
  ): Promise<boolean | null> {
    // A tab that said goodbye is not waited for: it closed, or it froze —
    // and then, if it holds the claim already, it still does this on waking.
    if (this.gone.has(message.to)) {
      this.post(message);
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.handshakes.delete(message.nonce);
          resolve(null);
        },
        Math.max(0, message.deadline - Date.now()) + this.timing.graceMs,
      );
      this.handshakes.set(message.nonce, (done) => {
        clearTimeout(timer);
        this.handshakes.delete(message.nonce);
        resolve(done);
      });
      this.post(message);
    });
  }

  /**
   * The asking tab types; this tab does only when the asking tab will not —
   * it declined, or let the deadline pass — and this tab can claim it.
   */
  private remoteLauncher(record: MoveRecord): MoveLauncherPort {
    const { local } = this.options;
    const nonce = () => crypto.randomUUID();
    return {
      prepare: async (plan) => {
        const name = launchClaim(record.transferId);
        if (this.held.has(name)) {
          await local.prepare(record, plan);
          return;
        }
        const answer = await this.ask({
          type: "prepare",
          to: record.requester,
          transferId: record.transferId,
          nonce: nonce(),
          deadline: Date.now() + this.timing.handshakeMs,
          plan,
        });
        if (answer === true) return;
        // Declined: the asking tab will not queue it. Silent: it may yet,
        // if it claimed in time — the claim says.
        if (await this.take(name, answer === false)) await local.prepare(record, plan);
      },
      abandon: () => {
        this.post({ type: "abandon", to: record.requester, transferId: record.transferId });
        if (this.held.has(launchClaim(record.transferId))) local.abandon(record.sessionId);
      },
      restartOnSource: async () => {
        const name = restartClaim(record.transferId);
        if (this.held.has(name)) return;
        const answer = await this.ask({
          type: "restart",
          to: record.requester,
          transferId: record.transferId,
          nonce: nonce(),
          deadline: Date.now() + this.timing.handshakeMs,
        });
        if (answer === true) return;
        if (await this.take(name, answer === false)) await local.restartOnSource(record);
      },
      refetch: () => local.refetch(),
    };
  }

  /** The asking tab's side of a prepare or a restart. */
  private answerAsked(
    message: Extract<Wire, { type: "prepare" } | { type: "restart" }>,
    name: string,
    work: (asked: { record: MoveRecord }) => Promise<void>,
  ): void {
    const asked = this.asked.get(message.transferId);
    const reply = (done: boolean) =>
      this.post({ type: "answer", to: message.from, nonce: message.nonce, done });
    // Past its deadline the runner may have claimed it: only a tab that
    // holds the claim already still does it.
    if (!asked || (!this.held.has(name) && Date.now() > message.deadline)) {
      reply(false);
      return;
    }
    void this.take(name, true).then(async (mine) => {
      if (!mine) {
        reply(false);
        return;
      }
      try {
        await work(asked);
      } catch {
        // Done as far as it goes: the pane offers what is left.
      }
      reply(true);
    });
  }

  // ---- the bus ----------------------------------------------------------------------------

  private post(message: HubMessage): void {
    if (this.closed && message.type !== "bye") return;
    try {
      this.options.bus?.postMessage({ ...message, v: 2, from: this.options.tabId } satisfies Wire);
    } catch {
      // A closed bus: this tab is going.
    }
  }

  private broadcast(): void {
    const moves = [...this.runs.values()].map(({ record }) => record);
    if (moves.length > 0) this.post({ type: "state", moves });
  }

  private tick(): void {
    this.broadcast();
    const now = Date.now();
    let changed = false;
    for (const asked of this.asked.values()) {
      if (!asked.lost && asked.accepted && now - asked.heardAt > this.timing.silenceMs) {
        asked.lost = true;
        changed = true;
      }
    }
    for (const [id, entry] of this.heard)
      if (now - entry.heardAt > this.timing.silenceMs * 3) {
        this.heard.delete(id);
        changed = true;
      }
    if (changed) this.options.onChange();
  }

  private receive(data: unknown): void {
    const message = data as Wire;
    if (!message || message.v !== 2 || message.from === this.options.tabId) return;
    if ("to" in message && message.to !== this.options.tabId) return;
    if (message.type !== "bye") this.gone.delete(message.from);
    const now = Date.now();
    switch (message.type) {
      case "submit": {
        const id = message.plan.transferId;
        // After its deadline the asking tab may be running it itself: a
        // submit heard late — a frozen tab waking — is never run again.
        if (this.runs.has(id) || Date.now() > message.deadline) return;
        void this.take(runClaim(id), true).then((mine) => {
          if (!mine || this.closed || this.runs.has(id)) return;
          this.runHere(message.plan, { ...message.record, runner: this.options.tabId });
        });
        return;
      }
      case "state": {
        for (const record of message.moves) {
          const asked = this.asked.get(record.transferId);
          if (asked) {
            asked.record = record;
            asked.accepted = true;
            asked.heardAt = now;
            asked.lost = false;
          } else this.heard.set(record.transferId, { record, heardAt: now });
        }
        this.options.onChange();
        return;
      }
      case "control":
        this.control(message.transferId, message.action);
        return;
      case "prepare":
        this.answerAsked(message, launchClaim(message.transferId), (asked) =>
          this.options.local.prepare(asked.record, message.plan),
        );
        return;
      case "abandon": {
        const asked = this.asked.get(message.transferId);
        if (asked && this.held.has(launchClaim(message.transferId)))
          this.options.local.abandon(asked.record.sessionId);
        return;
      }
      case "restart":
        this.answerAsked(message, restartClaim(message.transferId), (asked) =>
          this.options.local.restartOnSource(asked.record),
        );
        return;
      case "answer":
        this.handshakes.get(message.nonce)?.(message.done);
        return;
      case "bye": {
        this.gone.add(message.from);
        let changed = false;
        for (const asked of this.asked.values())
          if (asked.record.runner === message.from && !asked.lost) {
            asked.lost = true;
            changed = true;
          }
        for (const [id, entry] of this.heard)
          if (entry.record.runner === message.from) {
            this.heard.set(id, { ...entry, heardAt: 0 });
            changed = true;
          }
        if (changed) this.options.onChange();
        return;
      }
    }
  }
}
