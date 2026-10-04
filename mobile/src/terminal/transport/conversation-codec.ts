import { canonicalConversationId } from "@/terminal/transport/conversation-id";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-codec";

/**
 * The conversation a window is actually in, as its host sees it.
 *
 * The server's `agent_session_id` is the id SPAWN D handed the agent at
 * launch, and Claude Code moves on from it: `/clear` and `/branch` start
 * another conversation, `/resume` adopts one, agent view forks the window's
 * conversation into a background job. The daemon answers `conv.inspect` from
 * the window's own processes and the agent's live-session registry, over the
 * device's host channel; the server never sees the question or the answer.
 * The one thing that reaches it is a Claude Code conversation id the host
 * named, which a restart writes back to the window's `agent_session_id`. The
 * same wire shape the web app reads.
 */

/** The `conv.*` family, one versioned capability for every operation in it. */
export const CONVERSATION_CAPABILITY = "conv.v1";
export const CONVERSATION_INSPECT_OP = "conv.inspect";

export type ConversationState = "running" | "blocked" | "idle" | "unknown";

/** `conv.inspect`'s answer, in its wire shape. */
export interface ConversationInspection {
  /** The agent kind, spelled as agent definitions spell it, or null. */
  readonly agent: string | null;
  readonly conversation_id: string | null;
  readonly state: ConversationState;
  readonly cli_version: string | null;
  /** Another process outside this window holds the conversation: a
   *  background session, an attach target, another window. Restart resumes
   *  it all the same: resuming a running background session attaches to it. */
  readonly live_elsewhere: boolean;
  /** What the daemon read: `registry`, `parked`, `attach`, `open_file`,
   *  `process`, `none`. A hint for diagnostics, never for gating. */
  readonly source: string;
}

const STATES: ReadonlySet<string> = new Set(["running", "blocked", "idle", "unknown"]);
const SHORT_TEXT = /^[\x21-\x7e]{1,64}$/;

function nullableText(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** A conversation id from the host: null, a UUID (`canonicalConversationId`),
 *  or undefined when it is something else and the answer is malformed. */
function nullableConversationId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return canonicalConversationId(value) ?? undefined;
}

/**
 * A daemon's answer, checked field by field. A state this client does not
 * know yet reads as `unknown` rather than as malformed, so a newer daemon
 * never breaks an older app; anything else malformed is refused. A
 * conversation id that is not a UUID is malformed; one in upper case is read
 * lower-case.
 */
export function parseConversationInspection(value: unknown): ConversationInspection {
  const invalid = () =>
    new HostControlTransportError(
      "invalid_response",
      "Host returned an invalid conversation report.",
    );
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const agent = nullableText(record["agent"], SHORT_TEXT);
  const conversationId = nullableConversationId(record["conversation_id"]);
  const cliVersion = nullableText(record["cli_version"], SHORT_TEXT);
  const liveElsewhere = record["live_elsewhere"];
  const source = record["source"];
  const state = record["state"];
  if (agent === undefined || conversationId === undefined || cliVersion === undefined) {
    throw invalid();
  }
  if (typeof liveElsewhere !== "boolean" || typeof source !== "string") throw invalid();
  return {
    agent,
    conversation_id: conversationId,
    state:
      typeof state === "string" && STATES.has(state) ? (state as ConversationState) : "unknown",
    cli_version: cliVersion,
    live_elsewhere: liveElsewhere,
    source,
  };
}

/**
 * The carrier: `conv.v2` is everything `conv.v1` is plus the operations a
 * device moves a conversation with — `conv.probe` on the host it goes to,
 * `conv.export` (retire) on the one it leaves, `conv.import.*` and
 * `conv.retire.*` to settle both ends, and `conv.transfers` for any device to
 * finish a move another one started (proto/README.md, "The conversation
 * carrier"). The device pipes bytes and never reads the bundle.
 */
export const CONVERSATION_CARRIER_CAPABILITY = "conv.v2";
export const CONVERSATION_PROBE_OP = "conv.probe";
export const CONVERSATION_EXPORT_OP = "conv.export";
export const CONVERSATION_IMPORT_BEGIN_OP = "conv.import.begin";
export const CONVERSATION_IMPORT_STATUS_OP = "conv.import.status";
export const CONVERSATION_IMPORT_CANCEL_OP = "conv.import.cancel";
export const CONVERSATION_RETIRE_COMMIT_OP = "conv.retire.commit";
export const CONVERSATION_RETIRE_ABORT_OP = "conv.retire.abort";
export const CONVERSATION_TRANSFERS_OP = "conv.transfers";
/** The only agent whose conversations travel in bundle v1. */
export const CARRIED_AGENT = "claude-code";
/** The largest window a device asks for (`limits.stream_window_max`, S4). */
export const CONVERSATION_STREAM_WINDOW = 16;

const SHA256 = /^[0-9a-f]{64}$/;

function invalid(what: string): HostControlTransportError {
  return new HostControlTransportError("invalid_response", `Host returned an invalid ${what}.`);
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(what);
  return value as Record<string, unknown>;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function requiredCount(value: unknown, what: string): number {
  const parsed = count(value);
  if (parsed === null) throw invalid(what);
  return parsed;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(what);
  return value;
}

function digestOrNull(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !SHA256.test(value)) throw invalid(what);
  return value;
}

function conversationIdOf(value: unknown, what: string): string {
  const id = canonicalConversationId(value);
  if (!id) throw invalid(what);
  return id;
}

export interface ConversationDuplicate {
  readonly folder: string;
  readonly path: string;
  readonly size: number | null;
  readonly live: boolean;
}

/** `conv.probe`: the target's facts before a move. */
export interface ConversationProbe {
  readonly home: string | null;
  /** The folder with every link resolved, as Claude Code files it. */
  readonly cwd: string | null;
  readonly folderExists: boolean;
  /** `CLAUDE_CONFIG_DIR` or `~/.claude` on the target. */
  readonly store: string | null;
  readonly storeReady: boolean;
  readonly storeProblem: string | null;
  /** The memory folder of the folder's repository root. */
  readonly memory: string | null;
  readonly repositoryRoot: string | null;
  readonly duplicates: readonly ConversationDuplicate[];
  /** A process on the target holds the conversation now (null: no id asked). */
  readonly live: boolean | null;
  /** The shell the host's windows start, by name. */
  readonly loginShell: string | null;
  readonly cliVersion: string | null;
}

export function parseConversationProbe(value: unknown): ConversationProbe {
  const record = objectOf(value, "conversation probe");
  if (typeof record["store_ready"] !== "boolean" || typeof record["folder_exists"] !== "boolean") {
    throw invalid("conversation probe");
  }
  const live = record["live"];
  if (live !== null && live !== undefined && typeof live !== "boolean") {
    throw invalid("conversation probe");
  }
  const duplicates = Array.isArray(record["duplicates"]) ? record["duplicates"] : [];
  return Object.freeze({
    home: optionalString(record["home"]),
    cwd: optionalString(record["cwd"]),
    folderExists: record["folder_exists"],
    store: optionalString(record["store"]),
    storeReady: record["store_ready"],
    storeProblem: optionalString(record["store_problem"]),
    memory: optionalString(record["memory"]),
    repositoryRoot: optionalString(record["repository_root"]),
    duplicates: Object.freeze(
      duplicates.flatMap((entry: unknown): ConversationDuplicate[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const duplicate = entry as Record<string, unknown>;
        return [
          {
            folder: optionalString(duplicate["folder"]) ?? "",
            path: optionalString(duplicate["path"]) ?? "",
            size: count(duplicate["size"]),
            live: duplicate["live"] === true,
          },
        ];
      }),
    ),
    live: typeof live === "boolean" ? live : null,
    loginShell: optionalString(record["login_shell"]),
    cliVersion: optionalString(record["cli_version"]),
  });
}

/** Whether a probe says a Claude on the target holds the conversation now:
 *  the import would be refused (`conversation_live_here`). */
export function probeSaysLive(probe: ConversationProbe): boolean {
  return probe.live === true || probe.duplicates.some((duplicate) => duplicate.live);
}

/** How the source's window went as the export took it out (`stopped`). */
export type ExportStop = "stopped" | "not_running" | "lingering" | "unknown";

/** `conv.export`'s answer: the read that carries the bundle. */
export interface ConversationExportDeclaration {
  readonly streamId: string;
  readonly transferId: string;
  readonly length: number;
  /** Null when the digest comes at the stream's end. */
  readonly sha256: string | null;
  readonly window: number;
  readonly nextSequence: number;
  readonly entries: number | null;
  readonly skipped: number | null;
  readonly stopped: ExportStop;
}

export function parseConversationExport(value: unknown): ConversationExportDeclaration {
  const record = objectOf(value, "conversation export");
  if (record["mode"] !== "retire") throw invalid("conversation export");
  const stopped = record["stopped"];
  const window = requiredCount(record["window"], "conversation export");
  if (window < 1) throw invalid("conversation export");
  return Object.freeze({
    streamId: requiredString(record["stream_id"], "conversation export"),
    transferId: conversationTransferId(record["transfer_id"]),
    length: requiredCount(record["length"], "conversation export"),
    sha256: digestOrNull(record["sha256"], "conversation export"),
    window,
    nextSequence: requiredCount(record["next_sequence"], "conversation export"),
    entries: count(record["entries"]),
    skipped: count(record["skipped"]),
    stopped:
      stopped === "stopped" || stopped === "not_running" || stopped === "lingering"
        ? stopped
        : "unknown",
  });
}

/** `conv.import.begin`'s answer: the write that takes the bundle in. */
export interface ConversationImportOpened {
  readonly streamId: string;
  readonly window: number;
  readonly nextSequence: number;
  readonly received: number;
}

export function parseConversationImportOpened(value: unknown): ConversationImportOpened {
  const record = objectOf(value, "conversation import");
  const window = requiredCount(record["window"], "conversation import");
  if (window < 1) throw invalid("conversation import");
  return Object.freeze({
    streamId: requiredString(record["stream_id"], "conversation import"),
    window,
    nextSequence: requiredCount(record["next_sequence"], "conversation import"),
    received: count(record["received"]) ?? 0,
  });
}

/** Stream v2's one status shape (`conv.import.status`, `conv.import.cancel`). */
export type ConversationTransferState = "absent" | "receiving" | "committed" | "cancelled";

export interface ConversationTransferStatus {
  readonly state: ConversationTransferState;
  readonly received: number;
  readonly nextSequence: number;
}

const TRANSFER_STATES: ReadonlySet<string> = new Set([
  "absent",
  "receiving",
  "committed",
  "cancelled",
]);

export function parseConversationTransferStatus(value: unknown): ConversationTransferStatus {
  const record = objectOf(value, "transfer status");
  const state = record["state"];
  if (typeof state !== "string" || !TRANSFER_STATES.has(state)) throw invalid("transfer status");
  return Object.freeze({
    state: state as ConversationTransferState,
    received: requiredCount(record["received"], "transfer status"),
    nextSequence: requiredCount(record["next_sequence"], "transfer status"),
  });
}

/** What the target placed (`stream.committed`'s `result`). */
export interface ConversationCommitted {
  readonly transferId: string;
  readonly conversationId: string;
  /** The folder Claude Code resumes it from. */
  readonly cwd: string | null;
  /** The memory folder the note names. */
  readonly memory: string | null;
  readonly setAside: number;
}

export function parseConversationCommitted(value: unknown): ConversationCommitted {
  const record = objectOf(value, "conversation commit");
  return Object.freeze({
    transferId: conversationTransferId(record["transfer_id"]),
    conversationId: conversationIdOf(record["conversation_id"], "conversation commit"),
    cwd: optionalString(record["cwd"]),
    memory: optionalString(record["memory"]),
    setAside: count(record["set_aside"]) ?? 0,
  });
}

/** An unfinished move this host is the source of (`conv.transfers`). */
export interface OutgoingConversationTransfer {
  readonly transferId: string;
  readonly conversationId: string;
  readonly sessionId: string | null;
  readonly toHostId: string | null;
  /** `moving`, `held` or `stranded` (only an abort ends a stranded one). */
  readonly state: string;
  readonly createdAt: number | null;
  readonly length: number | null;
  readonly sha256: string | null;
}

/** An unfinished move this host is the target of. */
export interface IncomingConversationTransfer {
  readonly transferId: string;
  readonly conversationId: string;
  readonly fromHostId: string | null;
  readonly state: string;
  readonly received: number;
  readonly nextSequence: number;
  readonly length: number | null;
  readonly createdAt: number | null;
}

export interface ConversationTransfers {
  readonly outgoing: readonly OutgoingConversationTransfer[];
  readonly incoming: readonly IncomingConversationTransfer[];
  readonly truncated: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A transfer id as a device chose it: a canonical lower-case UUID. */
function conversationTransferId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid("transfer");
  return value;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

export function parseConversationTransfers(value: unknown): ConversationTransfers {
  const record = objectOf(value, "transfer list");
  const outgoing = Array.isArray(record["outgoing"]) ? record["outgoing"] : [];
  const incoming = Array.isArray(record["incoming"]) ? record["incoming"] : [];
  return Object.freeze({
    outgoing: Object.freeze(
      outgoing.map((entry: unknown): OutgoingConversationTransfer => {
        const item = objectOf(entry, "transfer list");
        return Object.freeze({
          transferId: conversationTransferId(item["transfer_id"]),
          conversationId: conversationIdOf(item["conversation_id"], "transfer list"),
          sessionId: uuidOrNull(item["session_id"]),
          toHostId: uuidOrNull(item["to_host_id"]),
          state: requiredString(item["state"], "transfer list"),
          createdAt: count(item["created_at"]),
          length: count(item["length"]),
          sha256: digestOrNull(item["sha256"], "transfer list"),
        });
      }),
    ),
    incoming: Object.freeze(
      incoming.map((entry: unknown): IncomingConversationTransfer => {
        const item = objectOf(entry, "transfer list");
        return Object.freeze({
          transferId: conversationTransferId(item["transfer_id"]),
          conversationId: conversationIdOf(item["conversation_id"], "transfer list"),
          fromHostId: uuidOrNull(item["from_host_id"]),
          state: requiredString(item["state"], "transfer list"),
          received: count(item["received"]) ?? 0,
          nextSequence: count(item["next_sequence"]) ?? 0,
          length: count(item["length"]),
          createdAt: count(item["created_at"]),
        });
      }),
    ),
    truncated: record["truncated"] === true,
  });
}

/** `conv.retire.commit` and `conv.retire.abort` answers. */
export type RetireAnswer =
  | { readonly state: "retired"; readonly keptUntil: number | null }
  | { readonly state: "aborted"; readonly restored: number };

export function parseRetireAnswer(value: unknown): RetireAnswer {
  const record = objectOf(value, "retire answer");
  if (record["state"] === "retired") {
    return Object.freeze({ state: "retired", keptUntil: count(record["kept_until"]) });
  }
  if (record["state"] === "aborted") {
    return Object.freeze({ state: "aborted", restored: count(record["restored"]) ?? 0 });
  }
  throw invalid("retire answer");
}
