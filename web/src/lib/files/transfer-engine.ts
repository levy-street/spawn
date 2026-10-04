/**
 * The transfer engine: uploads (this device → a host), downloads (a host →
 * this device, a folder as a zip) and sends (one host → another, through this
 * device), as a queue of jobs the Transfers tray shows and controls.
 *
 * - **One at a time per host.** A v1 host writes on its single serial queue
 *   and closes the channel when that queue overflows, so a host takes part in
 *   one running job at a time; files within a job go one after another. A job
 *   waiting on a question or a Resume lets go of its hosts meanwhile.
 * - **Dedicated consumers.** Every host is reached through the transfer
 *   consumer `TransferEnv.host` hands out, never through a browser view, so a
 *   transfer fault never takes the file list down with it.
 * - **Interruptions pause, they don't fail.** When the connection under a job
 *   goes — most often because the tab that holds this browser's connection to
 *   the host closed or went to sleep (`lib/daemon-connection.ts`) — the job
 *   stops where it is and says why, with Resume. A read resumes at the byte it
 *   reached (`fs.read.range`, pinned to the file's version); a write starts its
 *   file again (v1 writes are not resumable), and a write whose commit may have
 *   landed is checked by digest before anything is written twice.
 * - **Nothing is decided for the person.** A name already taken is settled by
 *   the policy picked, or asked; a relayed transfer over 100 MB asks first
 *   (OD3); a time is given only when it is more than 15 seconds.
 *
 * DOM-free: hosts, sinks, clocks and hashing come in through `TransferEnv`
 * and the specs, so every path here runs under `bun test` with fakes.
 */

import {
  HostControlError,
  type HostDirList,
  type HostFileOp,
  type HostFileStat,
  type HostRangeStream,
  type HostReadStream,
  MAX_RANGE_BYTES,
} from "@/lib/hostControl";
import { basename, joinPath, type PathFlavor, parentDir, pathsEqual } from "@/lib/paths";
import { hashStream } from "@/lib/sha256";
import {
  applyToOthersLabel,
  cantResumeNotice,
  conflictDecisionLabel,
  conflictQuestion,
  downloadTooLargeNotice,
  linksSkippedNote,
  proceedAnywayLabel,
  relayWarning,
  specialFilesSkippedNote,
  type TransferVerb,
  tooManyItemsNotice,
  transferErrorCopy,
  truncatedFolderNote,
} from "./copy";
import { formatSize } from "./format";
import { drainDirectory } from "./listing";
import {
  type ConflictDecision,
  type ConflictPolicy,
  conflictChoices,
  type ExistingItem,
  estimateSeconds,
  keepBothName,
  type Landing,
  type LocalItem,
  landingFor,
  MAX_TRANSFER_FILE_BYTES,
  MAX_TRANSFER_ITEMS,
  modelRate,
  nameSet,
  needsRelayWarning,
  type PathKind,
  RateMeter,
  relayedHosts,
  sourceKind,
  splitRel,
  type TopItem,
  TransferTooLargeError,
  uploadFolders,
  uploadOverLimit,
  uploadTopItems,
  type WalkSource,
  walkHostItems,
  worthEstimating,
} from "./transfer-plan";
import { type ZipFileWriter, ZipWriter } from "./zip";

// ---- What the engine needs -------------------------------------------------------

type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };

/** The host operations a transfer uses. `HostControlClient` has every one. */
export interface TransferHost {
  hasCapability(operation: string): boolean;
  listPage(path?: string, cursor?: number, options?: RequestOptions): Promise<HostDirList>;
  mkdir(path: string, options?: RequestOptions): Promise<HostFileOp>;
  stat(path: string, options?: RequestOptions): Promise<HostFileStat>;
  readFile(path: string, options?: RequestOptions): Promise<HostReadStream>;
  readRange(
    path: string,
    offset: number,
    length: number,
    options?: RequestOptions,
  ): Promise<HostRangeStream>;
  writeStream(
    stream: ReadableStream<Uint8Array>,
    declaration: { dir: string; name: string; length: number; sha256: string; overwrite?: boolean },
    signal?: AbortSignal,
  ): Promise<string>;
  transferFileTo(
    destination: TransferHost,
    path: string,
    destDir: string,
    overwrite?: boolean,
    signal?: AbortSignal,
    options?: {
      name?: string;
      onDeclared?: (source: { name: string; length: number; sha256: string }) => void;
      onProgress?: (bytes: number) => void;
    },
  ): Promise<HostFileOp>;
}

export interface TransferEnv {
  /** The host's dedicated transfer consumer, once ready. Throws when it can't be reached. */
  host(hostId: string, signal: AbortSignal): Promise<TransferHost>;
  hostName(hostId: string): string;
  flavor(hostId: string): PathFlavor;
  /** How this device reaches the host now: "relay" is the TURN relay. */
  pathKind(hostId: string): PathKind;
  rttMs(hostId: string): number | null;
  /** Whether this device's connection to the host is up. */
  connected(hostId: string): boolean;
  /** When the tab holding the connection to the host last let it go. */
  lastOwnerRelease(hostId: string): { page: string; at: number } | null;
  /** This tab (`browserTabId`). */
  tabId: string;
  now(): number;
  /** SHA-256 of a local file; a seam for tests. */
  hash?(file: File, onBytes?: (bytes: number) => void): Promise<string>;
}

/** Where a download's bytes go: a file the person picked, a streamed download, or memory. */
export interface ByteSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** A sink chosen at the click (a save picker needs the gesture), opened when the job starts. */
export interface SinkOpener {
  /** The most bytes it can take, or null. */
  readonly limit: number | null;
  open(name: string, size: number | null): Promise<ByteSink>;
}

export interface UploadSpec {
  kind: "upload";
  hostId: string;
  /** The folder on the host it goes into. */
  dir: string;
  /** That folder as the tray names it ("Documents", "Home"). */
  dirLabel: string;
  items: LocalItem[];
  /** Folders picked that hold nothing, "/"-separated under `dir`. */
  emptyDirs: string[];
  policy: ConflictPolicy;
}

export interface SendSpec {
  kind: "send";
  from: string;
  to: string;
  sources: WalkSource[];
  destDir: string;
  destLabel: string;
  policy: ConflictPolicy;
}

export interface DownloadSpec {
  kind: "download";
  hostId: string;
  sources: WalkSource[];
  /** The archive's name, for a folder or several items; null for one file. */
  archive: string | null;
  sink: SinkOpener;
}

export type TransferSpec = UploadSpec | SendSpec | DownloadSpec;
/** The jobs another tab can run: nothing in them is bound to this page. */
export type HandoffSpec = UploadSpec | SendSpec;

// ---- What the tray sees ------------------------------------------------------------

export type TransferPhase =
  | "queued"
  | "planning"
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TransferQuestion =
  | { kind: "relay"; text: string; proceed: string }
  | {
      kind: "conflict";
      text: string;
      choices: Array<{ decision: ConflictDecision; label: string }>;
      /** Conflicts still to come; "Do this for the other N" when more than none. */
      others: number;
      othersLabel: string | null;
    };

export type TransferAnswer =
  | { kind: "relay"; proceed: boolean }
  | { kind: "conflict"; decision: ConflictDecision; applyToOthers: boolean };

export interface TransferView {
  id: string;
  verb: TransferVerb;
  /** What was picked: one name is quoted in the title, several are counted. */
  names: string[];
  from: string | null;
  to: string | null;
  /** The folder on `to` it goes into ("Documents", "Home"); null for a download. */
  folder: string | null;
  hostIds: string[];
  phase: TransferPhase;
  /** Items found so far while counting. */
  counted: number;
  totalBytes: number;
  doneBytes: number;
  totalItems: number;
  doneItems: number;
  skipped: number;
  failed: number;
  /** Only when more than ESTIMATE_AFTER_SECONDS. */
  secondsLeft: number | null;
  /** How far a big local file's fingerprint is, in percent, while it is taken. */
  preparing: number | null;
  question: TransferQuestion | null;
  interruption: { cause: "other-tab" | "lost-touch"; host: string } | null;
  /** The first few items that did not make it, and why. */
  failures: Array<{ rel: string; reason: string }>;
  notes: string[];
  /** Why the whole job stopped, when it did. */
  error: string | null;
  canCancel: boolean;
  canRetry: boolean;
  canResume: boolean;
  canDismiss: boolean;
}

/** A plan another tab can pick up where this one left off. */
export interface TransferAdoption {
  items: PlanItem[];
  notes: string[];
  relayConfirmed: boolean;
}

export interface PlanItem {
  kind: "dir" | "file";
  /** "/"-joined from what was picked, for the tray. */
  rel: string;
  /** The name it lands under. */
  name: string;
  size: number;
  modified: number | null;
  /** Where it is on the source host. */
  srcPath?: string;
  /** Its file in `UploadSpec.items`. */
  local?: number;
  /** The folder it is written into (uploads, sends). */
  destDir?: string;
  /** A folder's own path at the destination. */
  destPath?: string;
  /** Its path in the archive (folder downloads). */
  zipName?: string;
  overwrite: boolean;
  /** One of the items picked: its name can still change on a late conflict. */
  top: boolean;
  /** How a conflict on it was settled, once one was. */
  decision?: ConflictDecision;
  state: "pending" | "done" | "skipped" | "failed";
  bytes: number;
  reason?: string;
  /** A write of it may have committed: an existing copy is checked, not clashed with. */
  attempted?: boolean;
  /** Which host a send's failure came from: the source, before it declared, or the destination. */
  side?: "read" | "write";
  sha256?: string;
}

// ---- Failures --------------------------------------------------------------------------

/** Client-side codes that mean the path to the host went, not that the host said no. */
const TRANSPORT_CODES = new Set([
  "connection_closed",
  "connect_timeout",
  "stream_timeout",
  "stream_failed",
  "invalid_response",
  "outcome_unknown",
]);

/**
 * This device's own end of a transfer failed — the file being saved, the
 * archive being built, the browser's download — not the path to a host. It
 * carries the sentence the failing end gave, and is never a lost connection:
 * Resume could not mend it.
 */
export class LocalTransferError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error && original.message ? original.message : String(original));
    this.name = "LocalTransferError";
  }
}

/** Run one step on this device's end; whatever it throws is that end's failure. */
async function onThisDevice<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw error instanceof LocalTransferError ? error : new LocalTransferError(error);
  }
}

/** The connection under an operation went; the host itself refused nothing. */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof LocalTransferError) return false;
  if (error instanceof HostControlError) return TRANSPORT_CODES.has(error.code);
  // hostControl rejects a lost or unready channel with a plain Error. Only
  // host operations reach here as plain errors: every step on this device's
  // own end is wrapped as a LocalTransferError first (`onThisDevice`).
  return error instanceof Error && error.constructor === Error;
}

function errorCode(error: unknown): string | null {
  if (error instanceof HostControlError) return error.code;
  if (
    error instanceof DOMException &&
    (error.name === "NotReadableError" || error.name === "NotFoundError")
  )
    return "local_unreadable";
  return null;
}

function cancelled(): DOMException {
  return new DOMException("Transfer cancelled", "AbortError");
}

/** Why one item failed, in words, from the side it failed on. */
function itemReason(
  error: unknown,
  where: { host: string; name: string; side: "read" | "write" | "local"; folder?: string },
): string {
  return (
    transferErrorCopy(errorCode(error), where) ??
    (error instanceof Error && error.message ? error.message : String(error))
  );
}

/** Raised to fail a whole job with a sentence for the tray. */
class JobError extends Error {}

// ---- Host locks ---------------------------------------------------------------------------

class HostLocks {
  private readonly held = new Set<string>();
  private readonly waiting: Array<{
    hosts: string[];
    grant: (release: () => void) => void;
    fail: (error: unknown) => void;
  }> = [];

  acquire(hosts: readonly string[], signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelled());
        return;
      }
      const waiter = {
        hosts: [...new Set(hosts)],
        grant: (release: () => void) => {
          signal.removeEventListener("abort", onAbort);
          resolve(release);
        },
        fail: reject,
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(cancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      this.grantAll();
    });
  }

  private grantAll(): void {
    for (let index = 0; index < this.waiting.length; ) {
      const waiter = this.waiting[index] as (typeof this.waiting)[number];
      if (waiter.hosts.some((host) => this.held.has(host))) {
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      for (const host of waiter.hosts) this.held.add(host);
      let released = false;
      waiter.grant(() => {
        if (released) return;
        released = true;
        for (const host of waiter.hosts) this.held.delete(host);
        this.grantAll();
      });
    }
  }
}

// ---- Jobs -----------------------------------------------------------------------------------

interface Gate<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A gate rejected by a cancel nobody awaits must not surface as unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

class Job {
  phase: TransferPhase = "queued";
  items: PlanItem[] | null = null;
  notes: string[] = [];
  error: string | null = null;
  counted = 0;
  question: { view: TransferQuestion; gate: Gate<TransferAnswer> } | null = null;
  interruption: TransferView["interruption"] = null;
  resumeGate: Gate<void> | null = null;
  abort = new AbortController();
  meter = new RateMeter();
  sink: ByteSink | null = null;
  zip: ZipWriter | null = null;
  /** "Do this for the other N": the answer every later conflict takes. */
  allDecision: ConflictDecision | null = null;
  relayConfirmed = false;
  /** Names at the destination folder, for "Keep both" on a late conflict. */
  taken = nameSet([]);
  /** Bytes moved in this run, for the rate. */
  moved = 0;
  running: Promise<void> | null = null;
  /** A big local file being fingerprinted: how far, in percent. */
  preparing: number | null = null;
  /**
   * Bumped whenever the plan another tab would adopt changes — made, or an
   * item renamed or told to overwrite — so the tab that asked always holds
   * the plan the writes follow.
   */
  planRevision = 0;

  constructor(
    readonly id: string,
    readonly spec: TransferSpec,
  ) {}

  get hosts(): string[] {
    const spec = this.spec;
    return spec.kind === "send" ? [spec.from, spec.to] : [spec.hostId];
  }

  get finished(): boolean {
    return this.phase === "done" || this.phase === "failed" || this.phase === "cancelled";
  }
}

const STREAM_TIMEOUT_MS = 60_000;
const MAX_FAILURES_SHOWN = 20;
const MAX_NAME_BUMPS = 50;
/** Picked files looked up one by one in a folder listed only in part; the rest meet their write. */
const MAX_FILE_PROBES = 64;
/** A local file this big shows its fingerprint being taken ("Preparing… 40%"). */
const PREPARING_SHOWN_BYTES = 16 * 1024 * 1024;

export class TransferEngine {
  private readonly jobs = new Map<string, Job>();
  private readonly locks = new HostLocks();
  /** Measured speeds by route, so the next estimate starts from experience. */
  private readonly rates = new Map<string, number>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly env: TransferEnv,
    private readonly onChange: () => void,
  ) {}

  // ---- Control ---------------------------------------------------------------------------

  submit(spec: TransferSpec, options: { id?: string; adopt?: TransferAdoption } = {}): string {
    const id = options.id ?? crypto.randomUUID();
    if (this.jobs.has(id)) return id;
    const job = new Job(id, spec);
    if (options.adopt) {
      // Picked up from a tab that stopped: anything not finished there may
      // have been written there, so an existing copy is checked, not clashed.
      job.items = options.adopt.items.map((item) => ({
        ...item,
        bytes: item.state === "done" ? item.size : 0,
        attempted: item.state === "pending" ? true : item.attempted,
      }));
      job.notes = [...options.adopt.notes];
      job.relayConfirmed = options.adopt.relayConfirmed;
    }
    this.jobs.set(id, job);
    this.start(job);
    return id;
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.finished) return;
    job.abort.abort();
    job.question?.gate.reject(cancelled());
    job.resumeGate?.reject(cancelled());
    if (!job.running) {
      job.phase = "cancelled";
      this.changed(true);
    }
  }

  /** Continue an interrupted job where it stopped. */
  resume(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.phase !== "interrupted") return;
    job.resumeGate?.resolve();
  }

  /** Try again what did not make it: failed items, or the whole job when it never planned. */
  retry(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.phase !== "failed" || job.spec.kind === "download") return;
    if (job.items) {
      for (const item of job.items) {
        if (item.state !== "failed") continue;
        item.state = "pending";
        item.bytes = 0;
        item.reason = undefined;
      }
    }
    job.error = null;
    job.abort = new AbortController();
    this.start(job);
  }

  answer(id: string, answer: TransferAnswer): void {
    const job = this.jobs.get(id);
    if (!job?.question || job.question.view.kind !== answer.kind) return;
    job.question.gate.resolve(answer);
  }

  dismiss(id: string): void {
    const job = this.jobs.get(id);
    if (!job?.finished) return;
    this.jobs.delete(id);
    this.changed(true);
  }

  clearFinished(): void {
    for (const [id, job] of this.jobs) if (job.finished) this.jobs.delete(id);
    this.changed(true);
  }

  /** Forget a job without touching it: another tab has taken it over. */
  forget(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (!job.finished) {
      job.abort.abort();
      job.question?.gate.reject(cancelled());
      job.resumeGate?.reject(cancelled());
    }
    this.jobs.delete(id);
    this.changed(true);
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  spec(id: string): TransferSpec | null {
    return this.jobs.get(id)?.spec ?? null;
  }

  /** Something here is still moving or waiting: leaving the page would stop it. */
  busy(): boolean {
    for (const job of this.jobs.values()) if (!job.finished) return true;
    return false;
  }

  /** What another tab needs to continue a job, once it has a plan. */
  adoption(id: string): TransferAdoption | null {
    const job = this.jobs.get(id);
    if (!job?.items) return null;
    return {
      items: job.items.map((item) => ({ ...item })),
      notes: [...job.notes],
      relayConfirmed: job.relayConfirmed,
    };
  }

  /** Which plan `adoption` would hand over now; null before there is one. */
  planRevision(id: string): number | null {
    const job = this.jobs.get(id);
    return job?.items ? job.planRevision : null;
  }

  /** Each item's state in one character, for a tab mirroring this job. */
  itemStates(id: string): string | null {
    const items = this.jobs.get(id)?.items;
    return items ? items.map((item) => item.state[0]).join("") : null;
  }

  views(): TransferView[] {
    return [...this.jobs.values()].map((job) => this.view(job));
  }

  view(job: Job): TransferView;
  view(id: string): TransferView | null;
  view(which: Job | string): TransferView | null {
    const job = typeof which === "string" ? this.jobs.get(which) : which;
    if (!job) return null;
    const spec = job.spec;
    const items = job.items ?? [];
    let totalBytes = 0;
    let doneBytes = 0;
    let totalItems = 0;
    let doneItems = 0;
    let skipped = 0;
    let failed = 0;
    const failures: TransferView["failures"] = [];
    for (const item of items) {
      if (item.kind === "file") {
        totalItems += 1;
        if (item.state !== "skipped") totalBytes += item.size;
        doneBytes += item.state === "done" ? item.size : item.state === "pending" ? item.bytes : 0;
      }
      if (item.state === "done" && item.kind === "file") doneItems += 1;
      if (item.state === "skipped" && item.kind === "file") skipped += 1;
      if (item.state === "failed") {
        failed += 1;
        if (failures.length < MAX_FAILURES_SHOWN)
          failures.push({ rel: item.rel, reason: item.reason ?? "" });
      }
    }
    if (!job.items && spec.kind !== "upload") {
      totalBytes = spec.sources.reduce((sum, source) => sum + (source.size ?? 0), 0);
    }
    const remaining = Math.max(0, totalBytes - doneBytes);
    const rate = job.meter.rate() ?? this.expectedRate(job);
    const seconds = job.phase === "running" ? estimateSeconds(remaining, rate) : null;
    const names =
      spec.kind === "upload"
        ? uploadTopItems(spec.items, spec.emptyDirs).map((top) => top.name)
        : spec.kind === "download" && spec.archive
          ? [spec.archive]
          : spec.sources.map((source) => source.name);
    return {
      id: job.id,
      verb: spec.kind,
      names,
      from:
        spec.kind === "send"
          ? this.env.hostName(spec.from)
          : spec.kind === "download"
            ? this.env.hostName(spec.hostId)
            : null,
      to:
        spec.kind === "send"
          ? this.env.hostName(spec.to)
          : spec.kind === "upload"
            ? this.env.hostName(spec.hostId)
            : null,
      folder: spec.kind === "send" ? spec.destLabel : spec.kind === "upload" ? spec.dirLabel : null,
      hostIds: job.hosts,
      phase: job.phase,
      counted: job.counted,
      totalBytes,
      doneBytes,
      totalItems,
      doneItems,
      skipped,
      failed,
      secondsLeft: worthEstimating(seconds) ? seconds : null,
      preparing: job.phase === "running" ? job.preparing : null,
      question: job.question?.view ?? null,
      interruption: job.phase === "interrupted" ? job.interruption : null,
      failures,
      notes: [...job.notes],
      error: job.error,
      canCancel: !job.finished,
      canRetry: job.phase === "failed",
      canResume: job.phase === "interrupted",
      canDismiss: job.finished,
    };
  }

  // ---- Running --------------------------------------------------------------------------

  private start(job: Job): void {
    job.phase = "queued";
    this.changed(true);
    job.running = this.run(job).finally(() => {
      job.running = null;
      this.changed(true);
    });
  }

  private async run(job: Job): Promise<void> {
    let release: (() => void) | null = null;
    const acquire = async () => {
      job.phase = "queued";
      this.changed(true);
      release = await this.locks.acquire(job.hosts, job.abort.signal);
      job.phase = job.items ? "running" : "planning";
      this.changed(true);
    };
    /** Let the hosts go while waiting on the person, then queue for them again. */
    const away = async <T>(wait: () => Promise<T>): Promise<T> => {
      release?.();
      release = null;
      try {
        return await wait();
      } finally {
        if (!job.abort.signal.aborted) await acquire();
      }
    };
    const recover = (attempt: () => Promise<void>) => this.recover(job, attempt, away);
    try {
      await acquire();
      if (!job.items) await recover(() => this.plan(job, away));
      await this.confirmRelay(job, away);
      job.phase = "running";
      job.meter.reset();
      job.moved = 0;
      this.changed(true);
      const started = this.env.now();
      await this.execute(job, recover, away);
      const items = job.items ?? [];
      job.phase = items.some((item) => item.state === "failed") ? "failed" : "done";
      this.rememberRate(job, started);
    } catch (error) {
      if (job.abort.signal.aborted) job.phase = "cancelled";
      else {
        job.phase = "failed";
        job.error = this.jobError(job, error);
      }
      const sink = job.sink;
      job.sink = null;
      if (sink) await sink.abort(error).catch(() => {});
    } finally {
      job.question = null;
      job.resumeGate = null;
      (release as (() => void) | null)?.();
      this.changed(true);
    }
  }

  /**
   * Run `attempt` until it succeeds, pausing on every lost connection until
   * the person resumes (or cancels). Anything else is the attempt's own
   * failure and is thrown.
   */
  private async recover(
    job: Job,
    attempt: () => Promise<void>,
    away: <T>(wait: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    for (;;) {
      const started = this.env.now();
      try {
        await attempt();
        return;
      } catch (error) {
        if (job.abort.signal.aborted) throw cancelled();
        if (!isTransportFailure(error)) throw error;
        await away(() => this.interrupted(job, started));
        if (job.abort.signal.aborted) throw cancelled();
        job.phase = job.items ? "running" : "planning";
        this.changed(true);
      }
    }
  }

  private interrupted(job: Job, since: number): Promise<void> {
    const hosts = job.hosts;
    const ownRelease = hosts.some((host) => {
      const release = this.env.lastOwnerRelease(host);
      return release !== null && release.page !== this.env.tabId && release.at >= since - 2_000;
    });
    const lost = hosts.find((host) => !this.env.connected(host)) ?? hosts[0] ?? "";
    job.interruption = {
      cause: ownRelease ? "other-tab" : "lost-touch",
      host: this.env.hostName(lost),
    };
    job.phase = "interrupted";
    job.resumeGate = gate<void>();
    this.changed(true);
    return job.resumeGate.promise.finally(() => {
      job.resumeGate = null;
      job.interruption = null;
    });
  }

  private ask(job: Job, view: TransferQuestion): Promise<TransferAnswer> {
    const answer = gate<TransferAnswer>();
    job.question = { view, gate: answer };
    job.phase = "waiting";
    this.changed(true);
    return answer.promise.finally(() => {
      job.question = null;
    });
  }

  private async host(job: Job, hostId: string): Promise<TransferHost> {
    if (job.abort.signal.aborted) throw cancelled();
    return this.env.host(hostId, job.abort.signal);
  }

  /** Whether a name is taken in `dir`, asked of the host itself. */
  private prober(job: Job, host: TransferHost, dir: string, flavor: PathFlavor) {
    return async (name: string) =>
      (await presence(host, joinPath(dir, name, flavor), job.abort.signal)) !== null;
  }

  private fetchPage(host: TransferHost) {
    return (path: string | undefined, cursor: number, signal?: AbortSignal) =>
      host.listPage(path, cursor, { signal });
  }

  // ---- Planning ----------------------------------------------------------------------------

  private async plan(job: Job, away: <T>(wait: () => Promise<T>) => Promise<T>): Promise<void> {
    job.counted = 0;
    job.notes = [];
    const spec = job.spec;
    if (spec.kind === "upload") job.items = await this.planUpload(job, spec, away);
    else if (spec.kind === "send") job.items = await this.planSend(job, spec, away);
    else job.items = await this.planDownload(job, spec);
    // Said at once, before a byte is written: a tab that asked for this job
    // must hold the plan its writes follow, or a Resume there plans afresh
    // and meets this job's own files as strangers.
    job.planRevision += 1;
    this.changed(true);
  }

  /**
   * What is in the destination folder now, by name, for the items picked.
   * A folder the host lists only in part (past its 1,024-entry cap) can hide
   * a picked name, so each picked folder not seen is looked up on its own, and
   * so is each picked file while there are few: a folder found that way is
   * settled like any other, not merged by accident. A file past that is still
   * caught by its write (`lateConflict`).
   */
  private async existing(
    job: Job,
    host: TransferHost,
    dir: string,
    flavor: PathFlavor,
    tops: readonly TopItem[],
  ): Promise<{ map: Map<string, ExistingItem>; partial: boolean }> {
    const signal = job.abort.signal;
    const listing = await drainDirectory(this.fetchPage(host), dir, { signal });
    const map = new Map<string, ExistingItem>();
    for (const entry of listing.entries) {
      map.set(entry.name, { name: entry.name, isDir: entry.is_dir === true });
    }
    if (listing.truncated) {
      let fileProbes = 0;
      for (const top of tops) {
        if (map.has(top.name)) continue;
        if (!top.isDir && fileProbes >= MAX_FILE_PROBES) continue;
        if (!top.isDir) fileProbes += 1;
        const found = await presence(host, joinPath(dir, top.name, flavor), signal);
        if (found) map.set(top.name, { name: top.name, isDir: found === "dir" });
      }
    }
    job.taken = nameSet(map.keys());
    return { map, partial: listing.truncated };
  }

  /**
   * Settle every picked item against the destination, asking where the
   * policy says to. `probe` looks a name up on the host, for a folder the host
   * listed only in part: a "Keep both" name must be free past the listed part
   * too.
   */
  private async settle(
    job: Job,
    tops: readonly TopItem[],
    existing: ReadonlyMap<string, ExistingItem>,
    policy: ConflictPolicy,
    where: { folder: string; host: string },
    away: <T>(wait: () => Promise<T>) => Promise<T>,
    probe: ((name: string) => Promise<boolean>) | null = null,
  ): Promise<Map<string, Landing & { decision?: ConflictDecision }>> {
    const clashing = tops.filter((top) => existing.has(top.name));
    if (policy !== "ask") job.allDecision = policy;
    const landings = new Map<string, Landing & { decision?: ConflictDecision }>();
    for (const top of tops) {
      const clash = existing.get(top.name) ?? null;
      let decision: ConflictDecision | null = null;
      if (clash) {
        decision = job.allDecision;
        if (!decision) {
          const others = clashing.length - 1 - clashing.indexOf(top);
          const answer = await away(() =>
            this.ask(job, this.conflictView(top, clash, where, others)),
          );
          if (answer.kind !== "conflict") throw cancelled();
          decision = answer.decision;
          if (answer.applyToOthers) job.allDecision = decision;
        }
      }
      let landing = landingFor(top, clash, decision, job.taken);
      for (
        let bumps = 0;
        probe && landing.name !== top.name && bumps < MAX_NAME_BUMPS;
        bumps += 1
      ) {
        if (!(await probe(landing.name))) break;
        job.taken.add(landing.name);
        landing = landingFor(top, clash, decision, job.taken);
      }
      job.taken.add(landing.name);
      landings.set(top.name, { ...landing, ...(decision ? { decision } : {}) });
    }
    return landings;
  }

  private conflictView(
    top: TopItem,
    clash: ExistingItem,
    where: { folder: string; host: string },
    others: number,
  ): TransferQuestion {
    return {
      kind: "conflict",
      text: conflictQuestion({ name: top.name, isDir: top.isDir, ...where }),
      choices: conflictChoices(top, clash).map((decision) => ({
        decision,
        label: conflictDecisionLabel(decision, top.isDir && clash.isDir),
      })),
      others,
      othersLabel: others > 0 ? applyToOthersLabel(others) : null,
    };
  }

  private async planUpload(
    job: Job,
    spec: UploadSpec,
    away: <T>(wait: () => Promise<T>) => Promise<T>,
  ): Promise<PlanItem[]> {
    const over = uploadOverLimit(spec.items, spec.emptyDirs, MAX_TRANSFER_ITEMS);
    if (over !== null) throw new JobError(tooManyItemsNotice(over, MAX_TRANSFER_ITEMS));
    const host = await this.host(job, spec.hostId);
    const flavor = this.env.flavor(spec.hostId);
    const hostName = this.env.hostName(spec.hostId);
    const tops = uploadTopItems(spec.items, spec.emptyDirs);
    const existing = await this.existing(job, host, spec.dir, flavor, tops);
    const landings = await this.settle(
      job,
      tops,
      existing.map,
      spec.policy,
      { folder: spec.dirLabel, host: hostName },
      away,
      existing.partial ? this.prober(job, host, spec.dir, flavor) : null,
    );
    const under = (parts: string[]): { landing: Landing; path: string } | null => {
      const first = parts[0];
      const landing = first ? landings.get(first) : undefined;
      if (!landing) return null;
      return {
        landing,
        path: joinPath(spec.dir, [landing.name, ...parts.slice(1)].join("/"), flavor),
      };
    };
    const items: PlanItem[] = [];
    for (const rel of uploadFolders(spec.items, spec.emptyDirs)) {
      const parts = splitRel(rel);
      const placed = under(parts);
      if (!placed) continue;
      items.push({
        kind: "dir",
        rel,
        name: parts.at(-1) ?? rel,
        size: 0,
        modified: null,
        destPath: placed.path,
        overwrite: false,
        top: parts.length === 1,
        state: placed.landing.skip ? "skipped" : "pending",
        bytes: 0,
      });
    }
    spec.items.forEach((local, index) => {
      const parts = splitRel(local.rel);
      const placed = under(parts);
      if (!placed) return;
      const top = parts.length === 1;
      const landing = placed.landing as Landing & { decision?: ConflictDecision };
      const item: PlanItem = {
        kind: "file",
        rel: parts.join("/"),
        name: top ? landing.name : (parts.at(-1) ?? local.file.name),
        size: local.file.size,
        modified: Math.floor(local.file.lastModified / 1000) || null,
        local: index,
        destDir: top
          ? spec.dir
          : joinPath(spec.dir, [landing.name, ...parts.slice(1, -1)].join("/"), flavor),
        overwrite: top ? landing.overwrite : landing.merge,
        top,
        ...(top && landing.decision ? { decision: landing.decision } : {}),
        state: landing.skip ? "skipped" : "pending",
        bytes: 0,
      };
      if (item.state === "pending" && local.file.size > MAX_TRANSFER_FILE_BYTES) {
        item.state = "failed";
        item.reason = itemReason(new HostControlError("file_too_large"), {
          host: hostName,
          name: item.name,
          side: "local",
        });
      }
      items.push(item);
    });
    return items;
  }

  private async planSend(
    job: Job,
    spec: SendSpec,
    away: <T>(wait: () => Promise<T>) => Promise<T>,
  ): Promise<PlanItem[]> {
    const source = await this.host(job, spec.from);
    const walked = await this.walk(job, source, spec.sources);
    const destination = await this.host(job, spec.to);
    const flavor = this.env.flavor(spec.to);
    // Only what is actually sent is settled: a link picked is left out.
    const tops = spec.sources
      .filter((item) => {
        const kind = sourceKind(item);
        return kind === "dir" || kind === "file";
      })
      .map((item) => ({ name: item.name, isDir: sourceKind(item) === "dir" }));
    const existing = await this.existing(job, destination, spec.destDir, flavor, tops);
    const landings = await this.settle(
      job,
      tops,
      existing.map,
      spec.policy,
      { folder: spec.destLabel, host: this.env.hostName(spec.to) },
      away,
      existing.partial ? this.prober(job, destination, spec.destDir, flavor) : null,
    );
    this.noteWalk(job, walked, this.env.hostName(spec.from), "send");
    return walked.items.map((walkedItem): PlanItem => {
      const first = walkedItem.rel[0] ?? "";
      const landing = (landings.get(first) ?? {
        name: first,
        skip: false,
        overwrite: false,
        merge: false,
      }) as Landing & { decision?: ConflictDecision };
      const top = walkedItem.rel.length === 1;
      const landed = [landing.name, ...walkedItem.rel.slice(1)];
      const base = {
        rel: walkedItem.rel.join("/"),
        name: landed.at(-1) ?? landing.name,
        size: walkedItem.size,
        modified: walkedItem.modified,
        srcPath: walkedItem.path,
        top,
        ...(top && landing.decision ? { decision: landing.decision } : {}),
        state: landing.skip ? ("skipped" as const) : ("pending" as const),
        bytes: 0,
      };
      if (walkedItem.kind === "dir") {
        return {
          ...base,
          kind: "dir",
          destPath: joinPath(spec.destDir, landed.join("/"), flavor),
          overwrite: false,
        };
      }
      return {
        ...base,
        kind: "file",
        destDir: top ? spec.destDir : joinPath(spec.destDir, landed.slice(0, -1).join("/"), flavor),
        overwrite: top ? landing.overwrite : landing.merge,
      };
    });
  }

  private async planDownload(job: Job, spec: DownloadSpec): Promise<PlanItem[]> {
    const single = spec.archive === null ? spec.sources[0] : undefined;
    if (single && sourceKind(single) === "file") {
      return [
        {
          kind: "file",
          rel: single.name,
          name: single.name,
          size: Math.max(0, single.size ?? 0),
          modified: single.modified ?? null,
          srcPath: single.path,
          overwrite: false,
          top: true,
          state: "pending",
          bytes: 0,
        },
      ];
    }
    const host = await this.host(job, spec.hostId);
    const walked = await this.walk(job, host, spec.sources);
    this.noteWalk(job, walked, this.env.hostName(spec.hostId), "download");
    const zipNames = archiveNames(walked.items);
    return walked.items.map((item, index) => ({
      kind: item.kind,
      rel: item.rel.join("/"),
      name: item.rel.at(-1) ?? "",
      size: item.size,
      modified: item.modified,
      srcPath: item.path,
      zipName: zipNames[index],
      overwrite: false,
      top: item.rel.length === 1,
      state: "pending",
      bytes: 0,
    }));
  }

  private async walk(job: Job, host: TransferHost, sources: readonly WalkSource[]) {
    try {
      return await walkHostItems(this.fetchPage(host), sources, {
        signal: job.abort.signal,
        onProgress: (count) => {
          job.counted = count;
          this.changed();
        },
      });
    } catch (error) {
      if (error instanceof TransferTooLargeError) {
        throw new JobError(tooManyItemsNotice(error.root, MAX_TRANSFER_ITEMS));
      }
      throw error;
    }
  }

  private noteWalk(
    job: Job,
    walked: { links: number; others: number; truncated: string[] },
    host: string,
    verb: TransferVerb,
  ): void {
    if (walked.links > 0) job.notes.push(linksSkippedNote(walked.links));
    if (walked.others > 0) job.notes.push(specialFilesSkippedNote(walked.others));
    if (walked.truncated.length > 0)
      job.notes.push(truncatedFolderNote(walked.truncated, host, verb));
  }

  /** OD3: a relayed transfer over 100 MB asks first, once. */
  private async confirmRelay(
    job: Job,
    away: <T>(wait: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    if (job.relayConfirmed) return;
    const bytes = (job.items ?? [])
      .filter((item) => item.kind === "file" && item.state === "pending")
      .reduce((sum, item) => sum + item.size, 0);
    const legs = job.hosts.map((host) => ({
      name: this.env.hostName(host),
      kind: this.env.pathKind(host),
    }));
    if (needsRelayWarning(bytes, legs)) {
      const seconds = estimateSeconds(bytes, this.expectedRate(job));
      const answer = await away(() =>
        this.ask(job, {
          kind: "relay",
          text: relayWarning({
            hosts: relayedHosts(legs),
            bytes,
            estimate: worthEstimating(seconds) ? seconds : null,
            formatBytes: formatSize,
          }),
          proceed: proceedAnywayLabel(job.spec.kind),
        }),
      );
      if (answer.kind !== "relay" || !answer.proceed) {
        job.abort.abort();
        throw cancelled();
      }
    }
    job.relayConfirmed = true;
  }

  // ---- Moving bytes ---------------------------------------------------------------------------

  private async execute(
    job: Job,
    recover: (attempt: () => Promise<void>) => Promise<void>,
    away: <T>(wait: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    const spec = job.spec;
    if (spec.kind === "download") {
      await this.download(job, spec, recover);
      return;
    }
    for (const item of job.items ?? []) {
      if (job.abort.signal.aborted) throw cancelled();
      if (item.state !== "pending") continue;
      try {
        if (item.kind === "dir") {
          const hostId = spec.kind === "send" ? spec.to : spec.hostId;
          await recover(async () => {
            const host = await this.host(job, hostId);
            await this.makeFolder(host, item.destPath ?? "", job.abort.signal);
          });
          item.state = "done";
        } else if (spec.kind === "upload") {
          await this.uploadFile(job, spec, item, recover, away);
        } else {
          await this.sendFile(job, spec, item, recover, away);
        }
      } catch (error) {
        if (job.abort.signal.aborted || error instanceof JobError) throw error;
        item.state = "failed";
        const side =
          errorCode(error) === "local_unreadable"
            ? "local"
            : spec.kind === "upload" || item.kind === "dir"
              ? "write"
              : (item.side ?? "read");
        item.reason = itemReason(error, {
          host: this.env.hostName(
            spec.kind === "send" ? (side === "read" ? spec.from : spec.to) : spec.hostId,
          ),
          name: item.name,
          side,
          folder: this.folderOf(spec, item),
        });
      }
      this.changed();
    }
  }

  /**
   * The folder an item was going into, as a sentence names it: the one picked
   * for a picked item, else its own parent there ("photos (2)").
   */
  private folderOf(spec: UploadSpec | SendSpec, item: PlanItem): string {
    const label = spec.kind === "send" ? spec.destLabel : spec.dirLabel;
    const flavor = this.env.flavor(spec.kind === "send" ? spec.to : spec.hostId);
    const into = item.kind === "dir" ? parentDir(item.destPath ?? "", flavor) : item.destDir;
    const root = spec.kind === "send" ? spec.destDir : spec.dir;
    if (!into || item.top || pathsEqual(into, root, flavor)) return label;
    return basename(into, flavor) || label;
  }

  /** A folder at the destination: one already there is the one to fill. */
  private async makeFolder(host: TransferHost, path: string, signal: AbortSignal): Promise<void> {
    try {
      await host.mkdir(path, { signal });
    } catch (error) {
      if (errorCode(error) === "already_exists") return;
      throw error;
    }
  }

  private progress(job: Job, item: PlanItem, bytes: number): void {
    const delta = bytes - item.bytes;
    item.bytes = bytes;
    job.moved += Math.max(0, delta);
    job.meter.note(this.env.now(), job.moved);
    this.changed();
  }

  private async uploadFile(
    job: Job,
    spec: UploadSpec,
    item: PlanItem,
    recover: (attempt: () => Promise<void>) => Promise<void>,
    away: <T>(wait: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    const local = spec.items[item.local ?? -1];
    if (!local) throw new HostControlError("local_unreadable");
    const file = local.file;
    for (let bumps = 0; ; bumps += 1) {
      let clash: unknown = null;
      await recover(async () => {
        const host = await this.host(job, spec.hostId);
        item.sha256 ??= await this.fingerprint(job, file);
        this.progress(job, item, 0);
        try {
          await host.writeStream(
            counted(file.stream(), (bytes) => this.progress(job, item, bytes)),
            {
              dir: item.destDir ?? spec.dir,
              name: item.name,
              length: file.size,
              sha256: item.sha256,
              overwrite: item.overwrite,
            },
            job.abort.signal,
          );
          item.state = "done";
        } catch (error) {
          if (errorCode(error) === "outcome_unknown") item.attempted = true;
          if (errorCode(error) !== "already_exists") throw error;
          clash = error;
        }
      });
      if (!clash) return;
      const host = await this.host(job, spec.hostId);
      const settled = await this.lateConflict(job, item, host, spec.hostId, {
        folder: spec.dirLabel,
        policy: spec.policy,
        error: clash,
        bumps,
        away,
      });
      if (settled) return;
    }
  }

  private async sendFile(
    job: Job,
    spec: SendSpec,
    item: PlanItem,
    recover: (attempt: () => Promise<void>) => Promise<void>,
    away: <T>(wait: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    for (let bumps = 0; ; bumps += 1) {
      let clash: unknown = null;
      await recover(async () => {
        const source = await this.host(job, spec.from);
        const destination = await this.host(job, spec.to);
        this.progress(job, item, 0);
        let declared = false;
        try {
          await source.transferFileTo(
            destination,
            item.srcPath ?? "",
            item.destDir ?? spec.destDir,
            item.overwrite,
            job.abort.signal,
            {
              name: item.name,
              onDeclared: ({ length, sha256 }) => {
                declared = true;
                item.sha256 = sha256;
                // The source's own word on its size beats a listing's.
                item.size = length;
              },
              onProgress: (bytes) => this.progress(job, item, bytes),
            },
          );
          item.state = "done";
        } catch (error) {
          item.side = declared ? "write" : "read";
          if (errorCode(error) === "outcome_unknown") item.attempted = true;
          if (errorCode(error) !== "already_exists" || !declared) throw error;
          clash = error;
        }
      });
      if (!clash) return;
      const destination = await this.host(job, spec.to);
      const settled = await this.lateConflict(job, item, destination, spec.to, {
        folder: spec.destLabel,
        policy: spec.policy,
        error: clash,
        bumps,
        away,
      });
      if (settled) return;
    }
  }

  /** A local file's SHA-256, saying how far it is when the file is big enough to wait on. */
  private async fingerprint(job: Job, file: File): Promise<string> {
    const shown = file.size >= PREPARING_SHOWN_BYTES;
    const onBytes = (bytes: number) => {
      job.preparing = file.size > 0 ? (bytes / file.size) * 100 : 100;
      this.changed();
    };
    if (shown) onBytes(0);
    try {
      return await (this.env.hash
        ? this.env.hash(file, shown ? onBytes : undefined)
        : hashStream(shown ? counted(file.stream(), onBytes) : file.stream()));
    } finally {
      job.preparing = null;
      if (shown) this.changed();
    }
  }

  /**
   * The destination said the name is taken. When an earlier try may have
   * committed it, a copy with our digest is ours: done. A picked item is
   * settled as its conflict was (or as the person now says). Anything else
   * is a real clash and the item fails. Returns true when the item is settled;
   * false to write it again under its (possibly new) name.
   */
  private async lateConflict(
    job: Job,
    item: PlanItem,
    host: TransferHost,
    hostId: string,
    {
      folder,
      policy,
      error,
      bumps,
      away,
    }: {
      folder: string;
      policy: ConflictPolicy;
      error: unknown;
      bumps: number;
      away: <T>(wait: () => Promise<T>) => Promise<T>;
    },
  ): Promise<boolean> {
    const flavor = this.env.flavor(hostId);
    const path = joinPath(item.destDir ?? "", item.name, flavor);
    if (item.attempted && (await alreadyThere(host, path, item.size, item.sha256))) {
      item.state = "done";
      item.bytes = item.size;
      return true;
    }
    if (!item.top || bumps >= MAX_NAME_BUMPS) throw error;
    let decision = item.decision ?? job.allDecision ?? (policy === "ask" ? null : policy);
    if (!decision) {
      const top = { name: item.name, isDir: false };
      const clash = { name: item.name, isDir: false };
      const answer = await away(() =>
        this.ask(
          job,
          this.conflictView(top, clash, { folder, host: this.env.hostName(hostId) }, 0),
        ),
      );
      if (answer.kind !== "conflict") throw cancelled();
      decision = answer.decision;
      if (answer.applyToOthers) job.allDecision = decision;
    }
    item.decision = decision;
    if (decision === "skip") {
      item.state = "skipped";
      return true;
    }
    if (decision === "replace") {
      if (item.overwrite) throw error;
      item.overwrite = true;
    } else {
      job.taken.add(item.name);
      item.name = keepBothName(item.name, (name) => job.taken.has(name));
      job.taken.add(item.name);
      item.attempted = false;
    }
    // The plan changed under a write about to start: say so now.
    job.planRevision += 1;
    this.changed(true);
    return false;
  }

  private async download(
    job: Job,
    spec: DownloadSpec,
    recover: (attempt: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const items = job.items ?? [];
    const archive = spec.archive;
    const estimate =
      items.reduce((sum, item) => sum + item.size, 0) +
      (archive ? items.reduce((sum, item) => sum + 140 + 2 * (item.zipName?.length ?? 0), 22) : 0);
    if (spec.sink.limit !== null && estimate > spec.sink.limit) {
      throw new JobError(downloadTooLargeNotice(formatSize(spec.sink.limit)));
    }
    if (!archive) {
      const first = items[0];
      if (first?.kind === "file" && first.state === "pending") {
        await this.readInto(
          job,
          spec.hostId,
          first,
          recover,
          (bytes) => (job.sink as ByteSink).write(bytes),
          // Opened once the host has said how long the file is, never from
          // the listing: a streamed download promises the browser exactly that
          // many bytes, and a file still being written has moved on since.
          async (size) => {
            job.sink ??= await spec.sink.open(first.name, size);
          },
        );
        first.state = "done";
      }
    } else {
      job.sink ??= await onThisDevice(() => spec.sink.open(archive, null));
      const sink = job.sink;
      job.zip ??= new ZipWriter((bytes) => sink.write(bytes));
      const zip = job.zip;
      for (const item of items) {
        if (job.abort.signal.aborted) throw cancelled();
        if (item.state !== "pending") continue;
        if (item.kind === "dir") {
          await onThisDevice(() =>
            zip.addDirectory(item.zipName ?? `${item.name}/`, item.modified),
          );
          item.state = "done";
          continue;
        }
        const open: { entry: ZipFileWriter | null } = { entry: null };
        try {
          await this.readInto(
            job,
            spec.hostId,
            item,
            recover,
            async (bytes) => {
              await open.entry?.write(bytes);
            },
            async (size) => {
              open.entry = await zip.beginFile(item.zipName ?? item.name, {
                size,
                modified: item.modified,
              });
            },
          );
          await onThisDevice(async () => {
            await open.entry?.end();
          });
          item.state = "done";
        } catch (error) {
          if (job.abort.signal.aborted) throw error;
          // Nothing of it is in the archive yet: leave it out and say why.
          // Part of it is: the archive can't be finished honestly.
          if (open.entry !== null || !errorCode(error)) throw error;
          item.state = "failed";
          item.reason = itemReason(error, {
            host: this.env.hostName(spec.hostId),
            name: item.name,
            side: "read",
          });
        }
        this.changed();
      }
      await onThisDevice(() => zip.finish());
    }
    const sink = job.sink;
    if (sink) await onThisDevice(() => sink.close());
    job.sink = null;
  }

  /**
   * Read one file from the host into `write`, resuming at the byte it reached
   * after a lost connection. With `fs.read.range` the file is read in 16 MiB
   * slices pinned to the version the first one saw, so a file that changes
   * part-way fails rather than splicing two versions; without it, one
   * `fs.read`, which can only start again from the beginning. `begin` hears
   * the size the host declared before the first byte. Both run on this
   * device's end: what they throw fails the transfer and is never taken for
   * a lost connection.
   */
  private async readInto(
    job: Job,
    hostId: string,
    item: PlanItem,
    recover: (attempt: () => Promise<void>) => Promise<void>,
    write: (bytes: Uint8Array) => Promise<void>,
    begin?: (size: number) => Promise<void>,
  ): Promise<void> {
    let offset = 0;
    let version: string | null = null;
    let size = item.size;
    let begun = false;
    const hostName = this.env.hostName(hostId);
    const start = async (stream: ReadableStream<Uint8Array>) => {
      if (begun) return;
      try {
        await onThisDevice(async () => {
          await begin?.(size);
        });
      } catch (error) {
        await stream.cancel(error).catch(() => {});
        throw error;
      }
      begun = true;
    };
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          await onThisDevice(() => write(value));
          offset += value.byteLength;
          this.progress(job, item, offset);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    };
    await recover(async () => {
      const host = await this.host(job, hostId);
      const ranged = host.hasCapability("fs.read.range");
      // Bytes already handed on can't be taken back, and without ranges the
      // host can only start the file again.
      if (!ranged && offset > 0) throw new JobError(cantResumeNotice(hostName));
      if (!ranged) {
        const read = await host.readFile(item.srcPath ?? "", {
          signal: job.abort.signal,
          timeoutMs: STREAM_TIMEOUT_MS,
        });
        if (begun && read.length !== size) {
          // Started once already, at another length: it changed meanwhile.
          await read.stream.cancel().catch(() => {});
          throw new HostControlError("file_changed");
        }
        size = read.length;
        item.size = size;
        await start(read.stream);
        await pump(read.stream);
        return;
      }
      for (;;) {
        const want = Math.min(MAX_RANGE_BYTES, Math.max(1, size - offset));
        const range = await host.readRange(item.srcPath ?? "", offset, want, {
          signal: job.abort.signal,
          timeoutMs: STREAM_TIMEOUT_MS,
        });
        if (version === null && !begun) {
          version = range.version ?? "";
          size = range.fileSize;
          item.size = size;
          await start(range.stream);
        } else if ((range.version ?? "") !== version || range.fileSize !== size) {
          await range.stream.cancel().catch(() => {});
          throw new HostControlError("file_changed");
        }
        await pump(range.stream);
        if (range.eof || range.length === 0 || offset >= size) return;
      }
    });
  }

  // ---- Estimates -------------------------------------------------------------------------------

  private routeKey(job: Job): string {
    return [...job.hosts].sort().join("|");
  }

  /** Before anything is measured: what this route did last time, or the round-trip model. */
  private expectedRate(job: Job): number {
    const remembered = this.rates.get(this.routeKey(job));
    if (remembered) return remembered;
    // A send crosses two legs one after the other: the slower one sets the pace.
    return Math.min(...job.hosts.map((host) => modelRate(this.env.rttMs(host))));
  }

  private rememberRate(job: Job, started: number): void {
    const seconds = (this.env.now() - started) / 1000;
    if (seconds < 2 || job.moved < 1024 * 1024) return;
    this.rates.set(this.routeKey(job), job.moved / seconds);
  }

  private jobError(job: Job, error: unknown): string {
    if (error instanceof JobError || error instanceof LocalTransferError) return error.message;
    const spec = job.spec;
    const hostId = spec.kind === "send" ? spec.from : spec.hostId;
    const name = spec.kind === "upload" ? spec.dirLabel : (spec.sources[0]?.name ?? "");
    return itemReason(error, { host: this.env.hostName(hostId), name, side: "read" });
  }

  private changed(urgent = false): void {
    if (urgent) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      this.onChange();
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.onChange();
    }, 200);
  }
}

/** A file stream that reports how far it has been read. */
function counted(
  stream: ReadableStream<Uint8Array>,
  onBytes: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        onBytes(total);
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Whether the file at `path` is the one a lost write was sending: same size
 * and, read back through the host's own digest, the same bytes.
 */
async function alreadyThere(
  host: TransferHost,
  path: string,
  size: number,
  sha256: string | undefined,
): Promise<boolean> {
  if (!sha256 || !host.hasCapability("fs.read")) return false;
  try {
    if (host.hasCapability("fs.stat")) {
      const stat = await host.stat(path);
      if (stat.kind !== "file" || (stat.size ?? -1) !== size) return false;
    }
    const read = await host.readFile(path);
    await read.stream.cancel().catch(() => {});
    return read.length === size && read.sha256 === sha256;
  } catch {
    return false;
  }
}

/**
 * Whether something is at `path` on the host, and what: asked by `fs.stat`
 * where the host has it, else by listing the path itself (a folder lists; a
 * file says it is not one).
 */
async function presence(
  host: TransferHost,
  path: string,
  signal: AbortSignal,
): Promise<"dir" | "file" | null> {
  try {
    if (host.hasCapability("fs.stat")) {
      const stat = await host.stat(path, { signal });
      return stat.kind === "directory" ? "dir" : "file";
    }
    await host.listPage(path, 0, { signal });
    return "dir";
  } catch (error) {
    const code = errorCode(error);
    if (code === "not_found") return null;
    if (code === "not_directory") return "file";
    throw error;
  }
}

/**
 * Each walked item's path in the archive. Two names that come out the same
 * once cleaned for a zip ("a\\b" and "a_b"), or that differ only in case
 * (which most unzippers fold together), would overwrite each other when
 * unpacked: the later one keeps both, as "a_b (2)", and everything under a
 * renamed folder follows it. Never throws: a name with nothing left once
 * cleaned is "_".
 */
export function archiveNames(
  items: ReadonlyArray<{ rel: readonly string[]; kind: "dir" | "file" }>,
): string[] {
  const clean = (part: string) => {
    const name = part.replace(/[\\/]/gu, "_");
    return name === "" || name === "." || name === ".." ? "_" : name;
  };
  /** Each folder's own path in the archive, "/"-ended, by its rel. */
  const folders = new Map<string, string>();
  const taken = nameSet([]);
  return items.map((item) => {
    const parentRel = item.rel.slice(0, -1);
    const prefix =
      folders.get(parentRel.join("\u0000")) ?? parentRel.map((part) => `${clean(part)}/`).join("");
    const isDir = item.kind === "dir";
    const leaf = clean(item.rel.at(-1) ?? "");
    const name = taken.has(`${prefix}${leaf}`)
      ? keepBothName(leaf, (candidate) => taken.has(`${prefix}${candidate}`), isDir)
      : leaf;
    taken.add(`${prefix}${name}`);
    const path = `${prefix}${name}${isDir ? "/" : ""}`;
    if (isDir) folders.set(item.rel.join("\u0000"), path);
    return path;
  });
}
