/**
 * Test doubles for a move: two hosts that speak the conversation carrier as
 * D2 does (proto/README.md, "The conversation carrier"), and a server with
 * the move routes' answers. Used only by the tests beside them, never by the
 * app. Faults are switches on the fakes, so each row of the failure matrix is
 * one switch and one assertion.
 */

import { HostControlError, type HostStreamLimits, type StreamV2Handlers } from "@/lib/hostControl";
import { Sha256 } from "@/lib/sha256";
import type { CarrierClient } from "./conv";
import type { MoveHostsPort, MoveLauncherPort } from "./orchestrator";
import type { MoveServerPort } from "./server";

const later = (work: () => void) => setTimeout(work, 0);

function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex();
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

type Outgoing = {
  conversationId: string;
  sessionId: string;
  toHostId: string;
  state: "moving" | "held" | "stranded" | "retired" | "aborted";
  bytes: Uint8Array;
  sha256: string;
};

type Incoming = {
  conversationId: string;
  cwd: string;
  length: number;
  chunks: Uint8Array[];
  state: "receiving" | "committed" | "cancelled";
  sha256: string | null;
  stream: { channel: FakeChannel; streamId: string } | null;
};

/** One fault per switch; a number counts what passes before it fires. */
export interface HostFaults {
  /** The channel carrying an export goes after it has sent this many chunks. */
  loseAfterSentChunks?: number;
  /** The channel carrying an import goes after it has taken this many chunks. */
  loseAfterTakenChunks?: number;
  /** The import commits, but its channel goes before `stream.committed` is heard. */
  loseCommitFrame?: boolean;
  /** `stream.end` is answered with this error, once (staging kept). */
  endError?: string;
  /** These operations refuse with a code, once each. */
  refuse?: Partial<Record<string, string>>;
  /** These operations are never answered: their channel goes. */
  vanishOn?: Set<string>;
  /** An abort finds a file in the way of one it puts back. */
  abortAlreadyExists?: boolean;
  /** The source never confirms its stop (no session.exit reaches the server). */
  lingering?: boolean;
  /** `conv.import.cancel` answers this state instead of cancelling. */
  cancelAnswer?: string;
  /** The retire stops the window and holds the files, then fails to put
   *  them back: the transfer is left stranded, refused with this code. */
  strandWith?: string;
  /** Sending a chunk on the import's channel throws once, after this many. */
  throwOnSendAfter?: number;
}

export class FakeHost {
  online = true;
  chunkBytes = 8;
  windowMax = 16;
  faults: HostFaults = {};
  readonly channels: FakeChannel[] = [];
  /** Conversations in Claude's lookup path, by id. */
  readonly conversations = new Map<string, { cwd: string; bytes: Uint8Array }>();
  /** Windows this host runs: whether each is running and in which conversation. */
  readonly windows = new Map<string, { conversationId: string; running: boolean }>();
  /** Conversations a process outside the window holds. */
  readonly heldElsewhere = new Set<string>();
  /** Conversations a Claude on this host holds now (a target's refusal). */
  readonly liveHere = new Set<string>();
  folderExists = true;
  storeReady = true;
  loginShell: string | null = "/bin/zsh";
  readonly outgoing = new Map<string, Outgoing>();
  readonly incoming = new Map<string, Incoming>();
  readonly cancelled = new Set<string>();
  readonly operations: string[] = [];
  sentChunks = 0;
  takenChunks = 0;
  /** Told when the retire stops a window: the source's session.exit. */
  onWindowStopped: (sessionId: string) => void = () => {};

  constructor(readonly hostId: string) {}

  /** A ready consumer channel, as the device's provider would open one. */
  client(): FakeChannel {
    if (!this.online)
      throw new HostControlError("connect_timeout", "Host control connection timed out");
    const channel = new FakeChannel(this);
    this.channels.push(channel);
    return channel;
  }

  conversationBytes(id: string): Uint8Array | undefined {
    return this.conversations.get(id)?.bytes;
  }

  /** Go offline: every channel to it goes. */
  goOffline(): void {
    this.online = false;
    for (const channel of this.channels) channel.lose();
  }

  // ---- requests -------------------------------------------------------------------

  answer(_channel: FakeChannel, operation: string, payload: Record<string, unknown>): unknown {
    this.operations.push(operation);
    const refusal = this.faults.refuse?.[operation];
    if (refusal) {
      delete this.faults.refuse?.[operation];
      throw new HostControlError(refusal, `${operation} refused (${refusal})`);
    }
    const transferId = String(payload.transfer_id ?? "");
    switch (operation) {
      case "conv.import.status":
        return this.status(transferId);
      case "conv.import.cancel": {
        if (this.faults.cancelAnswer) {
          const state = this.faults.cancelAnswer;
          this.faults.cancelAnswer = undefined;
          return { state, received: 0, next_sequence: 0 };
        }
        const incoming = this.incoming.get(transferId);
        if (incoming?.state === "committed")
          throw new HostControlError("transfer_committed", "committed");
        if (incoming) {
          incoming.state = "cancelled";
          if (incoming.stream)
            incoming.stream.channel.endStream(incoming.stream.streamId, "cancelled");
          this.incoming.delete(transferId);
        }
        this.cancelled.add(transferId);
        return { state: "cancelled", received: 0, next_sequence: 0 };
      }
      case "conv.retire.commit": {
        const outgoing = this.outgoing.get(transferId);
        if (!outgoing) throw new HostControlError("transfer_not_found", "unknown");
        if (outgoing.state === "aborted") throw new HostControlError("transfer_aborted", "aborted");
        if (outgoing.state === "stranded")
          throw new HostControlError("transfer_incomplete", "stranded");
        if (payload.length !== outgoing.bytes.byteLength || payload.sha256 !== outgoing.sha256)
          throw new HostControlError("declaration_mismatch", "mismatch");
        outgoing.state = "retired";
        return { state: "retired", retired_at: 1, kept_until: 2 };
      }
      case "conv.retire.abort": {
        const outgoing = this.outgoing.get(transferId);
        if (!outgoing) throw new HostControlError("transfer_not_found", "unknown");
        if (outgoing.state === "retired")
          throw new HostControlError("transfer_committed", "retired");
        if (outgoing.state === "aborted") throw new HostControlError("transfer_aborted", "aborted");
        if (this.faults.abortAlreadyExists) {
          outgoing.state = "aborted";
          throw new HostControlError("already_exists", "a file is in the way");
        }
        outgoing.state = "aborted";
        this.conversations.set(outgoing.conversationId, {
          cwd: "~/code/spawn",
          bytes: outgoing.bytes,
        });
        return { state: "aborted", restored: 1 };
      }
      case "conv.inspect": {
        const window = this.windows.get(String(payload.session_id ?? ""));
        if (!window?.running) throw new HostControlError("session_not_found", "no such window");
        return {
          agent: "claude-code",
          conversation_id: window.conversationId,
          state: "idle",
          cli_version: "2.1.289",
          live_elsewhere: false,
          source: "registry",
        };
      }
      case "conv.transfers":
        return {
          outgoing: [...this.outgoing.entries()]
            .filter(([, entry]) => entry.state !== "retired" && entry.state !== "aborted")
            .map(([id, entry]) => ({
              transfer_id: id,
              conversation_id: entry.conversationId,
              session_id: entry.sessionId,
              to_host_id: entry.toHostId,
              state: entry.state,
              created_at: 1,
              length: entry.bytes.byteLength,
              sha256: entry.sha256,
            })),
          incoming: [...this.incoming.entries()]
            .filter(([, entry]) => entry.state === "receiving")
            .map(([id, entry]) => ({
              transfer_id: id,
              conversation_id: entry.conversationId,
              from_host_id: null,
              state: entry.state,
              received: entry.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
              next_sequence: entry.chunks.length,
              length: entry.length,
              created_at: 1,
            })),
          truncated: false,
        };
      case "conv.probe": {
        const id = String(payload.conversation_id ?? "");
        return {
          agent: "claude-code",
          home: "/home/me",
          cwd: String(payload.cwd ?? ""),
          folder_exists: this.folderExists,
          project_folder: "-home-me-code-spawn",
          store: "~/.claude",
          store_ready: this.storeReady,
          store_problem: this.storeReady ? null : "store_missing",
          destination: "~/.claude/projects/-home-me-code-spawn",
          memory: "~/.claude/projects/-home-me-code-spawn/memory",
          repository_root: null,
          duplicates: this.conversations.has(id)
            ? [{ folder: "-home-me-code-spawn", path: "x", size: 3, live: this.liveHere.has(id) }]
            : [],
          duplicates_truncated: false,
          live: id ? this.liveHere.has(id) : null,
          login_shell: this.loginShell,
          cli_version: "2.1.289",
        };
      }
      default:
        throw new HostControlError("unsupported_operation", operation);
    }
  }

  status(transferId: string) {
    if (this.cancelled.has(transferId))
      return { state: "cancelled", received: 0, next_sequence: 0 };
    const incoming = this.incoming.get(transferId);
    if (!incoming) return { state: "absent", received: 0, next_sequence: 0 };
    if (incoming.state === "committed")
      return {
        state: "committed",
        received: incoming.length,
        next_sequence: Math.ceil(incoming.length / this.chunkBytes),
      };
    return {
      state: "receiving",
      received: incoming.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      next_sequence: incoming.chunks.length,
    };
  }

  // ---- export (the source) --------------------------------------------------------

  openExport(channel: FakeChannel, payload: Record<string, unknown>, streamId: string) {
    const transferId = String(payload.transfer_id);
    const from = Number(payload.from_sequence ?? 0);
    let outgoing = this.outgoing.get(transferId);
    let stopped = "not_running";
    if (outgoing) {
      if (outgoing.state === "aborted") throw new HostControlError("transfer_aborted", "aborted");
      if (outgoing.state === "stranded")
        throw new HostControlError("transfer_incomplete", "stranded");
      if (this.heldElsewhere.has(outgoing.conversationId))
        throw new HostControlError("conversation_live_elsewhere", "held by a background session");
    } else {
      const conversationId = String(payload.conversation_id);
      const sessionId = String(payload.session_id);
      if (this.heldElsewhere.has(conversationId))
        throw new HostControlError(
          "conversation_live_elsewhere",
          "a background session holds it (holder unconfirmed: remove a stale record)",
        );
      for (const entry of this.outgoing.values())
        if (
          entry.conversationId === conversationId &&
          (entry.state === "moving" || entry.state === "held" || entry.state === "stranded")
        )
          throw new HostControlError("transfer_unresolved", "another move holds it");
      const window = this.windows.get(sessionId);
      if (window && window.conversationId !== conversationId)
        throw new HostControlError("conversation_changed", "the window is in another conversation");
      const conversation = this.conversations.get(conversationId);
      if (!conversation)
        throw new HostControlError("conversation_not_found", "no such conversation");
      if (window?.running) {
        window.running = false;
        stopped = this.faults.lingering ? "lingering" : "stopped";
        if (!this.faults.lingering) this.onWindowStopped(sessionId);
      }
      this.conversations.delete(conversationId);
      outgoing = {
        conversationId,
        sessionId,
        toHostId: String(payload.to_host_id),
        state: "held",
        bytes: conversation.bytes,
        sha256: sha256Hex(conversation.bytes),
      };
      this.outgoing.set(transferId, outgoing);
      if (this.faults.strandWith) {
        const code = this.faults.strandWith;
        this.faults.strandWith = undefined;
        outgoing.state = "stranded";
        throw new HostControlError(code, "the move failed and could not be undone");
      }
    }
    const length = outgoing.bytes.byteLength;
    const count = Math.ceil(length / this.chunkBytes);
    if (from > count) throw new HostControlError("resume_mismatch", "past the end");
    const window = Math.min(
      Number((payload.stream as { window?: number })?.window ?? 16),
      this.windowMax,
    );
    const bytes = outgoing.bytes;
    const sha256 = outgoing.sha256;
    const read = {
      next: from,
      acked: from,
      window,
      count,
      ended: false,
      pump: () => {
        while (!read.ended && read.next < read.count && read.next < read.acked + read.window) {
          const sequence = read.next;
          read.next += 1;
          const chunk = bytes.subarray(
            sequence * this.chunkBytes,
            (sequence + 1) * this.chunkBytes,
          );
          this.sentChunks += 1;
          later(() => channel.deliver(streamId, (handlers) => handlers.chunk?.(sequence, chunk)));
          if (
            this.faults.loseAfterSentChunks !== undefined &&
            this.sentChunks >= this.faults.loseAfterSentChunks
          ) {
            this.faults.loseAfterSentChunks = undefined;
            later(() => channel.lose());
            read.ended = true;
            return;
          }
        }
        if (!read.ended && read.next >= read.count) {
          read.ended = true;
          later(() =>
            channel.deliver(streamId, (handlers) => handlers.end?.(length, sha256), true),
          );
        }
      },
    };
    channel.reads.set(streamId, read);
    return {
      answer: {
        stream_id: streamId,
        transfer_id: transferId,
        mode: "retire",
        length,
        sha256: null,
        window,
        next_sequence: from,
        entries: 1,
        skipped: 0,
        stopped,
      },
      start: () => read.pump(),
    };
  }

  // ---- import (the target) --------------------------------------------------------

  openImport(channel: FakeChannel, payload: Record<string, unknown>, streamId: string) {
    const transferId = String(payload.transfer_id);
    const conversationId = String(payload.conversation_id);
    if (payload.mode !== "retire") throw new HostControlError("invalid_request", "mode");
    if (this.cancelled.has(transferId))
      throw new HostControlError("transfer_cancelled", "cancelled");
    const existing = this.incoming.get(transferId);
    if (existing?.state === "committed")
      throw new HostControlError("transfer_committed", "committed");
    if (!this.folderExists) throw new HostControlError("folder_missing", "no such folder");
    if (!this.storeReady) throw new HostControlError("store_missing", "no store");
    if (this.liveHere.has(conversationId))
      throw new HostControlError("conversation_live_here", "a Claude here holds it");
    const length = Number(payload.length);
    let incoming = existing;
    if (incoming) {
      if (incoming.length !== length) throw new HostControlError("resume_mismatch", "length");
      if (incoming.stream)
        incoming.stream.channel.endStream(incoming.stream.streamId, "superseded");
    } else {
      incoming = {
        conversationId,
        cwd: String(payload.cwd),
        length,
        chunks: [],
        state: "receiving",
        sha256: null,
        stream: null,
      };
      this.incoming.set(transferId, incoming);
    }
    incoming.stream = { channel, streamId };
    channel.writes.set(streamId, transferId);
    return {
      answer: {
        stream_id: streamId,
        window: Math.min(
          Number((payload.stream as { window?: number })?.window ?? 16),
          this.windowMax,
        ),
        next_sequence: incoming.chunks.length,
        received: incoming.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      },
    };
  }

  takeChunk(channel: FakeChannel, streamId: string, sequence: number, bytes: Uint8Array): void {
    const transferId = channel.writes.get(streamId);
    const incoming = transferId ? this.incoming.get(transferId) : undefined;
    if (!incoming || incoming.stream?.streamId !== streamId) return;
    if (sequence !== incoming.chunks.length)
      throw new Error(`target got chunk ${sequence} out of order`);
    incoming.chunks.push(bytes);
    this.takenChunks += 1;
    const acked = incoming.chunks.length;
    later(() => channel.deliver(streamId, (handlers) => handlers.ack?.(acked)));
    if (
      this.faults.loseAfterTakenChunks !== undefined &&
      this.takenChunks >= this.faults.loseAfterTakenChunks
    ) {
      this.faults.loseAfterTakenChunks = undefined;
      later(() => channel.lose());
    }
  }

  takeEnd(channel: FakeChannel, streamId: string, length: number, sha256: string): void {
    const transferId = channel.writes.get(streamId);
    const incoming = transferId ? this.incoming.get(transferId) : undefined;
    if (!transferId || !incoming || incoming.stream?.streamId !== streamId) return;
    if (this.faults.endError) {
      const code = this.faults.endError;
      this.faults.endError = undefined;
      incoming.stream = null;
      // Bytes that fail their digest are discarded and the transfer forgotten.
      if (code === "integrity_mismatch") this.incoming.delete(transferId);
      later(() =>
        channel.deliver(
          streamId,
          (handlers) => handlers.error?.(new HostControlError(code, code)),
          true,
        ),
      );
      return;
    }
    if (this.liveHere.has(incoming.conversationId)) {
      incoming.stream = null;
      later(() =>
        channel.deliver(
          streamId,
          (handlers) => handlers.error?.(new HostControlError("conversation_live_here", "held")),
          true,
        ),
      );
      return;
    }
    const bytes = concat(incoming.chunks);
    if (bytes.byteLength !== length || length !== incoming.length || sha256Hex(bytes) !== sha256) {
      this.incoming.delete(transferId);
      later(() =>
        channel.deliver(
          streamId,
          (handlers) => handlers.error?.(new HostControlError("integrity_mismatch", "digest")),
          true,
        ),
      );
      return;
    }
    incoming.state = "committed";
    incoming.sha256 = sha256;
    incoming.stream = null;
    this.conversations.set(incoming.conversationId, { cwd: incoming.cwd, bytes });
    const result = {
      transfer_id: transferId,
      conversation_id: incoming.conversationId,
      cwd: incoming.cwd,
      project_folder: "-home-me-work-spawn",
      path: "~/.claude/projects/-home-me-work-spawn/x.jsonl",
      memory: "~/.claude/projects/-home-me-work-spawn/memory",
      set_aside: 0,
    };
    if (this.faults.loseCommitFrame) {
      this.faults.loseCommitFrame = false;
      later(() => channel.lose());
      return;
    }
    later(() =>
      channel.deliver(streamId, (handlers) => handlers.committed?.(length, sha256, result), true),
    );
  }
}

/** One consumer channel to a fake host: a `CarrierClient`. */
export class FakeChannel implements CarrierClient {
  lost = false;
  readonly streams = new Map<string, StreamV2Handlers>();
  /** Streams whose late frames are taken quietly: cancelled, or ended. */
  readonly quiet = new Set<string>();
  /** Chunks sent on this channel, for `throwOnSendAfter`. */
  sentOnChannel = 0;
  readonly reads = new Map<string, { acked: number; pump: () => void; ended: boolean }>();
  readonly writes = new Map<string, string>();
  readonly sent: Array<{ type: string; streamId: string; values: Record<string, unknown> }> = [];
  private nextStream = 0;

  constructor(readonly host: FakeHost) {}

  lose(): void {
    if (this.lost) return;
    this.lost = true;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const handlers of streams)
      handlers.lost?.(new HostControlError("connection_closed", "gone"));
    for (const [streamId, transferId] of this.writes) {
      const incoming = this.host.incoming.get(transferId);
      if (incoming?.stream?.streamId === streamId) incoming.stream = null;
    }
  }

  /** As `hostControl` takes a frame: one for a stream it never registered
   *  — an opening whose answer it dropped — closes the channel. */
  deliver(streamId: string, frame: (handlers: StreamV2Handlers) => void, final = false): void {
    if (this.lost) return;
    const handlers = this.streams.get(streamId);
    if (!handlers) {
      if (!this.quiet.has(streamId)) this.lose();
      return;
    }
    if (final) {
      this.streams.delete(streamId);
      this.quiet.add(streamId);
    }
    frame(handlers);
  }

  endStream(streamId: string, code: string): void {
    later(() =>
      this.deliver(
        streamId,
        (handlers) => handlers.error?.(new HostControlError(code, code)),
        true,
      ),
    );
  }

  private check(operation: string): void {
    if (this.lost || !this.host.online)
      throw new HostControlError("connection_closed", "Host control channel is not open");
    if (this.host.faults.vanishOn?.has(operation)) {
      this.host.faults.vanishOn.delete(operation);
      later(() => this.lose());
      throw new HostControlError("connection_closed", "Host control session ended");
    }
  }

  async request<T>(operation: string, payload: unknown = {}): Promise<T> {
    await new Promise((resolve) => later(() => resolve(null)));
    this.check(operation);
    return this.host.answer(this, operation, payload as Record<string, unknown>) as T;
  }

  /** As `hostControl` opens one: a request aborted before its answer
   *  rejects, and its stream is never registered — the host opened it all
   *  the same, and its frames then find no stream. */
  async openStreamV2<T extends { stream_id: string }>(
    operation: string,
    payload: Record<string, unknown>,
    handlers: StreamV2Handlers,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    await new Promise((resolve) => later(() => resolve(null)));
    this.check(operation);
    this.host.operations.push(operation);
    const refusal = this.host.faults.refuse?.[operation];
    if (refusal) {
      delete this.host.faults.refuse?.[operation];
      throw new HostControlError(refusal, `${operation} refused (${refusal})`);
    }
    const streamId = `${this.host.hostId}-s${this.nextStream++}`;
    const dropped = () => options?.signal?.aborted === true;
    if (operation === "conv.export") {
      const opened = this.host.openExport(this, payload, streamId);
      later(opened.start);
      if (dropped()) throw new DOMException("Move cancelled", "AbortError");
      this.streams.set(streamId, handlers);
      return opened.answer as unknown as T;
    }
    if (operation === "conv.import.begin") {
      const opened = this.host.openImport(this, payload, streamId);
      if (dropped()) throw new DOMException("Move cancelled", "AbortError");
      this.streams.set(streamId, handlers);
      return opened.answer as unknown as T;
    }
    throw new HostControlError("unsupported_operation", operation);
  }

  sendStreamV2(
    type: "stream.ack" | "stream.end",
    streamId: string,
    values: Record<string, unknown>,
  ): void {
    if (this.lost)
      throw new HostControlError("connection_closed", "Host control channel is not open");
    this.sent.push({ type, streamId, values });
    if (type === "stream.ack") {
      const read = this.reads.get(streamId);
      if (!read) return;
      read.acked = Number(values.sequence);
      later(() => read.pump());
      return;
    }
    later(() => this.host.takeEnd(this, streamId, Number(values.length), String(values.sha256)));
  }

  sendChunkV2(streamId: string, sequence: number, chunk: Uint8Array): void {
    if (this.lost)
      throw new HostControlError("connection_closed", "Host control channel is not open");
    this.sentOnChannel += 1;
    const after = this.host.faults.throwOnSendAfter;
    if (after !== undefined && this.sentOnChannel > after) {
      this.host.faults.throwOnSendAfter = undefined;
      later(() => this.lose());
      throw new HostControlError("connection_closed", "Host control channel is not open");
    }
    this.sent.push({ type: "stream.chunk", streamId, values: { sequence } });
    const bytes = chunk.slice();
    later(() => this.host.takeChunk(this, streamId, sequence, bytes));
  }

  cancelStreamV2(streamId: string): void {
    this.streams.delete(streamId);
    this.quiet.add(streamId);
    const read = this.reads.get(streamId);
    if (read) read.ended = true;
    const transferId = this.writes.get(streamId);
    const incoming = transferId ? this.host.incoming.get(transferId) : undefined;
    if (incoming?.stream?.streamId === streamId) incoming.stream = null;
  }

  getStreamLimits(): HostStreamLimits {
    return { chunkBytes: this.host.chunkBytes, streamWindowMax: this.host.windowMax };
  }

  bufferedAmount(): number {
    return 0;
  }

  async waitForBuffered(): Promise<void> {}

  hasCapability(name: string): boolean {
    return name === "conv.v1" || name === "conv.v2";
  }
}

/** A server with the move routes, keeping one row per window. */
export class FakeServer implements MoveServerPort {
  readonly rows = new Map<
    string,
    {
      host_id: string;
      status: string;
      exited: boolean;
      cwd: string;
      agent_session_id: string | null;
    }
  >();
  readonly online = new Set<string>();
  readonly calls: string[] = [];
  /** The next call of a route answers this way instead. */
  readonly failNext: Partial<
    Record<
      "begin" | "commit" | "abort" | "get" | "fresh",
      Array<{ status: number; detail?: string }>
    >
  > = {};
  /** Runs before a carried commit is decided: another device acting meanwhile. */
  beforeCommit: () => Promise<void> | void = () => {};

  private refusal(route: "begin" | "commit" | "abort" | "get" | "fresh"): void {
    const next = this.failNext[route]?.shift();
    if (!next) return;
    throw Object.assign(new Error(next.detail ?? `http_${next.status}`), {
      status: next.status,
      detail: next.detail,
    });
  }

  private conflict(detail: string, status = 409): never {
    throw Object.assign(new Error(detail), { status, detail });
  }

  /** The source's session.exit for a window the retire stopped. */
  windowExited(sessionId: string): void {
    const row = this.rows.get(sessionId);
    if (row) row.exited = true;
  }

  async begin(sessionId: string, expectedHostId: string) {
    this.calls.push("begin");
    await Promise.resolve();
    this.refusal("begin");
    const row = this.rows.get(sessionId);
    if (!row) return this.conflict("not found", 404);
    if (row.status === "moving") return this.conflict("move_in_progress");
    if (row.host_id !== expectedHostId) return this.conflict("move_conflict");
    if (!this.online.has(row.host_id)) return this.conflict("source_offline");
    row.status = "moving";
    return { status: "moving" };
  }

  async commit(
    sessionId: string,
    body: { host_id: string; cwd: string; expected_host_id: string; agent_session_id: string },
  ) {
    this.calls.push("commit");
    await Promise.resolve();
    await this.beforeCommit();
    this.refusal("commit");
    const row = this.rows.get(sessionId);
    if (!row) return this.conflict("not found", 404);
    if (row.host_id !== body.expected_host_id || row.status !== "moving")
      return this.conflict("move_conflict");
    if (!this.online.has(body.host_id)) return this.conflict("target_offline");
    row.host_id = body.host_id;
    row.cwd = body.cwd;
    row.status = "starting";
    row.exited = false;
    row.agent_session_id = body.agent_session_id;
    return { status: "starting" };
  }

  async abort(sessionId: string, expectedHostId: string) {
    this.calls.push("abort");
    await Promise.resolve();
    this.refusal("abort");
    const row = this.rows.get(sessionId);
    if (!row) return this.conflict("not found", 404);
    if (row.host_id !== expectedHostId || row.status !== "moving")
      return this.conflict("move_conflict");
    row.status = row.exited ? "killed" : "running";
    return { status: row.status };
  }

  async get(sessionId: string) {
    this.calls.push("get");
    await Promise.resolve();
    this.refusal("get");
    const row = this.rows.get(sessionId);
    if (!row) return this.conflict("not found", 404);
    return { host_id: row.host_id, status: row.status };
  }

  /** A fresh `/move`: refused while the window moves, never `carried`. */
  async fresh(
    sessionId: string,
    body: { host_id: string; cwd: string; expected_host_id: string; agent_session_id: string },
  ) {
    this.calls.push("fresh");
    await Promise.resolve();
    this.refusal("fresh");
    const row = this.rows.get(sessionId);
    if (!row) return this.conflict("not found", 404);
    if (row.host_id !== body.expected_host_id) return this.conflict("move_conflict");
    if (row.status === "moving") return this.conflict("move_in_progress");
    if (!this.online.has(body.host_id)) return this.conflict("target_offline");
    row.host_id = body.host_id;
    row.cwd = body.cwd;
    row.status = "starting";
    row.exited = false;
    row.agent_session_id = body.agent_session_id;
    return { status: "starting" };
  }
}

/** Hosts as the provider gives them: a fresh channel after a reset or a loss. */
export class FakeHosts implements MoveHostsPort {
  private current: { source: FakeChannel | null; target: FakeChannel | null } = {
    source: null,
    target: null,
  };
  opened = { source: 0, target: 0 };

  constructor(
    readonly sourceHost: FakeHost,
    readonly targetHost: FakeHost,
  ) {}

  private async open(side: "source" | "target"): Promise<FakeChannel> {
    await Promise.resolve();
    const existing = this.current[side];
    if (existing && !existing.lost) return existing;
    const host = side === "source" ? this.sourceHost : this.targetHost;
    const channel = host.client();
    this.current[side] = channel;
    this.opened[side] += 1;
    return channel;
  }

  source(): Promise<CarrierClient> {
    return this.open("source");
  }

  target(): Promise<CarrierClient> {
    return this.open("target");
  }

  reset(side: "source" | "target"): void {
    this.current[side] = null;
  }
}

/** Records what a move asks to have typed, or restarted. */
export class FakeLauncher implements MoveLauncherPort {
  readonly events: string[] = [];
  prepared: Parameters<MoveLauncherPort["prepare"]>[0] | undefined;
  queued = false;

  async prepare(plan: Parameters<MoveLauncherPort["prepare"]>[0]): Promise<void> {
    this.events.push("prepare");
    this.prepared = plan;
    this.queued = true;
  }

  abandon(): void {
    this.events.push("abandon");
    this.queued = false;
  }

  /** The line a put-back asked to have typed on the source. */
  restartLine: string | null | undefined;

  async restartOnSource(line: string | null): Promise<void> {
    this.events.push("restart");
    this.restartLine = line;
  }

  refetch(): void {
    this.events.push("refetch");
  }
}
