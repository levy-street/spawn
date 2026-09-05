import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runWorker, settle, spctFrame } from "./worker-harness";

/**
 * The assembler the phone actually runs is the session worker inside the
 * bundled WebView asset, not a class in the transport module. This drives it
 * through the shared framing vector the daemon and the web client assert
 * too, so the three runtimes cannot drift apart on the chunk contract again.
 */

const VECTORS = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../../proto/session-ctl-replay-framing-v1-vectors.json"),
    "utf8",
  ),
) as {
  daemon_chunk_payload_bytes: number;
  cases: Array<{ name: string; total_bytes: number; chunks: number; last_chunk_bytes: number }>;
  rejected_headers: Array<{ name: string; total_bytes: number; chunks: number }>;
  rejected_on_first_chunk: Array<{
    name: string;
    total_bytes: number;
    chunks: number;
    first_chunk_bytes: number;
  }>;
};

interface FakeTerm {
  cols: number;
  rows: number;
  write: jest.Mock;
  reset: jest.Mock;
  scrollToBottom: jest.Mock;
  buffer: {
    active: {
      baseY: number;
      viewportY: number;
      getLine: (row: number) => { translateToString: (trim: boolean) => string } | undefined;
    };
    alternate: object;
  };
}

interface Harness {
  state: {
    term: FakeTerm;
    ctl: { readyState: string; bufferedAmount: number; send: jest.Mock };
    cols: number;
    rows: number;
    displayOwner: boolean | null;
    displayGeometry: { cols: number; rows: number } | null;
    displayViewers: number;
  };
  post: jest.Mock;
  error: jest.Mock;
  telemetry: jest.Mock;
  fitTerminal: jest.Mock;
  sessionGate: (gate: string) => void;
  bytesFromMessage: jest.Mock;
  decodeBase64: jest.Mock;
  encodeBase64: jest.Mock;
  receiveSessionCtl?: (value: unknown) => void | Promise<void>;
}

/** `occupied` names the absolute buffer rows that hold text; the screen
 *  starts at `baseY`, the reader looks from `viewportY`. */
function harness(occupied: number[] = [], baseY = 0, viewportY = baseY): Harness {
  const term: FakeTerm = {
    cols: 53,
    rows: 30,
    write: jest.fn((_data: unknown, done?: () => void) => done?.()),
    reset: jest.fn(),
    scrollToBottom: jest.fn(),
    buffer: {
      active: {
        baseY,
        viewportY,
        getLine: (row: number) =>
          occupied.includes(row) ? { translateToString: () => `row ${row}` } : undefined,
      },
      alternate: {},
    },
  };
  return {
    state: {
      term,
      ctl: { readyState: "open", bufferedAmount: 0, send: jest.fn() },
      cols: 53,
      rows: 30,
      displayOwner: null,
      displayGeometry: null,
      displayViewers: 1,
    },
    post: jest.fn(),
    error: jest.fn(),
    telemetry: jest.fn(),
    fitTerminal: jest.fn(),
    sessionGate: jest.fn(),
    bytesFromMessage: jest.fn(async (value: unknown) =>
      value instanceof Uint8Array ? value : null,
    ),
    decodeBase64: jest.fn(() => Uint8Array.of()),
    encodeBase64: jest.fn(() => ""),
  };
}

/** Open every gate the bootstrap waits on and return the history request id. */
function startBootstrap(worker: Harness): string {
  for (const gate of ["bindingAccepted", "ptyOpen", "ctlOpen", "daemonReady"]) {
    worker.sessionGate(gate);
  }
  const request = worker.state.ctl.send.mock.calls
    .map(([text]: [string]) => JSON.parse(text) as { operation: string; request_id: string })
    .find((sent) => sent.operation === "history");
  if (!request) throw new Error("The worker did not request history.");
  return request.request_id;
}

function header(requestId: string, totalBytes: number, chunks: number) {
  return JSON.stringify({
    version: 1,
    kind: "response",
    request_id: requestId,
    operation: "history",
    ok: true,
    plain: false,
    pty_offset: 0,
    total_bytes: totalBytes,
    chunks,
  });
}

describe("session worker replay framing", () => {
  test("assembles every vector case framed the daemon's way, in order", async () => {
    const payloadBytes = VECTORS.daemon_chunk_payload_bytes;
    expect(payloadBytes).toBe(16 * 1024 - 28);
    for (const c of VECTORS.cases) {
      await runWorker(harness(), async (worker) => {
        const requestId = startBootstrap(worker);
        worker.receiveSessionCtl?.(header(requestId, c.total_bytes, c.chunks));
        for (let sequence = 0; sequence < c.chunks; sequence += 1) {
          const last = sequence + 1 === c.chunks;
          const payload = new Uint8Array(last ? c.last_chunk_bytes : payloadBytes).fill(
            sequence & 0xff,
          );
          await worker.receiveSessionCtl?.(spctFrame(requestId, sequence, last, payload));
        }
        await settle();
        expect(worker.error).not.toHaveBeenCalled();
        const written = worker.state.term.write.mock.calls
          .map(([data]: [unknown]) => data)
          .find((data): data is Uint8Array => data instanceof Uint8Array);
        expect(written?.byteLength).toBe(c.total_bytes);
        for (let sequence = 0; sequence < c.chunks; sequence += 1) {
          expect(written?.[sequence * payloadBytes]).toBe(sequence & 0xff);
        }
      });
    }
  });

  test("refuses a header no accepted framing can produce, aloud", async () => {
    for (const r of VECTORS.rejected_headers) {
      await runWorker(harness(), async (worker) => {
        const requestId = startBootstrap(worker);
        worker.receiveSessionCtl?.(header(requestId, r.total_bytes, r.chunks));
        await settle();
        expect(worker.error).toHaveBeenCalledWith("replay_metadata", expect.any(String), true);
        expect(worker.state.term.write).not.toHaveBeenCalled();
      });
    }
  });

  test("refuses a first chunk that cannot carry the announced total, aloud", async () => {
    for (const r of VECTORS.rejected_on_first_chunk) {
      await runWorker(harness(), async (worker) => {
        const requestId = startBootstrap(worker);
        worker.receiveSessionCtl?.(header(requestId, r.total_bytes, r.chunks));
        await worker.receiveSessionCtl?.(
          spctFrame(requestId, 0, r.chunks === 1, new Uint8Array(r.first_chunk_bytes)),
        );
        await settle();
        expect(worker.error).toHaveBeenCalledWith("replay_frame", expect.any(String), true);
        expect(worker.state.term.write).not.toHaveBeenCalled();
      });
    }
  });
});

describe("session worker replay rendering", () => {
  test("writes history, scrolls it into scrollback, then paints the screen", async () => {
    // The seed the daemon sends: geometry, the history sentinel, committed
    // lines, geometry again, then a screen repaint at absolute positions.
    const history = "line one\r\nline two\r\nlast line printed\r\n";
    const screen = "\x1b[1;1Hprompt\x1b[3;1H$ ";
    const replay = new TextEncoder().encode(
      `\x1b[8;36;83t\x1b_sp:h1\x1b\\${history}\x1b[8;36;83t${screen}`,
    );
    await runWorker(harness([0, 1, 2]), async (worker) => {
      const requestId = startBootstrap(worker);
      worker.receiveSessionCtl?.(header(requestId, replay.byteLength, 1));
      await worker.receiveSessionCtl?.(spctFrame(requestId, 0, true, replay));
      await settle();
      expect(worker.error).not.toHaveBeenCalled();
      const writes = worker.state.term.write.mock.calls.map(([data]: [unknown]) => data);
      // Never the raw bytes: the repaint would erase "last line printed".
      expect(writes).toEqual([history, "\x1b[30;1H\n\n\n", screen]);
    });
  });

  test("writes a replay without the sentinel as it came", async () => {
    const raw = new TextEncoder().encode("plain\r\n$ ");
    await runWorker(harness(), async (worker) => {
      const requestId = startBootstrap(worker);
      worker.receiveSessionCtl?.(header(requestId, raw.byteLength, 1));
      await worker.receiveSessionCtl?.(spctFrame(requestId, 0, true, raw));
      await settle();
      const writes = worker.state.term.write.mock.calls.map(([data]: [unknown]) => data);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toBeInstanceOf(Uint8Array);
    });
  });
});

describe("session worker replay flush", () => {
  const history = "h\r\n";
  const screen = "\x1b[1;1Hs";
  const replay = new TextEncoder().encode(
    `\x1b[8;36;83t\x1b_sp:h1\x1b\\${history}\x1b[8;36;83t${screen}`,
  );
  async function flushFor(instance: Harness): Promise<unknown[]> {
    let writes: unknown[] = [];
    await runWorker(instance, async (worker) => {
      const requestId = startBootstrap(worker);
      worker.receiveSessionCtl?.(header(requestId, replay.byteLength, 1));
      await worker.receiveSessionCtl?.(spctFrame(requestId, 0, true, replay));
      await settle();
      writes = worker.state.term.write.mock.calls.map(([data]: [unknown]) => data);
    });
    return writes;
  }

  test("measures the screen rows from baseY, not from where the reader is looking", async () => {
    // A reseed while the reader is scrolled up: the viewport sits on the top of
    // the history (two non-blank rows there) while the screen rows starting at
    // baseY hold five. The flush must scroll five, or the repaint erases three.
    const writes = await flushFor(harness([0, 1, 40, 41, 42, 43, 44], 40, 0));
    expect(writes).toEqual([history, `\x1b[30;1H${"\n".repeat(5)}`, screen]);
  });

  test("scrolls nothing for a blank screen, and by the last non-blank row otherwise", async () => {
    expect(await flushFor(harness([]))).toEqual([history, "", screen]);
    // Row 7 holds text under blank rows: the flush scrolls eight, so interior
    // blanks stay where they were and only trailing padding is skipped.
    expect((await flushFor(harness([7])))[1]).toBe(`\x1b[30;1H${"\n".repeat(8)}`);
  });
});

describe("session worker reseed", () => {
  test("restores margins, origin mode and autowrap before clearing for a reseed", async () => {
    const history = "h\r\n";
    const screen = "\x1b[1;1Hs";
    const replay = new TextEncoder().encode(
      `\x1b[8;36;83t\x1b_sp:h1\x1b\\${history}\x1b[8;36;83t${screen}`,
    );
    await runWorker(harness([0]), async (worker) => {
      const first = startBootstrap(worker);
      worker.receiveSessionCtl?.(header(first, replay.byteLength, 1));
      await worker.receiveSessionCtl?.(spctFrame(first, 0, true, replay));
      await settle();
      worker.state.term.write.mockClear();
      // A reconnect: the generation resets and every gate reopens.
      (worker as unknown as { resetSessionGeneration: () => void }).resetSessionGeneration();
      worker.state.ctl.send.mockClear();
      const second = startBootstrap(worker);
      expect(second).not.toBe(first);
      worker.receiveSessionCtl?.(header(second, replay.byteLength, 1));
      await worker.receiveSessionCtl?.(spctFrame(second, 0, true, replay));
      await settle();
      const writes = worker.state.term.write.mock.calls.map(([data]: [unknown]) => data);
      // The previous screen may have left a scroll region, origin mode or
      // no-autowrap in force; the clear must undo them or the history that
      // follows scrolls inside the region and never reaches scrollback (#58).
      expect(writes).toEqual([
        "\x1b[0m\x1b(B\x1b)B\x0f\x1b[r\x1b[?6l\x1b[?7h\x1b[H\x1b[2J\x1b[3J",
        history,
        "\x1b[30;1H\n",
        screen,
      ]);
    });
  });
});
