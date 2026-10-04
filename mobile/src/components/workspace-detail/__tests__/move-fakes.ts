import { sha256 } from "@noble/hashes/sha2.js";
import type { MoveArrival } from "@/components/launcher/pending-agent-input";
import type {
  MoveChannel,
  MoveChannelLease,
  MoveDeps,
  MoveHost,
} from "@/components/workspace-detail/move-conversation";
import { ApiError } from "@/data/api/client";
import type { SessionMove } from "@/data/api/schemas/sessions";
import type { Session } from "@/data/types/domain";
import type {
  ConversationCommitted,
  ConversationExportDeclaration,
  ConversationInspection,
  ConversationProbe,
  ConversationTransferStatus,
  ConversationTransfers,
  OutgoingConversationTransfer,
  RetireAnswer,
} from "@/terminal/transport/conversation-codec";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-error";
import type {
  StreamV2Committed,
  StreamV2Reader,
  StreamV2ReadItem,
  StreamV2Writer,
} from "@/terminal/transport/stream-v2";
import type {
  AgentTranscriptReport,
  ConnectionInfo,
  ConversationExportRequest,
  ConversationImportRequest,
  HostReadHead,
  TransportState,
} from "@/terminal/transport/types";
import { makeAgent, makeSession } from "./fixtures";

/**
 * A daemon pair and a server, in memory, behaving as the carrier contract
 * and the move routes say — with knobs for every way a move can go wrong.
 */

export const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
export const TARGET_ID = "22222222-2222-4222-8222-222222222222";
export const SESSION_ID = "33333333-3333-4333-8333-333333333333";
export const CONVERSATION_ID = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
export const TRANSFER_ID = "9b2f5c1e-7a40-4d3b-8e61-0c4f2a7d9e15";
const CHUNK = 8192;

export const SOURCE: MoveHost = { id: SOURCE_ID, name: "dream", os: "linux", publicKey: "a" };
export const TARGET: MoveHost = { id: TARGET_ID, name: "mac", os: "darwin", publicKey: "b" };

export function hex(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failure(code: string, detail?: string): HostControlTransportError {
  return new HostControlTransportError(code, detail ?? code);
}

export type CallLog = string[];

export interface FakeDaemonOptions {
  id: string;
  log: CallLog;
  capabilities?: string[];
  connectionInfo?: ConnectionInfo | null;
}

interface Outgoing {
  record: OutgoingConversationTransfer;
  bytes: Uint8Array;
  stopped: ConversationExportDeclaration["stopped"];
}

interface Incoming {
  conversationId: string;
  length: number;
  received: Uint8Array[];
  state: "receiving" | "committed" | "cancelled";
}

export class FakeDaemon implements MoveChannel {
  readonly hostId: string;
  state: TransportState = "ready";
  connectionInfo: ConnectionInfo | null;
  readonly capabilities: Set<string>;
  readonly log: CallLog;
  /** The conversation the window is in, as conv.inspect names it. */
  inspection: ConversationInspection | null = null;
  inspectError: string | null = null;
  /** The source's copy of the conversation, as its bundle. */
  bundle: Uint8Array = new Uint8Array();
  windowRunning = true;
  /** Export refusals, one per call, before anything is held. */
  exportRefusals: string[] = [];
  /** Export requests that time out after the retire happened. */
  exportTimeouts = 0;
  /** A read fails (the channel goes) after this many chunks, per attempt. */
  readFailsAfter: number[] = [];
  /** The target's write fails after this many chunks, per attempt. */
  writeFailsAfter: number[] = [];
  /** Codes the target's end answers with, one per commit attempt. */
  endRefusals: string[] = [];
  importRefusals: string[] = [];
  /** The target's conv.probe answer. */
  probe: ConversationProbe = {
    home: "/Users/me",
    cwd: "/Users/me/code/spawn",
    folderExists: true,
    store: "~/.claude",
    storeReady: true,
    storeProblem: null,
    memory: "~/.claude/projects/-Users-me-code-spawn/memory",
    repositoryRoot: "/Users/me/code/spawn",
    duplicates: [],
    live: false,
    loginShell: "zsh",
    cliVersion: "2.1.289",
  };
  files = new Map<string, string>();
  transcripts: AgentTranscriptReport | null = null;
  readonly outgoing = new Map<string, Outgoing>();
  readonly incoming = new Map<string, Incoming>();
  readonly tombstones = new Map<string, "committed" | "cancelled">();
  retireAbortError: string | null = null;
  silent = false;
  exportCalls: number[] = [];
  /** The retire stopped the window: the source reports its exit. */
  onStopped: (() => void) | null = null;
  /** Awaited between the retire's stop and its record, as the daemon's
   *  fence does both: the moment a resolver can find no record. */
  beforeRecord: (() => Promise<void>) | null = null;
  /** What `conv.import.cancel` answers, when not the daemon's "cancelled". */
  cancelAnswer: ConversationTransferStatus["state"] | null = null;

  constructor(options: FakeDaemonOptions) {
    this.hostId = options.id;
    this.log = options.log;
    this.capabilities = new Set(options.capabilities ?? ["conv.v1", "conv.v2", "fs.read"]);
    this.connectionInfo = options.connectionInfo ?? { kind: "direct", rttMs: 5 };
  }

  #say(operation: string): void {
    this.log.push(`${this.hostId === SOURCE_ID ? "source" : "target"}:${operation}`);
    if (this.silent) throw failure("connection_lost");
  }

  hasCapability(operation: string): boolean {
    return this.capabilities.has(operation);
  }

  async inspectConversation(): Promise<ConversationInspection> {
    this.#say("conv.inspect");
    if (this.inspectError) throw failure(this.inspectError);
    if (!this.inspection) throw failure("session_not_found");
    return this.inspection;
  }

  async conversationProbe(): Promise<ConversationProbe> {
    this.#say("conv.probe");
    return this.probe;
  }

  async readHead(path: string): Promise<HostReadHead> {
    const text = this.files.get(path);
    if (text === undefined) throw failure("not_found");
    const bytes = new TextEncoder().encode(text);
    return { bytes, total: bytes.byteLength, truncated: false };
  }

  async agentTranscripts(): Promise<AgentTranscriptReport> {
    if (!this.transcripts) throw failure("unsupported_operation");
    return this.transcripts;
  }

  async request<T>(operation: string, payload?: unknown): Promise<T> {
    this.#say(operation);
    if (operation === "fs.mkdir") {
      this.probe = { ...this.probe, folderExists: true };
      return { path: (payload as { path: string }).path } as T;
    }
    throw failure("unsupported_operation");
  }

  async conversationExport(request: ConversationExportRequest) {
    this.#say(`conv.export@${request.fromSequence}`);
    this.exportCalls.push(request.fromSequence);
    const held = this.outgoing.get(request.transferId);
    if (!held) {
      const refusal = this.exportRefusals.shift();
      if (refusal) throw failure(refusal);
      const stopped = this.windowRunning ? "stopped" : "not_running";
      if (this.windowRunning) this.onStopped?.();
      this.windowRunning = false;
      this.inspection = null;
      await this.beforeRecord?.();
      this.outgoing.set(request.transferId, {
        record: {
          transferId: request.transferId,
          conversationId: request.conversationId,
          sessionId: request.sessionId,
          toHostId: request.toHostId,
          state: "moving",
          createdAt: 1,
          length: this.bundle.byteLength,
          sha256: hex(this.bundle),
        },
        bytes: this.bundle,
        stopped,
      });
    }
    if (this.exportTimeouts > 0) {
      this.exportTimeouts -= 1;
      throw failure("request_timeout");
    }
    const outgoing = this.outgoing.get(request.transferId) as Outgoing;
    const length = outgoing.bytes.byteLength;
    const count = Math.ceil(length / CHUNK);
    if (request.fromSequence > count) throw failure("resume_mismatch");
    const failAfter = this.readFailsAfter.shift();
    let sequence = request.fromSequence;
    let sent = 0;
    const reader: StreamV2Reader = {
      streamId: `rs-${this.exportCalls.length}`,
      next: async (): Promise<StreamV2ReadItem> => {
        if (failAfter !== undefined && sent >= failAfter) throw failure("connection_lost");
        if (sequence >= count) {
          return { kind: "end", length, sha256: hex(outgoing.bytes) };
        }
        const bytes = outgoing.bytes.subarray(
          sequence * CHUNK,
          Math.min(length, (sequence + 1) * CHUNK),
        );
        const item: StreamV2ReadItem = { kind: "chunk", sequence, bytes };
        sequence += 1;
        sent += 1;
        return item;
      },
      acknowledge: () => undefined,
      cancel: () => undefined,
    };
    return {
      declaration: {
        streamId: reader.streamId,
        transferId: request.transferId,
        length,
        sha256: null,
        window: 16,
        nextSequence: request.fromSequence,
        entries: 1,
        skipped: 0,
        stopped: outgoing.stopped,
      },
      reader,
    };
  }

  async conversationImport(request: ConversationImportRequest) {
    this.#say("conv.import.begin");
    const settled = this.tombstones.get(request.transferId);
    if (settled === "committed") throw failure("transfer_committed");
    if (settled === "cancelled") throw failure("transfer_cancelled");
    const refusal = this.importRefusals.shift();
    if (refusal) throw failure(refusal);
    if (this.probe.live) throw failure("conversation_live_here");
    let incoming = this.incoming.get(request.transferId);
    if (!incoming) {
      incoming = {
        conversationId: request.conversationId,
        length: request.length,
        received: [],
        state: "receiving",
      };
      this.incoming.set(request.transferId, incoming);
    } else if (incoming.length !== request.length) {
      throw failure("resume_mismatch");
    }
    const state = incoming;
    const failAfter = this.writeFailsAfter.shift();
    let written = 0;
    const writer: StreamV2Writer = {
      streamId: `ws-${request.transferId}`,
      get acknowledged() {
        return state.received.length;
      },
      write: async (sequence: number, bytes: Uint8Array) => {
        if (failAfter !== undefined && written >= failAfter) throw failure("connection_lost");
        if (sequence !== state.received.length) throw failure("invalid_chunk");
        state.received.push(bytes.slice());
        written += 1;
      },
      end: async (length: number, digest: string): Promise<StreamV2Committed> => {
        this.log.push("target:stream.end");
        const refusal = this.endRefusals.shift();
        if (refusal === "integrity_mismatch") {
          this.incoming.delete(request.transferId);
          throw failure(refusal);
        }
        if (refusal) throw failure(refusal);
        const all = new Uint8Array(state.received.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of state.received) {
          all.set(chunk, offset);
          offset += chunk.length;
        }
        if (all.byteLength !== length || hex(all) !== digest) throw failure("integrity_mismatch");
        state.state = "committed";
        this.incoming.delete(request.transferId);
        this.tombstones.set(request.transferId, "committed");
        const result: Record<string, unknown> = {
          transfer_id: request.transferId,
          conversation_id: request.conversationId,
          cwd: this.probe.cwd,
          project_folder: "-Users-me-code-spawn",
          path: "x",
          memory: this.probe.memory,
          set_aside: 0,
        };
        return { length, sha256: digest, result };
      },
      cancel: () => undefined,
    };
    return {
      opened: {
        streamId: writer.streamId,
        window: 16,
        nextSequence: state.received.length,
        received: Math.min(state.received.length * CHUNK, request.length),
      },
      writer,
    };
  }

  async conversationImportStatus(transferId: string): Promise<ConversationTransferStatus> {
    this.#say("conv.import.status");
    const settled = this.tombstones.get(transferId);
    if (settled === "committed") return { state: "committed", received: 0, nextSequence: 0 };
    if (settled === "cancelled") return { state: "cancelled", received: 0, nextSequence: 0 };
    const incoming = this.incoming.get(transferId);
    if (!incoming) return { state: "absent", received: 0, nextSequence: 0 };
    return {
      state: "receiving",
      received: incoming.received.length * CHUNK,
      nextSequence: incoming.received.length,
    };
  }

  async conversationImportCancel(transferId: string): Promise<ConversationTransferStatus> {
    this.#say("conv.import.cancel");
    if (this.tombstones.get(transferId) === "committed") throw failure("transfer_committed");
    if (this.cancelAnswer) return { state: this.cancelAnswer, received: 0, nextSequence: 0 };
    this.incoming.delete(transferId);
    this.tombstones.set(transferId, "cancelled");
    return { state: "cancelled", received: 0, nextSequence: 0 };
  }

  async conversationRetireCommit(request: {
    transferId: string;
    length: number;
    sha256: string;
  }): Promise<RetireAnswer> {
    this.#say("conv.retire.commit");
    const held = this.outgoing.get(request.transferId);
    if (!held) throw failure("transfer_not_found");
    if (held.record.length !== request.length || held.record.sha256 !== request.sha256) {
      throw failure("declaration_mismatch");
    }
    this.outgoing.delete(request.transferId);
    return { state: "retired", keptUntil: 2 };
  }

  async conversationRetireAbort(transferId: string): Promise<RetireAnswer> {
    this.#say("conv.retire.abort");
    if (this.retireAbortError) throw failure(this.retireAbortError);
    const held = this.outgoing.get(transferId);
    if (!held) throw failure("transfer_not_found");
    this.outgoing.delete(transferId);
    return { state: "aborted", restored: 1 };
  }

  async conversationTransfers(): Promise<ConversationTransfers> {
    this.#say("conv.transfers");
    return {
      outgoing: [...this.outgoing.values()].map((item) => item.record),
      incoming: [],
      truncated: false,
    };
  }

  /** What landed on the target, joined. */
  landed(transferId = TRANSFER_ID): boolean {
    return this.tombstones.get(transferId) === "committed";
  }
}

export interface ServerKnobs {
  beginError?: { status: number; detail: string } | null;
  commitErrors?: Array<{ status: number; detail: string }>;
  abortError?: { status: number; detail: string } | null;
  /** The commit answers "killed": the workspace was archived meanwhile. */
  archived?: boolean;
}

export class FakeServer {
  session: Session;
  readonly log: CallLog;
  knobs: ServerKnobs = {};
  commits: SessionMove[] = [];

  constructor(session: Session, log: CallLog) {
    this.session = session;
    this.log = log;
  }

  #error(error: { status: number; detail: string }): ApiError {
    return new ApiError(error.status, `http_${error.status}`, error.detail, error.detail);
  }

  async begin(sessionId: string, expected: string): Promise<Session> {
    this.log.push("server:begin");
    if (this.knobs.beginError) throw this.#error(this.knobs.beginError);
    if (this.session.id !== sessionId) throw this.#error({ status: 404, detail: "not found" });
    if (this.session.status === "moving")
      throw this.#error({ status: 409, detail: "move_in_progress" });
    if (this.session.host_id !== expected)
      throw this.#error({ status: 409, detail: "move_conflict" });
    this.session = { ...this.session, status: "moving", activity_state: "moving" };
    return this.session;
  }

  /** The source reported the retire's exit. */
  exited(): void {
    this.session = { ...this.session, exited_at: "2026-10-04T00:00:01Z", exit_code: 0 };
  }

  async commit(sessionId: string, body: SessionMove): Promise<Session> {
    this.log.push("server:commit");
    this.commits.push(body);
    const error = this.knobs.commitErrors?.shift();
    if (error) throw this.#error(error);
    if (this.session.id !== sessionId) throw this.#error({ status: 404, detail: "not found" });
    if (this.session.host_id !== body.expected_host_id) {
      throw this.#error({ status: 409, detail: "move_conflict" });
    }
    if (body.carried && this.session.status !== "moving") {
      throw this.#error({ status: 409, detail: "move_conflict" });
    }
    if (!body.carried && this.session.status === "moving") {
      throw this.#error({ status: 409, detail: "move_in_progress" });
    }
    this.session = {
      ...this.session,
      host_id: body.host_id,
      cwd: body.cwd,
      status: this.knobs.archived ? "killed" : "starting",
      exited_at: null,
      agent_session_id: body.agent_session_id ?? null,
    };
    return this.session;
  }

  async abort(sessionId: string, expected: string): Promise<Session> {
    this.log.push("server:abort");
    if (this.knobs.abortError) throw this.#error(this.knobs.abortError);
    if (this.session.id !== sessionId) throw this.#error({ status: 404, detail: "not found" });
    if (this.session.status !== "moving" || this.session.host_id !== expected) {
      throw this.#error({ status: 409, detail: "move_conflict" });
    }
    this.session = {
      ...this.session,
      status: this.session.exited_at === null ? "running" : "killed",
    };
    return this.session;
  }

  async get(): Promise<Session | null> {
    return this.session;
  }
}

/** A resume record as the device holds it: provisional until confirmed. */
export interface FakeLaunch {
  sessionId: string;
  hostId: string;
  line: string;
  arrival: MoveArrival;
  provisional: boolean;
}

export interface World {
  log: CallLog;
  source: FakeDaemon;
  target: FakeDaemon;
  server: FakeServer;
  unreachable: Set<string>;
  /** Every record queued, in order. */
  queued: FakeLaunch[];
  /** What the device holds now, by window: one record per window. */
  launches: Map<string, FakeLaunch>;
  /** What a later opening of the window on `hostId` would type, if anything. */
  typable(sessionId: string, hostId: string): string | null;
  restarts: Session[];
  deps: MoveDeps;
}

export function bundleOf(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 251);
}

export function world(options: { sessionStatus?: string } = {}): World {
  const log: CallLog = [];
  const source = new FakeDaemon({ id: SOURCE_ID, log });
  const target = new FakeDaemon({ id: TARGET_ID, log });
  source.bundle = bundleOf(3 * CHUNK + 100);
  source.probe = { ...source.probe, home: "/home/me", cwd: "/home/me/code/spawn" };
  source.inspection = {
    agent: "claude-code",
    conversation_id: CONVERSATION_ID,
    state: "running",
    cli_version: "2.1.289",
    live_elsewhere: false,
    source: "registry",
  };
  source.transcripts = {
    agent_kind: "claude-code",
    supported: true,
    transcripts: [
      {
        path: "~/.claude/projects/-home-me-code-spawn/x.jsonl",
        name: "x.jsonl",
        size: 3 * CHUNK + 100,
        modified_at: null,
        role: "conversation",
        conversation_id: CONVERSATION_ID,
      },
    ],
    searched: [],
    truncated: false,
  };
  const session = makeSession({
    id: SESSION_ID,
    host_id: SOURCE_ID,
    host_name: "dream",
    cwd: "/home/me/code/spawn",
    status: options.sessionStatus ?? "running",
    agent_id: "agent-1",
    agent_session_id: CONVERSATION_ID,
    foreground_command: "claude",
  });
  const server = new FakeServer(session, log);
  source.onStopped = () => server.exited();
  if (session.status !== "running" && session.status !== "starting") {
    source.windowRunning = false;
    server.session = { ...server.session, exited_at: "2026-10-04T00:00:00Z" };
  }
  const unreachable = new Set<string>();
  const queued: World["queued"] = [];
  const launches: World["launches"] = new Map();
  const restarts: Session[] = [];
  const lease = (daemon: FakeDaemon): MoveChannelLease => ({
    channel: daemon,
    release: () => undefined,
  });
  const deps: MoveDeps = {
    channels: {
      open: async (host) => {
        if (unreachable.has(host.id)) throw failure("host_unreachable");
        return lease(host.id === SOURCE_ID ? source : target);
      },
    },
    server,
    launches: {
      queue: async (sessionId, hostId, line, arrival) => {
        const record = { sessionId, hostId, line, arrival, provisional: true };
        queued.push(record);
        launches.set(sessionId, { ...record });
      },
      confirm: async (sessionId, hostId) => {
        const record = launches.get(sessionId);
        if (record?.provisional && record.hostId === hostId) record.provisional = false;
      },
      discard: async (sessionId, hostId) => {
        const record = launches.get(sessionId);
        if (record?.provisional && record.hostId === hostId) launches.delete(sessionId);
      },
    },
    restart: async (restarted) => {
      log.push("restart");
      restarts.push(restarted);
    },
    newTransferId: () => TRANSFER_ID,
    sleep: async () => undefined,
  };
  const typable = (sessionId: string, hostId: string) => {
    const record = launches.get(sessionId);
    return record && !record.provisional && record.hostId === hostId ? record.line : null;
  };
  return { log, source, target, server, unreachable, queued, launches, typable, restarts, deps };
}

/** The built-in definition as the server lists it: named by its slug, so
 *  anything that shows the definition's name to a person shows here. */
export const CLAUDE = makeAgent({
  id: "agent-1",
  name: "claude-code",
  kind: "claude-code",
  command: "claude",
});

export function committedOf(daemon: FakeDaemon): ConversationCommitted | null {
  return daemon.landed()
    ? {
        transferId: TRANSFER_ID,
        conversationId: CONVERSATION_ID,
        cwd: daemon.probe.cwd,
        memory: daemon.probe.memory,
        setAside: 0,
      }
    : null;
}
