import type { MoveArrival } from "@/components/launcher/pending-agent-input";
import * as copy from "@/components/workspace-detail/move-copy";
import { ApiError } from "@/data/api/client";
import type { SessionMove } from "@/data/api/schemas/sessions";
import { planRelaunch } from "@/data/selectors/agent-relaunch";
import {
  compareFolders,
  defaultPermissionMode,
  ESTIMATE_SHOWN_ABOVE_SECONDS,
  estimateCarrySeconds,
  type FolderCommit,
  findPackedRef,
  formatCarryDuration,
  joinHostPath,
  NO_PUT_BACK_FACTS,
  olderVersion,
  type PermissionMode,
  type PutBackFacts,
  parseGitDirPointer,
  parseGitHead,
  parseLooseRef,
  putBackLine,
} from "@/data/selectors/move-facts";
import { displayPath } from "@/data/selectors/places";
import type { AgentDef, Session } from "@/data/types/domain";
import {
  CARRIED_AGENT,
  CONVERSATION_CARRIER_CAPABILITY,
  type ConversationCommitted,
  type ConversationExportDeclaration,
  type ConversationInspection,
  type ConversationProbe,
  parseConversationCommitted,
  probeSaysLive,
} from "@/terminal/transport/conversation-codec";
import { canonicalConversationId } from "@/terminal/transport/conversation-id";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-error";
import type { StreamV2Reader, StreamV2Writer } from "@/terminal/transport/stream-v2";
import type {
  AgentTranscriptQuery,
  AgentTranscriptReport,
  ConnectionInfo,
  ConversationCarrierTransport,
  HostReadHead,
  HostRequestOptions,
  TransportState,
} from "@/terminal/transport/types";

/**
 * Move a Claude Code window to another host with its conversation: the
 * device's orchestrator, the same steps as the browser's
 * (web/src/lib/move/orchestrator.ts), from the contract in proto/README.md
 * ("The conversation carrier") and the server's move routes.
 *
 * The person's confirmation is the permission to carry this conversation,
 * this once; nothing is carried otherwise. The device asks the server to
 * mark the window moving (no host hears of that), retires the conversation
 * out of the source — which stops the window and every Claude of it and
 * takes the files out of Claude Code's lookup path, the single writer's
 * fence — pipes the bundle into the target's staging over its two channels
 * (never through the server, never host to host), and once the target has
 * committed, settles the source and rebinds the window. The resume line and
 * the note are typed by this device into the new incarnation, which it
 * opens and so takes control of.
 *
 * Until the target commits, every failure can be undone: the target's
 * import is cancelled first, and only once it has answered "cancelled" does
 * the source put the files back; then the server move is aborted and the
 * window restarted on the source where its retire stopped it. A host that
 * does not answer leaves the move as it is — moving, with Resolve on every
 * device, or "Give up the move" ends it on the server alone. After the
 * target commits nothing is ever undone: the commit is retried until it
 * lands, and one refused as settled is checked against the window's row —
 * a window put back underneath the carry is begun again and committed, and
 * the person is never told the move finished elsewhere without looking.
 */

// ---- ports ------------------------------------------------------------------

export interface MoveHost {
  readonly id: string;
  readonly name: string;
  readonly os: string | null;
  readonly publicKey: string | null;
}

/** One host's channel for a move: the carrier and the reads the dialog needs. */
export interface MoveChannel extends ConversationCarrierTransport {
  readonly hostId: string;
  readonly state: TransportState;
  readonly connectionInfo?: ConnectionInfo | null;
  hasCapability(operation: string): boolean;
  inspectConversation(
    sessionId: string,
    options?: HostRequestOptions,
  ): Promise<ConversationInspection>;
  readHead(path: string, limit: number, options?: HostRequestOptions): Promise<HostReadHead>;
  agentTranscripts?(
    query: AgentTranscriptQuery,
    options?: HostRequestOptions,
  ): Promise<AgentTranscriptReport>;
  request<T>(operation: string, payload?: unknown, options?: HostRequestOptions): Promise<T>;
}

export interface MoveChannelLease {
  readonly channel: MoveChannel;
  release(): void;
}

export interface MoveChannels {
  /** A ready channel to `host`; rejects when none is to be had in time. */
  open(host: MoveHost, signal?: AbortSignal): Promise<MoveChannelLease>;
}

export interface MoveServer {
  begin(sessionId: string, expectedHostId: string): Promise<Session>;
  /** `/move`: carried (`carried: true`) after a begin, or fresh without it. */
  commit(sessionId: string, body: SessionMove): Promise<Session>;
  abort(sessionId: string, expectedHostId: string): Promise<Session>;
  /** The window's row as the server has it now; null once it is closed. */
  get(sessionId: string): Promise<Session | null>;
}

export interface MoveLaunches {
  /** The resume line for the window as it will run on `hostId`, and what is
   *  owed after it (`pending-agent-input.ts`) — provisional: nothing types
   *  them until `confirm`, so a commit that never lands leaves nothing that
   *  a later opening of the window could type into a live Claude. */
  queue(sessionId: string, hostId: string, line: string, arrival: MoveArrival): Promise<void>;
  /** The commit made that incarnation: the records may be typed. */
  confirm(sessionId: string, hostId: string): Promise<void>;
  /** The commit did not answer, or was refused: the provisional records go. */
  discard(sessionId: string, hostId: string): Promise<void>;
}

export interface MoveDeps {
  readonly channels: MoveChannels;
  readonly server: MoveServer;
  readonly launches: MoveLaunches;
  /**
   * Restart the window where it is with `line` queued for this device to
   * type — a put-back's resume, in the mode its record carries
   * (`putBackLine`) — or, without one, the ordinary restart
   * (`restartSessionAgent`).
   */
  restart(session: Session, line: string | null): Promise<unknown>;
  newTransferId(): string;
  sleep?(ms: number): Promise<void>;
}

// ---- what the dialog shows ---------------------------------------------------

export type ConversationState = "running" | "blocked" | "idle";

export interface MoveRequest {
  readonly session: Session;
  readonly agent: AgentDef;
  readonly from: MoveHost;
  readonly to: MoveHost;
  /** The folder picked on the target. */
  readonly cwd: string;
}

export interface MovePlan {
  readonly request: MoveRequest;
  readonly conversationId: string;
  readonly state: ConversationState;
  readonly probe: ConversationProbe;
  readonly sizeBytes: number | null;
  readonly source: MoveChannelLease;
  readonly target: MoveChannelLease;
}

export interface MoveDialog {
  readonly title: string;
  readonly body: string;
  readonly stateLine: string;
  /** Neutral facts: the folders agree, an older copy is set aside. */
  readonly info: readonly string[];
  /** Amber lines: they apply, and the move still goes. */
  readonly warnings: readonly string[];
  readonly defaultMode: PermissionMode;
}

export type MovePreview =
  | { readonly kind: "ready"; readonly plan: MovePlan; readonly dialog: MoveDialog }
  /** The conversation cannot come along; starting a new one there is still
   *  on offer — "Start fresh instead", or "Start fresh on <to>" when the
   *  question is whether to (the source is offline). */
  | {
      readonly kind: "blocked";
      readonly reason: string;
      readonly startFresh: "instead" | "on_target";
    }
  /** A host cannot carry yet: only a fresh move, said honestly. */
  | { readonly kind: "fresh"; readonly reason: string };

const PREFLIGHT_TIMEOUT_MS = 8_000;
const GIT_READ_LIMIT = 4 * 1024;
const PACKED_REFS_LIMIT = 256 * 1024;
const SETTINGS_LIMIT = 64 * 1024;
/**
 * The per-file cap a bundle carries — the only size the dialog refuses (OD3
 * as the owner decided it: carry everything, say how long it will take,
 * refuse only what the source cannot carry). Anything else the source finds
 * too large for one bundle it refuses itself, before anything stops
 * (`MOVE_REFUSED_TOO_LARGE`), as it does for the browser.
 */
const FILE_CAP_BYTES = 512 * 1024 * 1024;

const text = (head: HostReadHead) => new TextDecoder().decode(head.bytes);

function code(error: unknown): string | null {
  if (error instanceof HostControlTransportError) return error.code;
  if (error instanceof ApiError)
    return typeof error.detail === "string" ? error.detail : error.code;
  return null;
}

/** The host's own words about a refusal, shown dim at most — never its code. */
function detailOf(error: unknown): string | null {
  return error instanceof HostControlTransportError && error.detail && error.detail !== error.code
    ? error.detail
    : null;
}

/** Whether the server answered at all: a refusal it gave is certain, an
 *  answer that never came may have been a commit that landed. */
function answered(error: unknown): boolean {
  return error instanceof ApiError && error.status > 0;
}

async function quietly<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch {
    return null;
  }
}

/**
 * Ask the source for its shell, for the line a put-back types there
 * (`putBackLine`). Never throws: a source that cannot answer leaves a POSIX
 * line.
 */
export async function readPutBackFacts(
  channel: MoveChannel | null,
  query: { conversationId: string; cwd: string },
): Promise<PutBackFacts> {
  if (!channel) return NO_PUT_BACK_FACTS;
  const probe = await quietly(
    channel.conversationProbe(query, { timeoutMs: PREFLIGHT_TIMEOUT_MS }),
  );
  return probe ? { loginShell: probe.loginShell } : NO_PUT_BACK_FACTS;
}

/**
 * The line that leaves a window put back running its agent: the conversation
 * that was moving, resumed on the source in the mode its record carries there
 * — the one the window ran in before the move. Null for no agent or no
 * conversation to name: the ordinary restart.
 */
export async function putBackResume(
  channel: MoveChannel | null,
  agent: AgentDef | null,
  conversationId: string | null | undefined,
  cwd: string,
): Promise<string | null> {
  const id = canonicalConversationId(conversationId);
  if (!agent || !id) return null;
  return putBackLine(agent, id, await readPutBackFacts(channel, { conversationId: id, cwd }));
}

/** The commit a folder is on, read from its `.git` without running git. */
export async function readFolderCommit(
  channel: MoveChannel,
  cwd: string,
): Promise<FolderCommit | null> {
  const options = { timeoutMs: PREFLIGHT_TIMEOUT_MS };
  const read = (path: string, limit = GIT_READ_LIMIT) =>
    quietly(channel.readHead(path, limit, options).then(text));
  const dotGit = joinHostPath(cwd, ".git");
  let gitDir = dotGit;
  let head = await read(joinHostPath(dotGit, "HEAD"));
  if (head === null) {
    // A linked worktree or submodule: `.git` is a file naming its git dir.
    const pointer = parseGitDirPointer((await read(dotGit)) ?? "");
    if (!pointer) return null;
    gitDir = joinHostPath(cwd, pointer);
    head = await read(joinHostPath(gitDir, "HEAD"));
  }
  const parsed = head === null ? null : parseGitHead(head);
  if (!parsed) return null;
  if (parsed.kind === "detached") return { branch: null, commit: parsed.commit };
  const ref = `refs/heads/${parsed.branch}`;
  const commonDir = (await read(joinHostPath(gitDir, "commondir")))?.split("\n")[0]?.trim();
  const dirs = [gitDir, ...(commonDir ? [joinHostPath(gitDir, commonDir)] : [])];
  for (const dir of dirs) {
    const loose = parseLooseRef((await read(joinHostPath(dir, ref))) ?? "");
    if (loose) return { branch: parsed.branch, commit: loose };
  }
  for (const dir of dirs) {
    const packed = await read(joinHostPath(dir, "packed-refs"), PACKED_REFS_LIMIT);
    const commit = packed === null ? null : findPackedRef(packed, ref);
    if (commit) return { branch: parsed.branch, commit };
  }
  return { branch: parsed.branch, commit: null };
}

/** The folder line, or the warning, the two heads call for (the browser's
 *  three templates). */
function folderLines(
  names: { from: string; to: string; cwd: string },
  source: FolderCommit | null,
  target: FolderCommit | null,
): { info: string[]; warnings: string[] } {
  const comparison = compareFolders(source, target);
  if (comparison?.kind === "same") {
    return { info: [copy.moveBothOn(comparison.branch, comparison.commit)], warnings: [] };
  }
  if (comparison?.kind === "different") {
    return {
      info: [],
      warnings: [
        copy.moveHeadsDiffer(
          names.from,
          copy.moveHeadLabel(comparison.from.branch, comparison.from.commit),
          names.to,
          copy.moveHeadLabel(comparison.to.branch, comparison.to.commit),
        ),
      ],
    };
  }
  // A repository here and none there: nothing to compare it with.
  if (source && !target)
    return { info: [], warnings: [copy.moveNotARepository(names.to, names.cwd)] };
  return { info: [], warnings: [] };
}

function stateOf(inspection: ConversationInspection | null): ConversationState {
  if (inspection?.state === "running" || inspection?.state === "blocked") return inspection.state;
  return "idle";
}

/** Host names joined as a sentence names them: "dream", "dream and mac". */
function joinNames(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Everything the dialog needs, asked of both hosts before anything changes
 * (about a second, shown as "Checking <from> and <to>…"). Nothing is
 * stopped, carried or written here. The channels it opens are the move's:
 * a confirmed move keeps them, a cancelled dialog lets them go
 * (`releasePlan`). The browser checks and says the same
 * (web/src/lib/move/preflight.ts).
 */
export async function previewMove(
  request: MoveRequest,
  deps: Pick<MoveDeps, "channels">,
  signal?: AbortSignal,
): Promise<MovePreview> {
  const { session, agent, from, to } = request;
  const cwdLabel = displayPath(request.cwd);
  const [source, target] = await Promise.all([
    deps.channels.open(from, signal).catch(() => null),
    deps.channels.open(to, signal).catch(() => null),
  ]);
  const release = () => {
    source?.release();
    target?.release();
  };
  const blocked = (reason: string, startFresh: "instead" | "on_target" = "instead") => {
    release();
    return { kind: "blocked", reason, startFresh } as const;
  };
  // The server decides whether a fresh move can go there: it is offered.
  if (!target) return blocked(copy.moveNotConnected(to.name));
  if (!source) return blocked(copy.moveSourceOffline(from.name, to.name), "on_target");
  const lacking = [
    [source, from],
    [target, to],
  ]
    .filter(
      ([lease]) =>
        !(lease as MoveChannelLease).channel.hasCapability(CONVERSATION_CARRIER_CAPABILITY),
    )
    .map(([, host]) => (host as MoveHost).name);
  if (lacking.length > 0) {
    release();
    return { kind: "fresh", reason: copy.moveCarrierMissing(joinNames(lacking), to.name) };
  }

  const options = { timeoutMs: PREFLIGHT_TIMEOUT_MS };
  // A stopped window has no worker to ask about: its recorded conversation
  // stands, and it comes back idle.
  const inspection = await quietly(source.channel.inspectConversation(session.id, options));
  const about = inspection?.agent === CARRIED_AGENT ? inspection : null;
  const recorded = canonicalConversationId(session.agent_session_id);
  const conversationId = about?.conversation_id ?? recorded;
  const info: string[] = [];
  const warnings: string[] = [];
  if (!conversationId) return blocked(copy.MOVE_NO_CONVERSATION);
  if (about?.live_elsewhere) return blocked(copy.moveLiveElsewhere(from.name));
  if (about && !about.conversation_id) warnings.push(copy.MOVE_UNCONFIRMED_CONVERSATION);
  else if (about?.conversation_id && recorded && about.conversation_id !== recorded) {
    info.push(copy.MOVE_SWITCHED_CONVERSATION);
  }

  let probe: ConversationProbe;
  try {
    probe = await target.channel.conversationProbe({ conversationId, cwd: request.cwd }, options);
  } catch {
    return blocked(copy.moveCheckFailed(to.name));
  }
  if (probeSaysLive(probe)) return blocked(copy.moveLiveHere(to.name));
  if (!probe.storeReady) return blocked(copy.moveStoreNotReady(to.name));
  // The import refuses a folder that is not there (`folder_missing`), after
  // the source has stopped Claude: a move into one never begins. A fresh
  // move makes the folder.
  if (!probe.folderExists) return blocked(copy.moveFolderMissing(to.name, cwdLabel));

  const [report, sourceCommit, targetCommit, settings] = await Promise.all([
    source.channel.agentTranscripts
      ? quietly(
          source.channel.agentTranscripts(
            { agentKind: CARRIED_AGENT, conversationId, cwd: session.cwd },
            options,
          ),
        )
      : Promise.resolve(null),
    readFolderCommit(source.channel, session.cwd),
    readFolderCommit(target.channel, request.cwd),
    probe.store
      ? quietly(
          target.channel
            .readHead(joinHostPath(probe.store, "settings.json"), SETTINGS_LIMIT, options)
            .then(text),
        )
      : Promise.resolve(null),
  ]);
  // The conversation's own files, and what rides with every conversation;
  // another conversation's input is not carried.
  const files = report?.supported
    ? report.transcripts.filter(
        (file) => file.conversation_id === conversationId || file.role !== "input",
      )
    : [];
  const sizeBytes = files.length > 0 ? files.reduce((sum, file) => sum + file.size, 0) : null;
  if (files.some((file) => file.size > FILE_CAP_BYTES)) return blocked(copy.MOVE_TOO_LARGE);

  const folders = folderLines(
    { from: from.name, to: to.name, cwd: cwdLabel },
    sourceCommit,
    targetCommit,
  );
  info.push(...folders.info);
  warnings.push(...folders.warnings);
  if (sizeBytes !== null) {
    const seconds = estimateCarrySeconds(sizeBytes, [
      source.channel.connectionInfo,
      target.channel.connectionInfo,
    ]);
    if (seconds > ESTIMATE_SHOWN_ABOVE_SECONDS) {
      warnings.push(copy.moveEstimate(formatCarryDuration(seconds)));
    }
  }
  // Not a block: a login shell's PATH can find what the daemon's cannot.
  // Missing only when nothing was found: a `cliPath` with no version is a
  // Claude Code whose version is unknown, with nothing to compare. A daemon
  // that predates `cli_path` leaves it null, so its null version reads as before.
  if (probe.cliVersion === null) {
    if (probe.cliPath === null) warnings.push(copy.moveAgentNotFound(to.name));
  } else if (olderVersion(probe.cliVersion, about?.cli_version ?? null)) {
    warnings.push(
      copy.moveOlderAgent(to.name, probe.cliVersion, from.name, about?.cli_version ?? ""),
    );
  }
  if (probe.duplicates.length > 0) info.push(copy.moveDuplicateSetAside(to.name));
  const state = stateOf(about);
  return {
    kind: "ready",
    plan: { request, conversationId, state, probe, sizeBytes, source, target },
    dialog: {
      title: copy.moveTitle(to.name),
      body: copy.moveBody({ from: from.name, to: to.name, cwd: cwdLabel, bytes: sizeBytes }),
      stateLine: copy.moveStateLine(state, to.name),
      info,
      warnings,
      defaultMode: defaultPermissionMode(agent, settings),
    },
  };
}

/** Lets a plan's channels go: a dialog dismissed, or a move finished. */
export function releasePlan(plan: MovePlan): void {
  plan.source.release();
  plan.target.release();
}

// ---- the run ----------------------------------------------------------------

/**
 * What a failed move offers: go on (`retry`), put it back (`resume_source`),
 * a fresh move instead, Close — and, when a host cannot answer before the
 * target committed, giving the move up on the server alone (`give_up`), or,
 * when the conversation reached the target and the window did not, taking
 * the window there (`take_there`).
 */
export type MoveAction =
  | "retry"
  | "resume_source"
  | "start_fresh"
  | "close"
  | "give_up"
  | "take_there";

export interface MoveFailure {
  readonly message: string;
  /** The host's own words, where they help; never a code. */
  readonly detail: string | null;
  readonly actions: readonly MoveAction[];
  /** The window is still moving: Try again goes on with this transfer, and
   *  Resume on the source puts it back. */
  readonly held: boolean;
}

export type MovePhase =
  | { readonly step: "beginning" }
  | { readonly step: "stopping" }
  | { readonly step: "copying"; readonly sent: number; readonly total: number }
  | { readonly step: "starting" }
  /** Putting the conversation back on the source (Cancel, Resume on <from>). */
  | { readonly step: "restoring" }
  | {
      readonly step: "done";
      /**
       * `launched`: this device's commit made the incarnation and types its
       * resume; `archived`: committed into an archived workspace, nothing
       * typed; `landed`: the window is on the target, but not by a commit
       * this device knows it made — nothing is typed here.
       */
      readonly outcome: "launched" | "archived" | "landed";
      readonly session: Session;
      readonly state: ConversationState;
    }
  /** Put back on the source (Resume on <from>, a cancel), or given up. */
  | { readonly step: "restored"; readonly message: string }
  | { readonly step: "failed"; readonly failure: MoveFailure };

const CHUNK_BYTES = 8 * 1024;
const MAX_RESUMES = 3;
const MAX_COMMIT_TRIES = 3;
/** Begun again after a resolver put the window back underneath the carry. */
const MAX_REBEGINS = 2;
const BACKOFF_MS = [1_000, 3_000, 6_000] as const;

/** A channel or stream that went and can come back: resume the transfer. */
const TRANSIENT = new Set([
  "connection_lost",
  "connection_closed",
  "not_ready",
  "request_timeout",
  "stream_timeout",
  "superseded",
  "host_send_failed",
  "stream_send_failed",
  "outcome_unknown",
  "too_many_tasks",
  "too_many_streams",
  "integrity_mismatch",
  "host_unreachable",
  "host_stream_protocol",
  "cancelled",
]);

class Interrupted extends Error {
  constructor(readonly reason: "cancel" | "background") {
    super(reason);
  }
}

class Failed extends Error {
  constructor(readonly failure: MoveFailure) {
    super(failure.message);
  }
}

function chunkCount(length: number): number {
  return Math.ceil(length / CHUNK_BYTES);
}

/** Where the window stands after a carried commit was refused, the target
 *  having committed (the browser reads it the same way,
 *  web/src/lib/move/orchestrator.ts). */
type ConflictReading =
  /** On the target: finished, by an earlier commit whose answer was lost or
   *  by another device. */
  | { readonly kind: "arrived"; readonly session: Session }
  /** Put back on the source underneath the carry, and begun again there — or
   *  moving there again: the same carried commit goes again. */
  | { readonly kind: "again" }
  /** The conversation is on the target and the window cannot follow by
   *  this commit: the person is offered to take it there. */
  | { readonly kind: "stranded" }
  | { readonly kind: "gone" }
  /** The server could not be asked: try again. */
  | { readonly kind: "unknown" };

export class MoveRun {
  readonly sessionId: string;
  #transferId: string;
  readonly mode: PermissionMode;
  #phase: MovePhase = { step: "beginning" };
  readonly #listeners = new Set<(phase: MovePhase) => void>();
  #session: Session;
  #began = false;
  /** Whether the window was live as the move began (the begin's answer has
   *  no exit): a put-back restarts only a window the retire stopped. */
  #wasRunning: boolean | null = null;
  /** The export was asked for: the source may hold the files from here. */
  #exportAsked = false;
  /** How many exports went out: a refusal of the first leaves nothing held,
   *  a refusal of a resumed one can (the fence runs again over held files). */
  #exportDispatches = 0;
  #export: ConversationExportDeclaration | null = null;
  /** The source put back files its retire held: that retire ran, and it
   *  stopped the window first. */
  #retireHeld = false;
  #knownStopped = false;
  #digest: { length: number; sha256: string } | null = null;
  #committed: ConversationCommitted | null = null;
  #retired = false;
  #finished = false;
  /** A commit went out and its answer never came: it may have landed. */
  #commitUncertain = false;
  /** Provisional resume records written for the target, not yet confirmed. */
  #launchQueued = false;
  #running: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #released = false;
  #source: MoveChannelLease;
  #target: MoveChannelLease;
  /** What the window was doing, and in which conversation, sampled again
   *  as the person confirms, before anything stops. */
  #state: ConversationState;
  #conversationId: string;
  #sampled = false;

  constructor(
    readonly plan: MovePlan,
    mode: PermissionMode,
    private readonly deps: MoveDeps,
  ) {
    this.sessionId = plan.request.session.id;
    this.#transferId = deps.newTransferId();
    this.mode = mode;
    this.#session = plan.request.session;
    this.#source = plan.source;
    this.#target = plan.target;
    this.#state = plan.state;
    this.#conversationId = plan.conversationId;
  }

  get phase(): MovePhase {
    return this.#phase;
  }

  /** Whether the target has committed: from here the move only goes forward. */
  get committed(): boolean {
    return this.#committed !== null;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  subscribe(listener: (phase: MovePhase) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Runs the move to its end: done, failed, or put back. */
  start(): Promise<void> {
    return this.#run(() => this.#advance());
  }

  /** The transfer this move carries, a UUIDv4 this device chose. */
  get transferId(): string {
    return this.#transferId;
  }

  /** After a failure: go on with this transfer from where it stands — or,
   *  when nothing is held anywhere (a refused retire, a move put back),
   *  start again under a new transfer, the old one being settled. */
  retry(): Promise<void> {
    if (!this.#running && !this.#began && !this.#committed && this.#phase.step !== "beginning") {
      this.#fresh();
    }
    return this.#run(() => this.#advance());
  }

  #fresh(): void {
    this.#transferId = this.deps.newTransferId();
    this.#sampled = false;
    this.#exportAsked = false;
    this.#exportDispatches = 0;
    this.#export = null;
    this.#retireHeld = false;
    this.#knownStopped = false;
    this.#digest = null;
    this.#retired = false;
    this.#finished = false;
    this.#wasRunning = null;
  }

  /** "Resume on <from>": put everything back and restart it there. Refused
   *  once the target has committed. */
  putBack(): Promise<void> {
    if (this.#committed) return this.retry();
    return this.#run(() => this.#putBack(copy.moveBackOn(this.plan.request.from.name)));
  }

  /**
   * "Give up the move": a host that will not answer keeps the move from
   * being finished or put back, so the server's move is ended on its own,
   * touching neither host. The window stops where it was; whatever the
   * source set aside stays there, listed on its page, until a Resolve
   * reaches it. Never once the target has committed.
   */
  giveUp(): Promise<void> {
    if (this.#committed) return Promise.resolve();
    return this.#run(async () => {
      const { session, from } = this.plan.request;
      if (this.#began) {
        try {
          await this.deps.server.abort(session.id, from.id);
        } catch (error) {
          const reason = code(error);
          if (reason !== "move_conflict" && !(error instanceof ApiError && error.status === 404)) {
            throw new Failed({
              message: copy.moveAbortFailed(from.name),
              detail: null,
              actions: ["give_up", "close"],
              held: true,
            });
          }
        }
        this.#began = false;
      }
      this.#finished = true;
      this.#set({ step: "restored", message: copy.moveGivenUp(from.name) });
    });
  }

  /**
   * "Take the window to <to>": the conversation reached the target and the
   * window did not (it was put back underneath the carry and could not be
   * begun again). A fresh move naming the carried conversation takes it
   * there, its resume queued as the carried commit's would be.
   */
  takeThere(): Promise<void> {
    if (!this.#committed) return Promise.resolve();
    return this.#run(async () => {
      const { session, agent, to, cwd } = this.plan.request;
      this.#set({ step: "starting" });
      const row = await this.deps.server.get(session.id).catch(() => undefined);
      if (row === null) return this.#closedMeanwhile();
      if (row === undefined) {
        throw new Failed({
          message: copy.MOVE_COMMIT_FAILED,
          detail: null,
          actions: ["take_there", "close"],
          held: false,
        });
      }
      if (row.host_id === to.id) return this.#landed(row);
      await this.#queueLaunch();
      let moved: Session;
      try {
        moved = await this.deps.server.commit(session.id, {
          host_id: to.id,
          cwd,
          expected_host_id: row.host_id,
          agent_id: agent.id,
          agent_session_id: this.#conversationId,
        });
      } catch (error) {
        await this.#discardLaunch();
        const reason = code(error);
        if (error instanceof ApiError && error.status === 404) return this.#closedMeanwhile();
        throw new Failed({
          message:
            reason === "move_in_progress"
              ? copy.MOVE_IN_PROGRESS
              : reason === "workspace_archived"
                ? copy.MOVE_WORKSPACE_ARCHIVED
                : reason === "target_offline"
                  ? copy.moveCommitOffline(to.name)
                  : copy.moveConversationThere(to.name),
          detail: null,
          actions: reason === "workspace_archived" ? ["close"] : ["take_there", "close"],
          held: false,
        });
      }
      await this.#confirmLaunch();
      this.#finished = true;
      this.#set({ step: "done", outcome: "launched", session: moved, state: this.#state });
    });
  }

  /** The person's Cancel, mid-move: stop, then put it back. */
  cancel(): void {
    if (this.#committed) return;
    this.#abort?.abort(new Interrupted("cancel"));
  }

  /** SPAWN D left the foreground past its deadline: the host channels are
   *  gone, so the move stops where it is, held, for Try again or Resume. */
  interrupt(): void {
    this.#abort?.abort(new Interrupted("background"));
  }

  /** Nothing more will run: whatever is still going stops where it is,
   *  the channels go, and a resume line still waiting on a commit that never
   *  answered is dropped — nothing is typed later into a Claude another
   *  device started. */
  dispose(): void {
    if (this.#released) return;
    this.#released = true;
    this.#abort?.abort(new Interrupted("background"));
    if (this.#launchQueued) void this.#discardLaunch();
    this.#source.release();
    this.#target.release();
  }

  #set(phase: MovePhase): void {
    this.#phase = phase;
    for (const listener of this.#listeners) listener(phase);
  }

  #run(work: () => Promise<void>): Promise<void> {
    if (this.#running) return this.#running;
    const controller = new AbortController();
    this.#abort = controller;
    this.#running = (async () => {
      try {
        await work();
      } catch (error) {
        await this.#settleError(error, controller.signal);
      } finally {
        this.#running = null;
        if (this.#abort === controller) this.#abort = null;
      }
    })();
    return this.#running;
  }

  async #settleError(error: unknown, signal: AbortSignal): Promise<void> {
    const reason = signal.aborted ? signal.reason : error;
    const { from, to } = this.plan.request;
    if (reason instanceof Interrupted && reason.reason === "cancel" && !this.#committed) {
      this.#abort = new AbortController();
      try {
        await this.#putBack(copy.moveCancelled(from.name));
      } catch (putting) {
        this.#set({ step: "failed", failure: this.#failureOf(putting) });
      }
      return;
    }
    if (reason instanceof Interrupted) {
      this.#set({
        step: "failed",
        failure: {
          message: this.#committed
            ? copy.moveBackgroundCommitted(to.name)
            : copy.moveBackground(from.name),
          detail: null,
          actions: this.#committed
            ? ["retry", "close"]
            : this.#began
              ? ["retry", "resume_source"]
              : ["retry", "close"],
          held: this.#began,
        },
      });
      return;
    }
    this.#set({ step: "failed", failure: this.#failureOf(error) });
  }

  #failureOf(error: unknown): MoveFailure {
    if (error instanceof Failed) return error.failure;
    const { from, to } = this.plan.request;
    return {
      message: this.#committed
        ? copy.MOVE_COMMIT_FAILED
        : code(error) === "integrity_mismatch"
          ? copy.moveHeldMismatch(to.name, from.name)
          : copy.moveHeldConnection(to.name, from.name),
      detail: detailOf(error),
      actions: this.#committed ? ["retry", "close"] : ["retry", "resume_source"],
      held: this.#began,
    };
  }

  #signal(): AbortSignal {
    return this.#abort?.signal ?? new AbortController().signal;
  }

  #check(): void {
    const signal = this.#signal();
    if (signal.aborted) throw signal.reason ?? new Interrupted("cancel");
  }

  async #sleep(ms: number): Promise<void> {
    const sleep = this.deps.sleep ?? ((delay: number) => new Promise((r) => setTimeout(r, delay)));
    await this.#guard(sleep(ms).then(() => undefined));
  }

  /** Races a host's answer against the person's Cancel and the background;
   *  the listener goes with the answer, so a long carry gathers none. */
  #guard<T>(work: Promise<T>): Promise<T> {
    const signal = this.#signal();
    void work.catch(() => undefined);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  // ---- forward --------------------------------------------------------------

  async #advance(): Promise<void> {
    if (this.#finished) return;
    if (!this.#began) {
      await this.#sample();
      await this.#begin();
    }
    if (!this.#committed) await this.#carry();
    if (!this.#retired) await this.#retireCommit();
    await this.#commit();
  }

  /**
   * Whether Claude is working, waiting or idle is read again when the
   * person confirms — the dialog may have been open a while — and so is the
   * conversation the window is in; the note follows what was true then. An
   * answer that cannot be had leaves the dialog's.
   */
  async #sample(): Promise<void> {
    if (this.#sampled || this.#exportAsked) return;
    this.#sampled = true;
    this.#set({ step: "beginning" });
    const inspection = await this.#guard(
      this.#source.channel
        .inspectConversation(this.sessionId, { timeoutMs: PREFLIGHT_TIMEOUT_MS })
        .catch(() => null),
    );
    if (inspection?.agent !== CARRIED_AGENT) return;
    this.#state = stateOf(inspection);
    if (inspection.conversation_id) this.#conversationId = inspection.conversation_id;
  }

  async #begin(): Promise<void> {
    const { session, from, to } = this.plan.request;
    this.#set({ step: "beginning" });
    let began: Session;
    try {
      // Not raced against Cancel: a begin the server took has to be undone,
      // so its answer is awaited and a Cancel then acts on what it said.
      began = await this.deps.server.begin(session.id, from.id);
    } catch (error) {
      this.#check();
      const reason = code(error);
      const fail = (message: string, actions: MoveAction[] = ["close"]) =>
        new Failed({ message, detail: null, actions, held: false });
      if (reason === "source_offline") {
        throw fail(copy.moveSourceOffline(from.name, to.name), ["start_fresh", "close"]);
      }
      if (reason === "move_in_progress") throw fail(copy.MOVE_IN_PROGRESS);
      if (reason === "move_conflict") throw fail(copy.MOVE_CONFLICT_RESTART);
      if (reason === "workspace_archived") throw fail(copy.MOVE_WORKSPACE_ARCHIVED);
      if (error instanceof ApiError && error.status === 404) throw fail(copy.MOVE_WINDOW_GONE);
      throw fail(copy.MOVE_BEGIN_FAILED, ["retry", "close"]);
    }
    this.#session = began;
    this.#began = true;
    // `exited_at` is null exactly when the window was live as the move began.
    this.#wasRunning ??= began.exited_at === null;
    this.#check();
  }

  async #carry(): Promise<void> {
    const { from, to } = this.plan.request;
    const cwdLabel = displayPath(this.plan.request.cwd);
    let resumes = 0;
    for (;;) {
      this.#check();
      try {
        const committed = await this.#carryOnce();
        this.#committed = committed;
        return;
      } catch (error) {
        if (error instanceof Interrupted || error instanceof Failed) throw error;
        const reason = code(error);
        const held = (message: string, actions: MoveAction[] = ["retry", "resume_source"]) =>
          new Failed({ message, detail: null, actions, held: true });
        if (!this.#export && reason !== null && !TRANSIENT.has(reason)) {
          // The source refused the export (the import begins only once it
          // has answered). A refusal leaves nothing held — save a resumed
          // export's (its fence ran again over files an earlier one holds)
          // and a fence that could not put the files back (`stranded`, said
          // by the original code): the source's own listing tells. Either
          // is put back in the one safe order before the server's move ends.
          if (this.#exportDispatches > 1 || (await this.#sourceHolds())) {
            await this.#putBack(copy.moveBackOn(from.name));
          }
          throw await this.#refused(reason, detailOf(error));
        }
        if (reason === "conversation_live_here")
          throw held(copy.moveHeldLiveHere(to.name, from.name));
        if (reason === "transfer_cancelled" || reason === "transfer_aborted") {
          // Another device gave this transfer up: put the rest back.
          await this.#putBack(copy.moveBackOn(from.name));
          throw new Failed({
            message: copy.MOVE_CONFLICT_SETTLED,
            detail: null,
            actions: ["close"],
            held: false,
          });
        }
        if (reason === "folder_missing" || reason === "outside_root") {
          throw held(copy.moveHeldFolderMissing(to.name, cwdLabel, from.name));
        }
        if (reason === "store_missing" || reason === "store_unavailable") {
          throw held(copy.moveHeldStoreMissing(to.name, from.name));
        }
        if (reason === "insufficient_space") throw held(copy.moveHeldNoRoom(to.name, from.name));
        if (reason === "too_many_transfers") throw held(copy.moveHeldTooMany(to.name, from.name));
        if (reason === "file_changed") throw held(copy.moveHeldChanged(from.name));
        if (reason !== null && !TRANSIENT.has(reason)) {
          throw new Failed({
            message: copy.moveHeldCopyFailed(to.name, from.name),
            detail: detailOf(error),
            actions: ["retry", "resume_source"],
            held: true,
          });
        }
        resumes += 1;
        if (resumes > MAX_RESUMES) throw error;
        await this.#sleep(BACKOFF_MS[Math.min(resumes - 1, BACKOFF_MS.length - 1)] ?? 1_000);
        await this.#reopenChannels();
      }
    }
  }

  /** Whether the source lists this move's transfer as held. */
  async #sourceHolds(): Promise<boolean> {
    const listing = await this.#guard(
      this.#source.channel.conversationTransfers({ timeoutMs: 15_000 }).catch(() => null),
    );
    return listing?.outgoing.some((item) => item.transferId === this.transferId) ?? false;
  }

  /** A channel that failed is replaced; one reconnecting is waited for by
   *  its next request. */
  async #reopenChannels(): Promise<void> {
    const { from, to } = this.plan.request;
    if (this.#source.channel.state === "failed" || this.#source.channel.state === "closed") {
      const lease = await this.#guard(this.deps.channels.open(from)).catch((error) => {
        if (error instanceof Interrupted) throw error;
        return null;
      });
      if (lease) {
        this.#source.release();
        this.#source = lease;
      }
    }
    if (this.#target.channel.state === "failed" || this.#target.channel.state === "closed") {
      const lease = await this.#guard(this.deps.channels.open(to)).catch((error) => {
        if (error instanceof Interrupted) throw error;
        return null;
      });
      if (lease) {
        this.#target.release();
        this.#target = lease;
      }
    }
  }

  /** One pass of the carry: the export (or its resume), the import (or its
   *  resume), and the pump to the target's commit. */
  async #carryOnce(): Promise<ConversationCommitted> {
    const { session, to, from } = this.plan.request;
    const source = this.#source.channel;
    const target = this.#target.channel;
    let next = 0;
    if (this.#export) {
      const status = await this.#guard(target.conversationImportStatus(this.transferId));
      if (status.state === "committed") return this.#committedFromProbe();
      if (status.state === "cancelled") {
        throw new HostControlTransportError("transfer_cancelled", "The import was cancelled.");
      }
      next = status.nextSequence;
    } else {
      this.#set({ step: "stopping" });
    }
    this.#exportAsked = true;
    this.#exportDispatches += 1;
    const signal = this.#signal();
    const exporting = source.conversationExport(
      {
        transferId: this.transferId,
        conversationId: this.#conversationId,
        sessionId: session.id,
        toHostId: to.id,
        cwd: session.cwd,
        fromSequence: next,
      },
      { timeoutMs: 60_000 },
    );
    // An answer that comes after a Cancel or the background opened a stream
    // nobody will read: it is ended, and the transfer waits as it was.
    exporting.then(
      (late) => {
        if (signal.aborted) late.reader.cancel();
      },
      () => undefined,
    );
    const exported = await this.#guard(exporting);
    const declaration = exported.declaration;
    if (this.#export && this.#export.length !== declaration.length) {
      exported.reader.cancel();
      throw new HostControlTransportError("resume_mismatch", "The bundle changed.");
    }
    this.#export ??= declaration;
    if (declaration.stopped === "stopped" || declaration.stopped === "lingering") {
      this.#knownStopped = true;
    }
    let writer: StreamV2Writer;
    try {
      const importing = target.conversationImport(
        {
          transferId: this.transferId,
          conversationId: this.#conversationId,
          cwd: this.plan.request.cwd,
          length: declaration.length,
          sha256: null,
          fromHostId: from.id,
        },
        { timeoutMs: 60_000 },
      );
      importing.then(
        (late) => {
          if (signal.aborted) late.writer.cancel();
        },
        () => undefined,
      );
      const opened = await this.#guard(importing);
      writer = opened.writer;
      if (opened.opened.nextSequence !== next) {
        // The target holds a different amount than its status said a moment
        // ago: carry on from what it holds now.
        exported.reader.cancel();
        writer.cancel();
        throw new HostControlTransportError("superseded", "The import moved on.");
      }
    } catch (error) {
      exported.reader.cancel();
      if (code(error) === "transfer_committed") return this.#committedFromProbe();
      throw error;
    }
    return this.#pump(exported.reader, writer, next, declaration.length);
  }

  async #pump(
    reader: StreamV2Reader,
    writer: StreamV2Writer,
    start: number,
    length: number,
  ): Promise<ConversationCommitted> {
    let next = start;
    this.#set({ step: "copying", sent: Math.min(next * CHUNK_BYTES, length), total: length });
    try {
      for (;;) {
        const item = await this.#guard(reader.next());
        if (item.kind === "end") {
          if (item.length !== length || next !== chunkCount(length)) {
            throw new HostControlTransportError("invalid_stream_end", "The bundle ended early.");
          }
          this.#digest = { length: item.length, sha256: item.sha256 };
          const committed = await this.#guard(writer.end(item.length, item.sha256));
          if (committed.length !== null && committed.sha256 !== null) {
            this.#digest = { length: committed.length, sha256: committed.sha256 };
          }
          try {
            return parseConversationCommitted(committed.result);
          } catch {
            return this.#committedFromProbe();
          }
        }
        if (item.sequence !== next) {
          throw new HostControlTransportError("invalid_chunk", "A chunk came out of order.");
        }
        await this.#guard(writer.write(item.sequence, item.bytes));
        next += 1;
        reader.acknowledge(next);
        this.#set({ step: "copying", sent: Math.min(next * CHUNK_BYTES, length), total: length });
      }
    } catch (error) {
      reader.cancel();
      writer.cancel();
      throw error;
    }
  }

  /** The target committed without telling this device where (a status, or
   *  a commit result it could not read): what it said before the move. */
  #committedFromProbe(): ConversationCommitted {
    return {
      transferId: this.transferId,
      conversationId: this.#conversationId,
      cwd: this.plan.probe.cwd,
      memory: this.plan.probe.memory,
      setAside: 0,
    };
  }

  /** The export was refused and nothing is held on the source: give the
   *  server move up and say why, in words — never the source's code. */
  async #refused(reason: string, detail: string | null): Promise<Failed> {
    const { from } = this.plan.request;
    let restored: Session | null = null;
    try {
      restored = await this.#undoServer();
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      // The move stays begun; Resolve on any device ends it.
    }
    const message =
      reason === "conversation_live_elsewhere"
        ? copy.moveRefusedLiveElsewhere(from.name)
        : reason === "conversation_changed" || reason === "conversation_ambiguous"
          ? copy.moveRefusedChanged(from.name)
          : reason === "window_unavailable"
            ? copy.moveRefusedUnavailable(from.name)
            : reason === "agent_still_running"
              ? copy.moveRefusedNoStop(from.name)
              : reason === "window_restarted"
                ? copy.moveRefusedRestarted(from.name)
                : reason === "transfer_unresolved"
                  ? copy.moveRefusedUnresolved(from.name)
                  : reason === "too_large" || reason === "store_too_large"
                    ? copy.MOVE_REFUSED_TOO_LARGE
                    : copy.moveRefusedOther(from.name);
    const retryable =
      reason === "window_unavailable" ||
      reason === "conversation_changed" ||
      reason === "conversation_ambiguous";
    return new Failed({
      message,
      detail:
        restored?.status === "running"
          ? `${copy.moveStillRunning(from.name)}${detail ? ` ${detail}` : ""}`
          : detail,
      actions: retryable ? ["retry", "close"] : ["start_fresh", "close"],
      held: false,
    });
  }

  async #retireCommit(): Promise<void> {
    const source = this.#source.channel;
    let digest = this.#digest;
    if (!digest) {
      // Committed while this device was away from the stream: the source's
      // own record says what it declared, which is what the target took.
      const listing = await quietly(source.conversationTransfers({ timeoutMs: 15_000 }));
      const held = listing?.outgoing.find((item) => item.transferId === this.transferId);
      if (held?.length != null && held.sha256)
        digest = { length: held.length, sha256: held.sha256 };
    }
    if (!digest) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await source.conversationRetireCommit(
          { transferId: this.transferId, ...digest },
          { timeoutMs: 15_000 },
        );
        this.#retired = true;
        return;
      } catch (error) {
        const reason = code(error);
        if (reason === "transfer_committed") {
          this.#retired = true;
          return;
        }
        // Either order is recoverable: the source's record waits for a
        // resolver, out of Claude Code's lookup path meanwhile.
        if (reason === "declaration_mismatch" || reason === "transfer_not_found") return;
      }
    }
  }

  /** The resume line and note for the target, from what it committed. */
  #relaunch(committed: ConversationCommitted) {
    const { agent, from, to } = this.plan.request;
    const note = (os: { from: string | null; to: string | null }) => ({
      from: { name: from.name, os: os.from },
      to: { name: to.name, os: os.to },
      cwd: committed.cwd ?? this.plan.probe.cwd,
      memoryPath: committed.memory ?? this.plan.probe.memory,
      state: this.#state,
    });
    return (
      planRelaunch({
        agent,
        conversation: { resume: this.#conversationId },
        permissionMode: this.mode,
        shell: this.plan.probe.loginShell,
        note: note({ from: from.os, to: to.os }),
      }) ??
      // A shell the line cannot carry a note in: the note is typed instead.
      planRelaunch({
        agent,
        conversation: { resume: this.#conversationId },
        permissionMode: this.mode,
        shell: "unknown",
        note: note({ from: null, to: null }),
      })
    );
  }

  /** The resume records for the target, provisional until a commit answers. */
  async #queueLaunch(): Promise<void> {
    const committed = this.#committed;
    if (!committed || this.#released) return;
    const { session, from, to, cwd } = this.plan.request;
    const relaunch = this.#relaunch(committed);
    if (!relaunch) return;
    this.#launchQueued = true;
    await this.deps.launches.queue(session.id, to.id, relaunch.line, {
      version: 1,
      agent: copy.CLAUDE_CODE,
      to: to.name,
      from: from.name,
      cwd: displayPath(cwd),
      note: relaunch.note,
      line: relaunch.line,
    });
  }

  async #confirmLaunch(): Promise<void> {
    if (!this.#launchQueued) return;
    this.#launchQueued = false;
    await this.deps.launches
      .confirm(this.sessionId, this.plan.request.to.id)
      .catch(() => undefined);
  }

  async #discardLaunch(): Promise<void> {
    if (!this.#launchQueued) return;
    this.#launchQueued = false;
    await this.deps.launches
      .discard(this.sessionId, this.plan.request.to.id)
      .catch(() => undefined);
  }

  /** On the target, not by a commit this device knows it made: done, and
   *  nothing typed here — the device that made it types its own. */
  async #landed(session: Session): Promise<void> {
    await this.#discardLaunch();
    this.#finished = true;
    this.#set({ step: "done", outcome: "landed", session, state: this.#state });
  }

  #closedMeanwhile(): never {
    this.#finished = true;
    throw new Failed({
      message: copy.moveWindowClosed(this.plan.request.to.name),
      detail: null,
      actions: ["close"],
      held: false,
    });
  }

  /**
   * The server's carried commit, retried until it lands; never an abort.
   * A refusal that reads as settled is checked against the window's row,
   * never believed: the conversation is on the target whatever the row says.
   */
  async #commit(): Promise<void> {
    const { session, agent, from, to, cwd } = this.plan.request;
    if (!this.#committed) return;
    this.#set({ step: "starting" });
    const body: SessionMove = {
      host_id: to.id,
      cwd,
      expected_host_id: from.id,
      agent_id: agent.id,
      agent_session_id: this.#conversationId,
      carried: true,
    };
    let again = 0;
    for (let attempt = 1; ; attempt += 1) {
      await this.#queueLaunch();
      let moved: Session;
      try {
        moved = await this.deps.server.commit(session.id, body);
      } catch (error) {
        const reason = code(error);
        if (reason === "move_conflict" || reason === "move_in_progress") {
          const reading = await this.#readAfterConflict();
          if (reading.kind === "arrived") {
            // Finished: by an earlier commit of this device whose answer was
            // lost — its resume is typed here — or by another device, which
            // typed its own.
            if (this.#commitUncertain) {
              await this.#confirmLaunch();
              this.#finished = true;
              this.#set({
                step: "done",
                outcome: "launched",
                session: reading.session,
                state: this.#state,
              });
              return;
            }
            return this.#landed(reading.session);
          }
          await this.#discardLaunch();
          if (reading.kind === "again" && again < MAX_REBEGINS) {
            again += 1;
            attempt = 0;
            continue;
          }
          if (reading.kind === "gone") return this.#closedMeanwhile();
          if (reading.kind === "unknown") {
            throw new Failed({
              message: copy.MOVE_COMMIT_FAILED,
              detail: null,
              actions: ["retry", "close"],
              held: true,
            });
          }
          throw new Failed({
            message: copy.moveConversationThere(to.name),
            detail: null,
            actions: ["take_there", "close"],
            held: false,
          });
        }
        await this.#discardLaunch();
        if (error instanceof ApiError && error.status === 404) return this.#closedMeanwhile();
        if (!answered(error)) this.#commitUncertain = true;
        // target_offline, the network: never abort after the target
        // committed — the commit is retried until it lands.
        if (attempt >= MAX_COMMIT_TRIES) {
          throw new Failed({
            message:
              reason === "target_offline"
                ? copy.moveCommitOffline(to.name)
                : copy.MOVE_COMMIT_FAILED,
            detail: null,
            actions: ["retry", "close"],
            held: true,
          });
        }
        await this.#sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 1_000);
        continue;
      }
      this.#finished = true;
      if (moved.status === "killed") {
        // Archived meanwhile: it starts on its new host when restored, and
        // nothing is typed now.
        await this.#discardLaunch();
        this.#set({ step: "done", outcome: "archived", session: moved, state: this.#state });
        return;
      }
      await this.#confirmLaunch();
      this.#set({ step: "done", outcome: "launched", session: moved, state: this.#state });
      return;
    }
  }

  /**
   * After a carried commit was refused as settled: where the window is now.
   * On the target, it arrived. Put back on the source underneath the carry
   * (a resolver found no record yet and aborted) and no longer moving, it is
   * begun again there, so the same commit can go — the target committed, so
   * the move may only finish; still moving there, the commit simply goes
   * again. Anything else leaves the conversation on the target and the
   * window elsewhere.
   */
  async #readAfterConflict(): Promise<ConflictReading> {
    const { session, from, to } = this.plan.request;
    let row: Session | null;
    try {
      row = await this.deps.server.get(session.id);
    } catch {
      return { kind: "unknown" };
    }
    if (row === null) return { kind: "gone" };
    if (row.host_id === to.id) return { kind: "arrived", session: row };
    if (row.host_id !== from.id) return { kind: "stranded" };
    if (row.status === "moving") return { kind: "again" };
    try {
      this.#session = await this.deps.server.begin(session.id, from.id);
      this.#began = true;
      return { kind: "again" };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: "gone" };
      const reason = code(error);
      if (reason === "move_in_progress") return { kind: "again" };
      if (reason === "move_conflict" || !answered(error)) return { kind: "unknown" };
      return { kind: "stranded" };
    }
  }

  // ---- back -----------------------------------------------------------------

  /**
   * Put the conversation back on the source and the window with it, in the
   * one order that cannot leave two writers: the target's import cancelled
   * — it must answer "cancelled" (found committed, the move finishes
   * instead) — then the source's files put back, then the server move
   * aborted, then the window restarted on the source where its retire
   * stopped it.
   */
  async #putBack(message: string): Promise<void> {
    const { from, to } = this.plan.request;
    this.#set({ step: "restoring" });
    if (this.#exportAsked) {
      let cancelled: string | null = null;
      try {
        cancelled = (
          await this.#guard(
            this.#target.channel.conversationImportCancel(this.transferId, { timeoutMs: 15_000 }),
          )
        ).state;
      } catch (error) {
        if (error instanceof Interrupted) throw error;
        if (code(error) === "transfer_committed") {
          this.#committed = this.#committedFromProbe();
          await this.#advance();
          return;
        }
      }
      if (cancelled !== "cancelled") {
        throw new Failed({
          message: copy.moveUnresolvedTarget(to.name),
          detail: null,
          actions: ["resume_source", "give_up", "close"],
          held: true,
        });
      }
      try {
        await this.#guard(
          this.#source.channel.conversationRetireAbort(this.transferId, { timeoutMs: 15_000 }),
        );
        this.#retireHeld = true;
      } catch (error) {
        if (error instanceof Interrupted) throw error;
        const reason = code(error);
        if (reason === "already_exists") {
          this.#retireHeld = true;
          await this.#undoServer().catch(() => null);
          this.#finished = true;
          throw new Failed({
            message: copy.moveConflicts(from.name),
            detail: detailOf(error),
            actions: ["close"],
            held: false,
          });
        }
        if (reason !== "transfer_not_found" && reason !== "transfer_aborted") {
          throw new Failed({
            message: copy.moveUnresolvedSource(from.name),
            detail: null,
            actions: ["resume_source", "give_up", "close"],
            held: true,
          });
        }
      }
    }
    await this.#undoServer();
    this.#finished = true;
    this.#set({ step: "restored", message });
  }

  /**
   * The server move aborted and, where the retire stopped it, the window
   * restarted on the source with its resume queued: the export said it
   * stopped Claude, or the source had held this transfer (its retire ran,
   * and stopped the window first) while the window was live as the move
   * began, or the server recorded an exit of a window that was. A window
   * stopped before the move stays stopped, with its own Restart.
   */
  async #undoServer(): Promise<Session | null> {
    if (!this.#began) return null;
    const { session, from } = this.plan.request;
    let restored: Session;
    try {
      restored = await this.#guard(this.deps.server.abort(session.id, from.id));
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      if (code(error) === "move_conflict") {
        this.#began = false;
        return await quietly(this.deps.server.get(session.id));
      }
      if (error instanceof ApiError && error.status === 404) {
        this.#began = false;
        return null;
      }
      throw new Failed({
        message: copy.moveAbortFailed(from.name),
        detail: null,
        actions: ["resume_source", "close"],
        held: true,
      });
    }
    this.#began = false;
    const wasRunning = this.#wasRunning === true;
    const retireStopped =
      this.#knownStopped ||
      (this.#retireHeld && wasRunning) ||
      (restored.status === "killed" && wasRunning);
    if (retireStopped) {
      const line = await putBackResume(
        this.#source.channel,
        this.plan.request.agent,
        this.plan.conversationId,
        session.cwd,
      );
      await this.deps.restart(restored, line).catch(() => undefined);
    }
    return restored;
  }
}
