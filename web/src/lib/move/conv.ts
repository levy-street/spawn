/**
 * The conversation carrier, `conv.v2` (proto/README.md, "The conversation
 * carrier"), as a device asks it: one host's `conv.export` piped into
 * another's `conv.import.begin`, then settled on both. Every answer is
 * checked field by field here, so the orchestrator above works with values
 * it can trust the shape of. Paths in the answers stay in this device's
 * memory and on screen; none of them reaches the server.
 */

import { canonicalConversationId } from "@/lib/agent-relaunch";
import type {
  HostControlRequestOptions,
  HostStreamLimits,
  StreamV2Handlers,
} from "@/lib/hostControl";

/** The family: `conv.v1` (`conv.inspect`) plus the carrier. */
export const CONVERSATION_CARRIER_CAPABILITY = "conv.v2";

/** The part of a host-control client the carrier uses — a dedicated consumer
 *  channel per host and move (a channel carries at most two imports). */
export interface CarrierClient {
  request<T = unknown>(
    operation: string,
    payload?: unknown,
    options?: HostControlRequestOptions,
  ): Promise<T>;
  openStreamV2<T extends { stream_id: string }>(
    operation: string,
    payload: Record<string, unknown>,
    handlers: StreamV2Handlers,
    options?: HostControlRequestOptions,
  ): Promise<T>;
  sendStreamV2(
    type: "stream.ack" | "stream.end",
    streamId: string,
    values: Record<string, unknown>,
  ): void;
  sendChunkV2(streamId: string, sequence: number, chunk: Uint8Array): void;
  cancelStreamV2(streamId: string): void;
  getStreamLimits(): HostStreamLimits;
  bufferedAmount(): number;
  waitForBuffered(threshold: number, signal?: AbortSignal): Promise<void>;
  hasCapability(name: string): boolean;
}

/** A refused or failed request, as the daemon coded it. */
export interface CodedError {
  code: string;
  detail?: string;
}

export function errorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "request_failed";
}

export function errorDetail(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a failed request says nothing about what the host did: the channel
 * went, the answer never came. Anything the daemon coded is an answer.
 */
export function outcomeUnknown(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "connection_closed" || code === "outcome_unknown" || code === "request_failed")
    return true;
  const message = error instanceof Error ? error.message : "";
  return /timed out|not ready|connection closed|session ended|channel/i.test(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function digest(value: unknown): string | null {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function invalid(what: string): Error & CodedError {
  return Object.assign(new Error(`The host answered ${what} in a shape SPAWN D cannot read`), {
    code: "invalid_response",
  });
}

/** A transfer id: a canonical lower-case UUIDv4 this device chose. */
export function newTransferId(random: () => string = () => crypto.randomUUID()): string {
  return random().toLowerCase();
}

// ---- conv.probe ----------------------------------------------------------------

export interface ConversationDuplicate {
  folder: string;
  path: string;
  size: number | null;
  live: boolean;
}

export interface ConversationProbe {
  home: string | null;
  /** The folder with every link resolved, inside home. */
  cwd: string | null;
  folderExists: boolean;
  storeReady: boolean;
  storeProblem: string | null;
  /** Claude Code's store there: `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  store: string | null;
  /** The target's memory folder for this project, from its repository root. */
  memory: string | null;
  duplicates: ConversationDuplicate[];
  /** A Claude on the target holds the conversation now; null when not asked. */
  live: boolean | null;
  loginShell: string | null;
  cliVersion: string | null;
}

export function parseProbe(value: unknown): ConversationProbe {
  const answer = record(value);
  if (
    !answer ||
    typeof answer.folder_exists !== "boolean" ||
    typeof answer.store_ready !== "boolean"
  )
    throw invalid("conv.probe");
  const duplicates = Array.isArray(answer.duplicates)
    ? answer.duplicates.flatMap((item): ConversationDuplicate[] => {
        const entry = record(item);
        if (!entry) return [];
        return [
          {
            folder: text(entry.folder) ?? "",
            path: text(entry.path) ?? "",
            size: count(entry.size),
            live: entry.live === true,
          },
        ];
      })
    : [];
  return {
    home: text(answer.home),
    cwd: text(answer.cwd),
    folderExists: answer.folder_exists,
    storeReady: answer.store_ready,
    storeProblem: text(answer.store_problem),
    store: text(answer.store),
    memory: text(answer.memory),
    duplicates,
    live: typeof answer.live === "boolean" ? answer.live : null,
    loginShell: text(answer.login_shell),
    cliVersion: text(answer.cli_version),
  };
}

export async function probeConversation(
  client: Pick<CarrierClient, "request">,
  query: { conversationId: string | null; cwd: string },
  options?: HostControlRequestOptions,
): Promise<ConversationProbe> {
  const conversationId = canonicalConversationId(query.conversationId);
  return parseProbe(
    await client.request(
      "conv.probe",
      {
        agent: "claude-code",
        ...(conversationId ? { conversation_id: conversationId } : {}),
        cwd: query.cwd,
      },
      options,
    ),
  );
}

// ---- conv.export / conv.import.begin declarations -------------------------------

export interface ExportDeclaration {
  streamId: string;
  length: number;
  /** Null: the digest comes at the stream's end (`digest: "end"`). */
  sha256: string | null;
  window: number;
  nextSequence: number;
  entries: number | null;
  skipped: number | null;
  /** How the window went: `stopped`, `not_running`, `lingering`. */
  stopped: string | null;
}

export function parseExport(value: unknown): ExportDeclaration {
  const answer = record(value);
  const streamId = text(answer?.stream_id);
  const length = count(answer?.length);
  const window = count(answer?.window);
  const next = count(answer?.next_sequence);
  if (!answer || !streamId || length === null || !window || next === null)
    throw invalid("conv.export");
  if (answer.mode !== undefined && answer.mode !== "retire") throw invalid("conv.export");
  return {
    streamId,
    length,
    sha256: digest(answer.sha256),
    window,
    nextSequence: next,
    entries: count(answer.entries),
    skipped: count(answer.skipped),
    stopped: text(answer.stopped),
  };
}

export interface ImportDeclaration {
  streamId: string;
  window: number;
  nextSequence: number;
  received: number;
}

export function parseImport(value: unknown): ImportDeclaration {
  const answer = record(value);
  const streamId = text(answer?.stream_id);
  const window = count(answer?.window);
  const next = count(answer?.next_sequence);
  if (!answer || !streamId || !window || next === null) throw invalid("conv.import.begin");
  return { streamId, window, nextSequence: next, received: count(answer.received) ?? 0 };
}

/** What the target says it took in, on `stream.committed`. */
export interface ImportResult {
  conversationId: string | null;
  cwd: string | null;
  memory: string | null;
  path: string | null;
  setAside: number;
}

export function parseImportResult(value: unknown): ImportResult {
  const answer = record(value) ?? {};
  const setAside = Array.isArray(answer.set_aside)
    ? answer.set_aside.length
    : (count(answer.set_aside) ?? 0);
  return {
    conversationId: canonicalConversationId(answer.conversation_id),
    cwd: text(answer.cwd),
    memory: text(answer.memory),
    path: text(answer.path),
    setAside,
  };
}

// ---- status, cancel, retire, transfers ----------------------------------------

export type TransferState = "absent" | "receiving" | "committed" | "cancelled";

export interface TransferStatus {
  state: TransferState;
  received: number;
  nextSequence: number;
}

const TRANSFER_STATES: ReadonlySet<string> = new Set([
  "absent",
  "receiving",
  "committed",
  "cancelled",
]);

export function parseStatus(value: unknown): TransferStatus {
  const answer = record(value);
  const state = text(answer?.state);
  if (!answer || !state || !TRANSFER_STATES.has(state)) throw invalid("a transfer's status");
  return {
    state: state as TransferState,
    received: count(answer.received) ?? 0,
    nextSequence: count(answer.next_sequence) ?? 0,
  };
}

export async function importStatus(
  client: Pick<CarrierClient, "request">,
  transferId: string,
  options?: HostControlRequestOptions,
): Promise<TransferStatus> {
  return parseStatus(
    await client.request("conv.import.status", { transfer_id: transferId }, options),
  );
}

/** `cancelled` from then on; a committed transfer refuses with `transfer_committed`. */
export async function cancelImport(
  client: Pick<CarrierClient, "request">,
  transferId: string,
  options?: HostControlRequestOptions,
): Promise<TransferStatus> {
  return parseStatus(
    await client.request("conv.import.cancel", { transfer_id: transferId }, options),
  );
}

export async function commitRetire(
  client: Pick<CarrierClient, "request">,
  transfer: { transferId: string; length: number; sha256: string },
  options?: HostControlRequestOptions,
): Promise<{ keptUntil: number | null }> {
  const answer = record(
    await client.request(
      "conv.retire.commit",
      { transfer_id: transfer.transferId, length: transfer.length, sha256: transfer.sha256 },
      options,
    ),
  );
  if (!answer || answer.state !== "retired") throw invalid("conv.retire.commit");
  return { keptUntil: count(answer.kept_until) };
}

export async function abortRetire(
  client: Pick<CarrierClient, "request">,
  transferId: string,
  options?: HostControlRequestOptions,
): Promise<{ restored: number }> {
  const answer = record(
    await client.request("conv.retire.abort", { transfer_id: transferId }, options),
  );
  if (!answer || answer.state !== "aborted") throw invalid("conv.retire.abort");
  return { restored: count(answer.restored) ?? 0 };
}

export type OutgoingState = "moving" | "held" | "stranded";

export interface OutgoingTransfer {
  transferId: string;
  conversationId: string | null;
  sessionId: string | null;
  toHostId: string | null;
  state: string;
  length: number | null;
  sha256: string | null;
  createdAt: number | null;
}

export interface IncomingTransfer {
  transferId: string;
  conversationId: string | null;
  fromHostId: string | null;
  state: string;
  received: number;
  nextSequence: number;
  length: number | null;
}

export interface ConversationTransfers {
  outgoing: OutgoingTransfer[];
  incoming: IncomingTransfer[];
  truncated: boolean;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

export function parseTransfers(value: unknown): ConversationTransfers {
  const answer = record(value);
  if (!answer || !Array.isArray(answer.outgoing) || !Array.isArray(answer.incoming))
    throw invalid("conv.transfers");
  return {
    outgoing: answer.outgoing.flatMap((item): OutgoingTransfer[] => {
      const entry = record(item);
      const transferId = uuid(entry?.transfer_id);
      if (!entry || !transferId) return [];
      return [
        {
          transferId,
          conversationId: canonicalConversationId(entry.conversation_id),
          sessionId: uuid(entry.session_id),
          toHostId: uuid(entry.to_host_id),
          state: text(entry.state) ?? "moving",
          length: count(entry.length),
          sha256: digest(entry.sha256),
          createdAt: count(entry.created_at),
        },
      ];
    }),
    incoming: answer.incoming.flatMap((item): IncomingTransfer[] => {
      const entry = record(item);
      const transferId = uuid(entry?.transfer_id);
      if (!entry || !transferId) return [];
      return [
        {
          transferId,
          conversationId: canonicalConversationId(entry.conversation_id),
          fromHostId: uuid(entry.from_host_id),
          state: text(entry.state) ?? "receiving",
          received: count(entry.received) ?? 0,
          nextSequence: count(entry.next_sequence) ?? 0,
          length: count(entry.length),
        },
      ];
    }),
    truncated: answer.truncated === true,
  };
}

export async function listTransfers(
  client: Pick<CarrierClient, "request">,
  options?: HostControlRequestOptions,
): Promise<ConversationTransfers> {
  return parseTransfers(await client.request("conv.transfers", {}, options));
}

/**
 * Whether the source runs the window now, by `conv.inspect`: true while its
 * worker answers for it, false when the daemon runs no such window
 * (`session_not_found` — stopped before a move, or by a retire), null when
 * the host could not say. A retire stops the window before it writes its
 * record, so a window that stops while it is watched is a retire under way.
 */
export async function windowRuns(
  client: Pick<CarrierClient, "request">,
  sessionId: string,
  options?: HostControlRequestOptions,
): Promise<boolean | null> {
  try {
    const answer = record(await client.request("conv.inspect", { session_id: sessionId }, options));
    return answer ? true : null;
  } catch (error) {
    return errorCode(error) === "session_not_found" ? false : null;
  }
}
