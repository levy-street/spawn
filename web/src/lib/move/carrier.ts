/**
 * The pump at the heart of a move: one host's `conv.export` read piped into
 * another's `conv.import.begin` write, through this device and nowhere else
 * (proto/README.md, "Stream v2" and "The conversation carrier").
 *
 * - Sequence numbers count from the transfer's first byte, so a resumed pump
 *   continues its numbering on both sides.
 * - The device never sends the target past the window the target granted,
 *   and acknowledges the source cumulatively as it forwards: never holding
 *   back more than half the source's window, and the last chunk at once.
 * - Its own writes are paced with one gate per connection (`BulkGate`): the
 *   sum of `bufferedAmount` over the device's bulk channels to a host stays
 *   at or under 64 KiB, as spike S4 measured, so terminal echo on the same
 *   association never waits behind the carry.
 * - The source's end digest goes into the target's `stream.end`: the target
 *   commits only on a match, so the check is end to end while neither host
 *   learns of the other.
 *
 * Neither host's bytes are parsed here; the device only pipes them.
 */

import {
  type CarrierClient,
  type ExportDeclaration,
  type ImportDeclaration,
  type ImportResult,
  parseExport,
  parseImport,
  parseImportResult,
} from "./conv";

/** The bulk watermark per connection, as spike S4 chose it (64 KiB). */
export const BULK_WATERMARK_BYTES = 64 * 1024;
/** The window this device asks for; the daemon grants at most its own maximum. */
export const STREAM_WINDOW = 16;
/** A carry that hears nothing from either host for this long is lost. */
export const CARRY_SILENCE_MS = 60_000;

/**
 * One gate per device connection: every bulk channel to a host registers
 * here, and a write waits while their buffered bytes together exceed the
 * watermark — per association, not per channel, since three channels each
 * held under it would still fill the association's shared queue.
 */
export class BulkGate {
  private readonly channels = new Map<
    string,
    Set<Pick<CarrierClient, "bufferedAmount" | "waitForBuffered">>
  >();

  constructor(
    private readonly watermark = BULK_WATERMARK_BYTES,
    private readonly pollMs = 10,
  ) {}

  register(
    hostId: string,
    client: Pick<CarrierClient, "bufferedAmount" | "waitForBuffered">,
  ): () => void {
    let set = this.channels.get(hostId);
    if (!set) {
      set = new Set();
      this.channels.set(hostId, set);
    }
    set.add(client);
    return () => {
      const current = this.channels.get(hostId);
      current?.delete(client);
      if (current?.size === 0) this.channels.delete(hostId);
    };
  }

  buffered(hostId: string): number {
    let total = 0;
    for (const client of this.channels.get(hostId) ?? []) total += client.bufferedAmount();
    return total;
  }

  async wait(hostId: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Move cancelled", "AbortError");
      if (this.buffered(hostId) <= this.watermark) return;
      let fullest: Pick<CarrierClient, "bufferedAmount" | "waitForBuffered"> | null = null;
      for (const client of this.channels.get(hostId) ?? [])
        if (!fullest || client.bufferedAmount() > fullest.bufferedAmount()) fullest = client;
      const tick = new Promise((resolve) => setTimeout(resolve, this.pollMs));
      // A channel over the watermark on its own wakes this when it drains
      // (its low-water event works where timers are throttled); the sum of
      // several under it is polled. Never a loop that does not yield.
      if (fullest && fullest.bufferedAmount() > this.watermark) {
        await Promise.race([tick, fullest.waitForBuffered(this.watermark, signal).catch(() => {})]);
        if (this.buffered(hostId) <= this.watermark) continue;
      }
      await tick;
    }
  }
}

/** The process-wide gate: one per connection, whatever moves share it. */
export const bulkGate = new BulkGate();

/** Which end failed, and whether it answered or simply went away. */
export class CarryError extends Error {
  constructor(
    readonly side: "source" | "target" | "device",
    readonly code: string,
    detail: string,
    /** The channel went or fell silent: the host's state is unknown, and a
     *  resume reads it back (`conv.import.status`, `conv.transfers`). */
    readonly lost: boolean,
    /** Where it failed: before the export answered, before the import
     *  answered, or while bytes moved. */
    readonly stage: "export" | "import" | "pump",
  ) {
    super(detail || code);
    this.name = "CarryError";
  }
}

export interface CarryRequest {
  source: CarrierClient;
  target: CarrierClient;
  /** Ids the gate keys on: the connection to each host. */
  sourceHostId: string;
  targetHostId: string;
  transferId: string;
  conversationId: string;
  sessionId: string;
  /** The folder the window ran in on the source: which copy travels. */
  sourceCwd: string;
  /** The folder the conversation continues in on the target. */
  targetCwd: string;
  /** Where the transfer stands: from the first byte, or from the chunk the
   *  target holds next (`conv.import.status`) on a resume. */
  fromSequence: number;
  /** The length declared the first time, for a resume to hold the target to. */
  knownLength: number | null;
  /** The export answered: the declaration, every time (a resume's too). */
  onExported?: (declaration: ExportDeclaration) => void;
  /** Bytes the target has acknowledged, of the bundle's length. */
  onProgress?: (bytes: number, total: number) => void;
  /** The source's end digest, as soon as it is known. */
  onDigest?: (sha256: string) => void;
  signal?: AbortSignal;
  gate?: BulkGate;
  silenceMs?: number;
}

export interface CarryResult {
  length: number;
  sha256: string;
  result: ImportResult;
}

function aborted(): DOMException {
  return new DOMException("Move cancelled", "AbortError");
}

function codeOf(error: unknown): string {
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "request_failed";
}

/** A failed request: an answer the host coded, or nothing heard (`lost`). */
function requestFailure(
  side: "source" | "target",
  stage: "export" | "import",
  error: unknown,
): CarryError | DOMException {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  const code = codeOf(error);
  const lost =
    code === "connection_closed" ||
    code === "request_failed" ||
    code === "outcome_unknown" ||
    code === "connect_timeout";
  const detail = error instanceof Error ? error.message : String(error);
  return new CarryError(side, lost ? "connection_lost" : code, detail, lost, stage);
}

/**
 * Carry one transfer from `fromSequence` to the target's commit. Resolves
 * with what the target committed; rejects with a `CarryError` (or an
 * `AbortError` when `signal` ends it), after cancelling whatever stream it
 * had open on either side.
 *
 * A cancel never cuts the export's or the import's opening short: the
 * source's retire runs to its end whatever the device does, and an answer
 * that arrived after its request was dropped would leave its stream unknown
 * to the channel, whose next frame for it closes the channel — and the
 * put-back's requests with it. So an opening is let answer, its stream
 * cancelled at once, and only then does the cancel take effect; the
 * declaration still reaches `onExported`, so the move knows the retire ran.
 */
export async function carryConversation(request: CarryRequest): Promise<CarryResult> {
  const gate = request.gate ?? bulkGate;
  const silenceMs = request.silenceMs ?? CARRY_SILENCE_MS;
  const { signal } = request;
  if (signal?.aborted) throw aborted();

  // Everything the frames below feed is settled through one promise.
  let settle!: { resolve: (value: CarryResult) => void; reject: (error: unknown) => void };
  const done = new Promise<CarryResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  void done.catch(() => {});
  let finished = false;
  let wake: (() => void) | null = null;
  const poke = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    settle.reject(error);
    poke();
  };

  let lastHeard = Date.now();
  const heard = () => {
    lastHeard = Date.now();
  };

  // ---- source (read) state
  let declaration: ExportDeclaration | null = null;
  let chunkBytes = request.source.getStreamLimits().chunkBytes;
  let sourceNext = request.fromSequence; // the next sequence the source may send
  let sourceAcked = request.fromSequence; // what this device last acknowledged
  let sourceDigest: string | null = null;
  let sourceEnded = false;
  const queue: Array<{ sequence: number; bytes: Uint8Array }> = [];

  // ---- target (write) state
  let imported: ImportDeclaration | null = null;
  let sentToTarget = request.fromSequence; // the next sequence to send it
  let targetAcked = request.fromSequence;
  let endSent = false;

  const total = () => declaration?.length ?? request.knownLength ?? 0;
  const chunkCount = () => Math.ceil(total() / chunkBytes);

  const readHandlers = {
    chunk: (sequence: number, bytes: Uint8Array) => {
      heard();
      if (!declaration)
        return fail(
          new CarryError(
            "source",
            "invalid_stream",
            "A chunk came before its declaration",
            false,
            "pump",
          ),
        );
      const offset = sequence * chunkBytes;
      const expected = Math.min(chunkBytes, total() - offset);
      if (
        sequence !== sourceNext ||
        sequence >= sourceAcked + declaration.window ||
        expected <= 0 ||
        bytes.byteLength !== expected
      ) {
        return fail(
          new CarryError(
            "source",
            "invalid_stream",
            "The source broke the stream's order or window",
            false,
            "pump",
          ),
        );
      }
      sourceNext += 1;
      queue.push({ sequence, bytes });
      poke();
    },
    end: (length: number, sha256: string | null) => {
      heard();
      if (
        length !== total() ||
        sourceNext !== chunkCount() ||
        !sha256 ||
        !/^[0-9a-f]{64}$/.test(sha256)
      ) {
        return fail(
          new CarryError(
            "source",
            "invalid_stream",
            "The source ended the stream short or without its digest",
            false,
            "pump",
          ),
        );
      }
      sourceEnded = true;
      sourceDigest = sha256;
      request.onDigest?.(sha256);
      poke();
    },
    error: (error: { code: string; message: string }) =>
      fail(new CarryError("source", error.code, error.message, false, "pump")),
    lost: () =>
      fail(
        new CarryError(
          "source",
          "connection_lost",
          "The connection to the source went",
          true,
          "pump",
        ),
      ),
  };

  const writeHandlers = {
    ack: (sequence: number) => {
      heard();
      if (sequence < targetAcked || sequence > sentToTarget) {
        return fail(
          new CarryError(
            "target",
            "invalid_stream",
            "The target acknowledged what it was not sent",
            false,
            "pump",
          ),
        );
      }
      targetAcked = sequence;
      request.onProgress?.(Math.min(targetAcked * chunkBytes, total()), total());
      poke();
    },
    committed: (length: number, sha256: string, result: unknown) => {
      heard();
      if (finished) return;
      if (length !== total() || (sourceDigest !== null && sha256 !== sourceDigest)) {
        return fail(
          new CarryError(
            "target",
            "invalid_stream",
            "The target committed something else",
            false,
            "pump",
          ),
        );
      }
      finished = true;
      request.onProgress?.(total(), total());
      settle.resolve({ length, sha256, result: parseImportResult(result) });
      poke();
    },
    error: (error: { code: string; message: string }) =>
      fail(new CarryError("target", error.code, error.message, false, "pump")),
    lost: () =>
      fail(
        new CarryError(
          "target",
          "connection_lost",
          "The connection to the target went",
          true,
          "pump",
        ),
      ),
  };

  /**
   * A frame sent on a channel that has gone throws: that is a lost
   * connection like any other, which the move resumes from where the target
   * stands — not a failure of the copy.
   */
  const send = (side: "source" | "target", frame: () => void): void => {
    try {
      frame();
    } catch (error) {
      throw new CarryError(
        side,
        "connection_lost",
        error instanceof Error ? error.message : `The connection to the ${side} went`,
        true,
        "pump",
      );
    }
  };

  const onAbort = () => fail(aborted());
  signal?.addEventListener("abort", onAbort, { once: true });
  const silence = setInterval(
    () => {
      if (Date.now() - lastHeard > silenceMs) {
        fail(
          new CarryError("device", "connection_lost", "Neither host was heard from", true, "pump"),
        );
      }
    },
    Math.min(1_000, silenceMs),
  );
  const ungate = gate.register(request.targetHostId, request.target);

  try {
    // 1. The source: a retire that stops the window and holds its files.
    try {
      declaration = parseExport(
        await request.source.openStreamV2(
          "conv.export",
          {
            transfer_id: request.transferId,
            agent: "claude-code",
            conversation_id: request.conversationId,
            mode: "retire",
            session_id: request.sessionId,
            to_host_id: request.targetHostId,
            cwd: request.sourceCwd,
            // As the hello allows: never more than the daemon's own maximum.
            stream: {
              window: Math.min(STREAM_WINDOW, request.source.getStreamLimits().streamWindowMax),
              digest: "end",
            },
            from_sequence: request.fromSequence,
          },
          readHandlers,
        ),
      );
    } catch (error) {
      throw requestFailure("source", "export", error);
    }
    heard();
    chunkBytes = request.source.getStreamLimits().chunkBytes;
    if (
      declaration.nextSequence !== request.fromSequence ||
      (request.knownLength !== null && declaration.length !== request.knownLength)
    ) {
      request.source.cancelStreamV2(declaration.streamId);
      throw new CarryError(
        "source",
        "resume_mismatch",
        "The source resumed somewhere else",
        false,
        "export",
      );
    }
    request.onExported?.(declaration);
    if (finished) await done;

    // 2. The target: a write into its staging, resumed where it stands.
    try {
      imported = parseImport(
        await request.target.openStreamV2(
          "conv.import.begin",
          {
            transfer_id: request.transferId,
            agent: "claude-code",
            conversation_id: request.conversationId,
            mode: "retire",
            cwd: request.targetCwd,
            length: declaration.length,
            sha256: declaration.sha256,
            stream: {
              window: Math.min(STREAM_WINDOW, request.target.getStreamLimits().streamWindowMax),
              digest: declaration.sha256 ? "start" : "end",
            },
            from_host_id: request.sourceHostId,
          },
          writeHandlers,
        ),
      );
    } catch (error) {
      request.source.cancelStreamV2(declaration.streamId);
      throw requestFailure("target", "import", error);
    }
    heard();
    if (finished) await done;
    if (imported.nextSequence !== request.fromSequence) {
      // The target holds more, or less, than the status said a moment ago.
      // Ahead: drop what it has. Behind: nothing can fill the gap here.
      if (imported.nextSequence < request.fromSequence) {
        request.source.cancelStreamV2(declaration.streamId);
        request.target.cancelStreamV2(imported.streamId);
        throw new CarryError(
          "target",
          "resume_mismatch",
          "The target holds less than it said",
          true,
          "import",
        );
      }
      sentToTarget = imported.nextSequence;
      targetAcked = imported.nextSequence;
    }
    request.onProgress?.(
      Math.min(targetAcked * chunkBytes, declaration.length),
      declaration.length,
    );

    // 3. The pump.
    const window = imported.window;
    const sourceHalf = Math.ceil(declaration.window / 2);
    while (!finished) {
      let progressed = false;
      // Forward what the target has room for, paced per connection.
      while (!finished && queue.length > 0 && sentToTarget < targetAcked + window) {
        const next = queue[0];
        if (!next) break;
        if (next.sequence < sentToTarget) {
          // Already with the target (a resume past this point): take it.
          queue.shift();
        } else {
          await gate.wait(request.targetHostId, signal);
          if (finished) break;
          const stream = imported.streamId;
          send("target", () => request.target.sendChunkV2(stream, next.sequence, next.bytes));
          queue.shift();
          sentToTarget = next.sequence + 1;
        }
        progressed = true;
        const taken = next.sequence + 1;
        if (taken - sourceAcked >= sourceHalf || taken === chunkCount()) {
          const stream = declaration.streamId;
          send("source", () =>
            request.source.sendStreamV2("stream.ack", stream, { sequence: taken }),
          );
          sourceAcked = taken;
        }
      }
      if (finished) break;
      // Everything forwarded and the source's digest in hand: ask for the commit.
      if (!endSent && sourceEnded && queue.length === 0 && sentToTarget >= chunkCount()) {
        if (sourceAcked < chunkCount()) {
          const stream = declaration.streamId;
          send("source", () =>
            request.source.sendStreamV2("stream.ack", stream, { sequence: chunkCount() }),
          );
          sourceAcked = chunkCount();
        }
        const stream = imported.streamId;
        const length = declaration.length;
        send("target", () =>
          request.target.sendStreamV2("stream.end", stream, { length, sha256: sourceDigest }),
        );
        endSent = true;
        progressed = true;
      }
      if (!progressed) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          // A paced send whose gate opened, or a window the target freed,
          // is noticed without a frame to wake on.
          setTimeout(resolve, 50);
        });
        wake = null;
      }
    }
    return await done;
  } catch (error) {
    if (!finished) {
      finished = true;
      settle.reject(error);
    }
    if (declaration && !sourceEnded) request.source.cancelStreamV2(declaration.streamId);
    if (imported) request.target.cancelStreamV2(imported.streamId);
    throw error;
  } finally {
    clearInterval(silence);
    signal?.removeEventListener("abort", onAbort);
    ungate();
  }
}
