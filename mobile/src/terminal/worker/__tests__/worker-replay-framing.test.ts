import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

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

function sessionWorkerSource(): string {
  const marker = "const MAX_PREBOOT_BYTES = 12 * 1024 * 1024";
  const markerIndex = TERMINAL_WORKER_HTML.indexOf(marker);
  const start = TERMINAL_WORKER_HTML.lastIndexOf("(() => {", markerIndex);
  const end = TERMINAL_WORKER_HTML.indexOf("\n})();", markerIndex) + "\n})();".length;
  if (markerIndex < 0 || start < 0 || end < start)
    throw new Error("Session worker source is missing.");
  return TERMINAL_WORKER_HTML.slice(start, end);
}

function harness(occupiedRows = 0): Harness {
  const term: FakeTerm = {
    cols: 53,
    rows: 30,
    write: jest.fn((_data: unknown, done?: () => void) => done?.()),
    reset: jest.fn(),
    scrollToBottom: jest.fn(),
    buffer: {
      active: {
        viewportY: 0,
        getLine: (row: number) =>
          row < occupiedRows ? { translateToString: () => `row ${row}` } : undefined,
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

async function runWorker(instance: Harness, body: (worker: Harness) => Promise<void>) {
  const root = globalThis as unknown as { spawnWorker?: Harness };
  const previous = root.spawnWorker;
  root.spawnWorker = instance;
  try {
    new Function(sessionWorkerSource())();
    await body(instance);
  } finally {
    if (previous) root.spawnWorker = previous;
    else delete root.spawnWorker;
  }
}

function spctFrame(requestId: string, sequence: number, last: boolean, payload: Uint8Array) {
  const frame = new Uint8Array(28 + payload.byteLength);
  frame.set([0x53, 0x50, 0x43, 0x54, 1, 1]);
  const view = new DataView(frame.buffer);
  view.setUint16(6, last ? 1 : 0, true);
  const hex = requestId.replaceAll("-", "");
  for (let index = 0; index < 16; index += 1) {
    frame[8 + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  view.setUint32(24, sequence, true);
  frame.set(payload, 28);
  return frame;
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

/** The worker chains control messages on a promise tail; a few macrotask
 *  turns let a replay of any chunk count drain through it. */
async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
    await runWorker(harness(3), async (worker) => {
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
