/**
 * Transfers run in the tab that holds this browser's connection to the host.
 *
 * Every SPAWN D tab of a browser shares one connection per host, owned by one
 * of them (`lib/daemon-connection.ts`); the others reach the host through it.
 * When that owner closes or goes to sleep it takes every channel with it, so a
 * transfer running in any other tab breaks too. So a tab hands an upload or a
 * send to the owner of the host it writes to, which runs it in its own engine
 * and reports back; the tab that asked shows it in its tray as if it were its
 * own, and the transfer survives that tab closing.
 *
 * A download stays where it was asked for: its bytes end in that tab's save
 * dialog or download. It reads by byte range, so when the owner goes it
 * resumes where it stopped.
 *
 * When the tab running a handed-off job goes (it says goodbye, or falls
 * silent), the tab that asked shows the job interrupted — "because another
 * SPAWN D tab closed or went to sleep" — and Resume hands it, with the plan
 * and how far it got, to whichever tab holds the connection now (often
 * itself). Anything that may have been written already is checked by digest
 * before it is written again (`TransferEngine`).
 *
 * The bus is a same-origin BroadcastChannel scoped to the account. What
 * crosses it — paths, names, sizes, the files being uploaded — stays in this
 * browser's memory; nothing is stored, and nothing reaches the server.
 */

import type {
  HandoffSpec,
  TransferAdoption,
  TransferAnswer,
  TransferEngine,
  TransferSpec,
  TransferView,
} from "./transfer-engine";

export interface HubBus {
  postMessage(data: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

type Control = "cancel" | "resume" | "retry" | "dismiss" | "answer" | "release";

type HubMessage =
  | { type: "submit"; to: string; id: string; spec: HandoffSpec; adopt?: TransferAdoption }
  | { type: "accepted"; to: string; id: string }
  | {
      type: "state";
      jobs: Array<{ id: string; requester: string; view: TransferView; states: string | null }>;
    }
  | { type: "plan"; to: string; id: string; adopt: TransferAdoption }
  | { type: "control"; to: string; id: string; action: Control; answer?: TransferAnswer }
  | { type: "bye" };

type Wire = HubMessage & { v: 1; from: string };

/** A transfer this tab asked another tab to run. */
interface RemoteJob {
  id: string;
  runner: string;
  spec: HandoffSpec;
  accepted: boolean;
  view: TransferView | null;
  /** The plan, once the runner made one, and each item's state as last heard. */
  adopt: TransferAdoption | null;
  states: string | null;
  heardAt: number;
  /** The runner went; this tab holds what is needed to carry on. */
  lost: boolean;
  cancelled: boolean;
}

export interface TransferHubOptions {
  tabId: string;
  /** Null where BroadcastChannel is missing: everything runs here. */
  bus: HubBus | null;
  /** The tab holding the connection to a host now, if known. */
  ownerOf: (hostId: string) => string | null;
  hostName: (hostId: string) => string;
  now?: () => number;
  onChange: () => void;
  timing?: { acceptMs: number; heartbeatMs: number; silenceMs: number };
}

/**
 * A runner says goodbye when it closes or sleeps; silence only has to catch a
 * crash or a hang, and a runner in a background tab reports on throttled
 * timers, so the wait is generous.
 */
const TIMING = { acceptMs: 1_500, heartbeatMs: 2_000, silenceMs: 20_000 };

/** The host whose connection a job depends on most: the one it writes to. */
function runnerHost(spec: HandoffSpec): string {
  return spec.kind === "send" ? spec.to : spec.hostId;
}

export type HubView = TransferView & { elsewhere: boolean };

export class TransferHub {
  private readonly remote = new Map<string, RemoteJob>();
  /** Jobs this tab runs for another: id → the tab that asked. */
  private readonly requesters = new Map<string, string>();
  /** The plan revision last sent to the tab that asked, per job. */
  private readonly planSent = new Map<string, number>();
  private readonly timing: typeof TIMING;
  private readonly now: () => number;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeat: ReturnType<typeof setInterval> | null;
  private closed = false;

  constructor(
    private readonly engine: TransferEngine,
    private readonly options: TransferHubOptions,
  ) {
    this.timing = options.timing ?? TIMING;
    this.now = options.now ?? Date.now;
    if (options.bus) options.bus.onmessage = ({ data }) => this.receive(data);
    this.heartbeat = options.bus ? setInterval(() => this.tick(), this.timing.heartbeatMs) : null;
  }

  // ---- What the tray calls -------------------------------------------------------

  submit(spec: TransferSpec): string {
    if (spec.kind === "download") return this.engine.submit(spec);
    return this.handOff(spec, crypto.randomUUID(), undefined);
  }

  cancel(id: string): void {
    const job = this.remote.get(id);
    if (!job) {
      this.engine.cancel(id);
      return;
    }
    if (job.lost || !job.accepted) {
      job.cancelled = true;
      this.post({ type: "control", to: job.runner, id, action: "release" });
      this.options.onChange();
      return;
    }
    this.post({ type: "control", to: job.runner, id, action: "cancel" });
  }

  resume(id: string): void {
    const job = this.remote.get(id);
    if (!job) {
      this.engine.resume(id);
      return;
    }
    if (!job.lost) {
      this.post({ type: "control", to: job.runner, id, action: "resume" });
      return;
    }
    // The tab that ran it went quiet. Whoever holds the connection now carries
    // on; if that is still the same tab, asking again is harmless — it has the
    // job and picks it up where it is.
    if (this.options.ownerOf(runnerHost(job.spec)) !== job.runner)
      this.post({ type: "control", to: job.runner, id, action: "release" });
    this.remote.delete(id);
    this.handOff(job.spec, id, adoptionFrom(job));
    this.options.onChange();
  }

  retry(id: string): void {
    const job = this.remote.get(id);
    if (!job) {
      this.engine.retry(id);
      return;
    }
    if (!job.lost) this.post({ type: "control", to: job.runner, id, action: "retry" });
  }

  answer(id: string, answer: TransferAnswer): void {
    const job = this.remote.get(id);
    if (!job) {
      this.engine.answer(id, answer);
      return;
    }
    if (!job.lost) this.post({ type: "control", to: job.runner, id, action: "answer", answer });
  }

  dismiss(id: string): void {
    const job = this.remote.get(id);
    if (!job) {
      this.engine.dismiss(id);
      return;
    }
    if (!job.lost && !job.cancelled)
      this.post({ type: "control", to: job.runner, id, action: "dismiss" });
    this.remote.delete(id);
    this.options.onChange();
  }

  clearFinished(): void {
    for (const view of this.views()) if (view.canDismiss) this.dismiss(view.id);
    this.engine.clearFinished();
  }

  /** The tray's list: this tab's own jobs (including ones it runs for others), then those it handed on. */
  views(): HubView[] {
    const local = this.engine.views().map((view) => ({ ...view, elsewhere: false }));
    const handed: HubView[] = [];
    for (const job of this.remote.values()) {
      const base = job.view ?? placeholder(job, this.options.hostName);
      if (job.cancelled) {
        handed.push({
          ...base,
          phase: "cancelled",
          question: null,
          interruption: null,
          canCancel: false,
          canResume: false,
          canRetry: false,
          canDismiss: true,
          elsewhere: true,
        });
      } else if (job.lost && !isFinished(base)) {
        handed.push({
          ...base,
          phase: "interrupted",
          question: null,
          secondsLeft: null,
          interruption: { cause: "other-tab", host: base.to ?? base.from ?? "" },
          canCancel: true,
          canResume: true,
          canRetry: false,
          canDismiss: false,
          elsewhere: true,
        });
      } else handed.push({ ...base, elsewhere: true });
    }
    return [...local, ...handed];
  }

  /** The page is going away or to sleep: the tabs it runs jobs for should know at once. */
  goodbye(): void {
    if (this.requesters.size > 0) this.post({ type: "bye" });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.post({ type: "bye" });
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.options.bus) this.options.bus.onmessage = null;
  }

  /**
   * The engine changed: tell the tabs this one runs jobs for. A new or changed
   * plan goes at once — the engine says so before its next write — so the tab
   * that asked holds it even if this one dies a moment later; progress goes
   * on a short debounce.
   */
  engineChanged(): void {
    if (this.requesters.size === 0) return;
    this.sendPlans();
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.broadcastState();
    }, 250);
  }

  // ---- Wiring ----------------------------------------------------------------------

  private handOff(spec: HandoffSpec, id: string, adopt: TransferAdoption | undefined): string {
    const runner = this.options.ownerOf(runnerHost(spec));
    if (!this.options.bus || !runner || runner === this.options.tabId) {
      return this.engine.submit(spec, { id, adopt });
    }
    const job: RemoteJob = {
      id,
      runner,
      spec,
      accepted: false,
      view: null,
      adopt: adopt ?? null,
      states: null,
      heardAt: this.now(),
      lost: false,
      cancelled: false,
    };
    this.remote.set(id, job);
    this.post({ type: "submit", to: runner, id, spec, ...(adopt ? { adopt } : {}) });
    // No answer: the owner can't take it (an older SPAWN D in that tab, or
    // it is gone). It runs here instead; a late acceptance is released, and
    // so is the job in a tab that was only hung and may still hold it.
    setTimeout(() => {
      const current = this.remote.get(id);
      if (current !== job || job.accepted || job.cancelled) return;
      this.remote.delete(id);
      this.post({ type: "control", to: runner, id, action: "release" });
      this.engine.submit(spec, { id, adopt: job.adopt ?? undefined });
      this.options.onChange();
    }, this.timing.acceptMs);
    this.options.onChange();
    return id;
  }

  private post(message: HubMessage): void {
    if (this.closed && message.type !== "bye") return;
    try {
      this.options.bus?.postMessage({ v: 1, from: this.options.tabId, ...message });
    } catch {
      // A message the bus can't clone is one this tab keeps to itself.
    }
  }

  private broadcastState(): void {
    const jobs: Array<{
      id: string;
      requester: string;
      view: TransferView;
      states: string | null;
    }> = [];
    for (const [id, requester] of this.requesters) {
      const view = this.engine.view(id);
      if (!view) {
        this.requesters.delete(id);
        this.planSent.delete(id);
        continue;
      }
      jobs.push({ id, requester, view, states: this.engine.itemStates(id) });
    }
    this.sendPlans();
    this.post({ type: "state", jobs });
  }

  /** Each job's plan to the tab that asked for it, whenever it is new or has changed. */
  private sendPlans(): void {
    for (const [id, requester] of this.requesters) {
      const revision = this.engine.planRevision(id);
      if (revision === null || this.planSent.get(id) === revision) continue;
      const adopt = this.engine.adoption(id);
      if (!adopt) continue;
      this.planSent.set(id, revision);
      this.post({ type: "plan", to: requester, id, adopt });
    }
  }

  private tick(): void {
    if (this.closed) return;
    if (this.requesters.size > 0) this.broadcastState();
    let changed = false;
    for (const job of this.remote.values()) {
      if (job.lost || job.cancelled || !job.accepted) continue;
      if (job.view && isFinished(job.view)) continue;
      if (this.now() - job.heardAt > this.timing.silenceMs) {
        job.lost = true;
        changed = true;
      }
    }
    if (changed) this.options.onChange();
  }

  private receive(raw: unknown): void {
    if (this.closed || !raw || typeof raw !== "object") return;
    const message = raw as Wire;
    if (message.v !== 1 || typeof message.from !== "string" || message.from === this.options.tabId)
      return;
    if ("to" in message && message.to !== this.options.tabId) {
      // Another tab taking over a job this one still holds: let it go.
      if (message.type === "submit" && this.engine.has(message.id)) this.engine.forget(message.id);
      return;
    }
    switch (message.type) {
      case "submit": {
        if (this.engine.has(message.id) && this.requesters.get(message.id) === message.from) {
          // Asked again for a job it still has: the asker heard nothing for a
          // while. Carry on (and on from an interruption), and say so — with
          // the plan again, in case that went missing too.
          this.planSent.delete(message.id);
          this.engine.resume(message.id);
          this.post({ type: "accepted", to: message.from, id: message.id });
          this.engineChanged();
          return;
        }
        this.requesters.set(message.id, message.from);
        this.engine.submit(message.spec, { id: message.id, adopt: message.adopt });
        this.post({ type: "accepted", to: message.from, id: message.id });
        this.engineChanged();
        return;
      }
      case "accepted": {
        const job = this.remote.get(message.id);
        if (job && job.runner === message.from && !job.cancelled) {
          job.accepted = true;
          job.heardAt = this.now();
          this.options.onChange();
        } else {
          // Ran here (or was cancelled) before the answer came.
          this.post({ type: "control", to: message.from, id: message.id, action: "release" });
        }
        return;
      }
      case "plan": {
        const job = this.remote.get(message.id);
        if (job && job.runner === message.from) job.adopt = message.adopt;
        return;
      }
      case "state": {
        let changed = false;
        const listed = new Set<string>();
        for (const entry of message.jobs) {
          if (entry.requester !== this.options.tabId) {
            // Another tab runs a job this tab still holds as its own: it was
            // resumed there. Let this copy go.
            if (this.engine.has(entry.id)) this.engine.forget(entry.id);
            continue;
          }
          const job = this.remote.get(entry.id);
          if (!job || job.runner !== message.from || job.cancelled) continue;
          listed.add(entry.id);
          job.accepted = true;
          job.view = entry.view;
          job.states = entry.states;
          job.heardAt = this.now();
          job.lost = false;
          changed = true;
        }
        for (const job of this.remote.values()) {
          if (job.runner !== message.from || !job.accepted || listed.has(job.id) || job.cancelled)
            continue;
          // The runner no longer has it: dismissed there, or never planned.
          if (job.view && isFinished(job.view)) this.remote.delete(job.id);
          else job.lost = true;
          changed = true;
        }
        if (changed) this.options.onChange();
        return;
      }
      case "control": {
        if (this.requesters.get(message.id) !== message.from) return;
        if (message.action === "release") {
          this.requesters.delete(message.id);
          this.planSent.delete(message.id);
          this.engine.forget(message.id);
        } else if (message.action === "cancel") this.engine.cancel(message.id);
        else if (message.action === "resume") this.engine.resume(message.id);
        else if (message.action === "retry") this.engine.retry(message.id);
        else if (message.action === "dismiss") {
          this.requesters.delete(message.id);
          this.planSent.delete(message.id);
          this.engine.dismiss(message.id);
        } else if (message.action === "answer" && message.answer)
          this.engine.answer(message.id, message.answer);
        this.engineChanged();
        return;
      }
      case "bye": {
        let changed = false;
        for (const job of this.remote.values()) {
          if (job.runner !== message.from || job.cancelled) continue;
          if (job.view && isFinished(job.view)) continue;
          job.lost = true;
          changed = true;
        }
        for (const [id, requester] of this.requesters) {
          if (requester === message.from && this.engine.view(id)?.canDismiss) {
            this.requesters.delete(id);
            this.planSent.delete(id);
          }
        }
        if (changed) this.options.onChange();
        return;
      }
    }
  }
}

function isFinished(view: TransferView): boolean {
  return view.phase === "done" || view.phase === "failed" || view.phase === "cancelled";
}

/** The plan with each item's state as the runner last reported it. */
function adoptionFrom(job: RemoteJob): TransferAdoption | undefined {
  const adopt = job.adopt;
  if (!adopt) return undefined;
  const states = job.states ?? "";
  const byLetter = { d: "done", s: "skipped", f: "failed", p: "pending" } as const;
  return {
    ...adopt,
    items: adopt.items.map((item, index) => {
      const letter = states[index] as keyof typeof byLetter | undefined;
      return letter ? { ...item, state: byLetter[letter] } : item;
    }),
  };
}

/** What the tray shows for a handed-off job before its runner has said anything. */
function placeholder(job: RemoteJob, hostName: (hostId: string) => string): TransferView {
  const spec = job.spec;
  return {
    id: job.id,
    verb: spec.kind,
    names:
      spec.kind === "send"
        ? spec.sources.map((source) => source.name)
        : [...new Set(spec.items.map((item) => item.rel.split("/")[0] ?? item.rel))],
    from: spec.kind === "send" ? hostName(spec.from) : null,
    to: hostName(spec.kind === "send" ? spec.to : spec.hostId),
    folder: spec.kind === "send" ? spec.destLabel : spec.dirLabel,
    hostIds: spec.kind === "send" ? [spec.from, spec.to] : [spec.hostId],
    phase: "queued",
    counted: 0,
    totalBytes: 0,
    doneBytes: 0,
    totalItems: 0,
    doneItems: 0,
    skipped: 0,
    failed: 0,
    secondsLeft: null,
    preparing: null,
    question: null,
    interruption: null,
    failures: [],
    notes: [],
    error: null,
    canCancel: true,
    canRetry: false,
    canResume: false,
    canDismiss: false,
  };
}
