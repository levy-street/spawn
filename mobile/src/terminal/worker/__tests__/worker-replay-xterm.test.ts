import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

/**
 * The bundled session worker against a real xterm.js, headless in Node — the
 * same build the WebView vendors. A fake terminal proves the write sequence;
 * only the real one proves what the buffer holds afterwards, which is what a
 * reader sees. Skipped where the web workspace's xterm is not installed.
 */

const XTERM_PATH = resolve(__dirname, "../../../../../web/node_modules/@xterm/xterm/lib/xterm.js");
const xtermPresent = existsSync(XTERM_PATH);

interface XTerm {
  rows: number;
  cols: number;
  write: (data: string | Uint8Array, done?: () => void) => void;
  reset: () => void;
  buffer: {
    active: {
      length: number;
      baseY: number;
      viewportY: number;
      getLine: (row: number) => { translateToString: (trim: boolean) => string } | undefined;
    };
    alternate: object;
  };
}

interface Harness {
  state: Record<string, unknown> & {
    term: XTerm;
    ctl: { readyState: string; bufferedAmount: number; send: jest.Mock };
  };
  post: jest.Mock;
  error: jest.Mock;
  telemetry: jest.Mock;
  fitTerminal: jest.Mock;
  sessionGate: (gate: string) => void;
  bytesFromMessage: jest.Mock;
  decodeBase64: jest.Mock;
  encodeBase64: jest.Mock;
  resetSessionGeneration?: () => void;
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

function realTerminal(rows: number, cols: number): XTerm {
  // biome-ignore lint/suspicious/noExplicitAny: the vendored bundle has no types here
  const { Terminal } = require(XTERM_PATH) as { Terminal: new (options: unknown) => any };
  return new Terminal({ rows, cols, scrollback: 200, allowProposedApi: true }) as XTerm;
}

function harness(term: XTerm): Harness {
  return {
    state: {
      term,
      ctl: { readyState: "open", bufferedAmount: 0, send: jest.fn() },
      cols: term.cols,
      rows: term.rows,
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

function spctFrame(requestId: string, payload: Uint8Array) {
  const frame = new Uint8Array(28 + payload.byteLength);
  frame.set([0x53, 0x50, 0x43, 0x54, 1, 1]);
  const view = new DataView(frame.buffer);
  view.setUint16(6, 1, true);
  const hex = requestId.replaceAll("-", "");
  for (let index = 0; index < 16; index += 1) {
    frame[8 + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  view.setUint32(24, 0, true);
  frame.set(payload, 28);
  return frame;
}

function openGates(worker: Harness): string {
  for (const gate of ["bindingAccepted", "ptyOpen", "ctlOpen", "daemonReady"]) {
    worker.sessionGate(gate);
  }
  const request = worker.state.ctl.send.mock.calls
    .map(([text]: [string]) => JSON.parse(text) as { operation: string; request_id: string })
    .find((sent) => sent.operation === "history");
  if (!request) throw new Error("The worker did not request history.");
  return request.request_id;
}

function seed(lines: string[], screen: string): Uint8Array {
  return new TextEncoder().encode(
    `\x1b[8;36;83t\x1b_sp:h1\x1b\\${lines.map((line) => `${line}\r\n`).join("")}\x1b[8;36;83t${screen}`,
  );
}

/** Deliver one replay for the pending history request and wait until the
 *  worker has written it all: xterm parses on macrotasks, one per write. */
async function replay(worker: Harness, requestId: string, bytes: Uint8Array) {
  worker.receiveSessionCtl?.(
    JSON.stringify({
      version: 1,
      kind: "response",
      request_id: requestId,
      operation: "history",
      ok: true,
      plain: false,
      pty_offset: 0,
      total_bytes: bytes.byteLength,
      chunks: 1,
    }),
  );
  await worker.receiveSessionCtl?.(spctFrame(requestId, bytes));
  for (let turn = 0; turn < 50; turn += 1) {
    await new Promise((done) => setTimeout(done, 0));
    if (worker.post.mock.calls.some(([m]: [{ state?: string }]) => m?.state === "ready")) return;
  }
  throw new Error("The worker never finished the replay.");
}

function bufferLines(term: XTerm): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  return lines;
}

(xtermPresent ? describe : describe.skip)("session worker against xterm.js", () => {
  test("the newest history sits above the screen after a seed", async () => {
    const term = realTerminal(6, 20);
    await runWorker(harness(term), async (worker) => {
      const requestId = openGates(worker);
      await replay(worker, requestId, seed(["one", "two", "last printed"], "\x1b[1;1Hprompt"));
      expect(worker.error).not.toHaveBeenCalled();
      const lines = bufferLines(term).filter((line) => line.length > 0);
      expect(lines).toEqual(["one", "two", "last printed", "prompt"]);
    });
  });

  test("a reseed keeps every history line although the previous screen set a scroll region", async () => {
    const term = realTerminal(6, 20);
    await runWorker(harness(term), async (worker) => {
      const first = openGates(worker);
      await replay(worker, first, seed(["old 1", "old 2"], "\x1b[1;1Hbefore\x1b[2;5r"));
      worker.post.mockClear();
      worker.resetSessionGeneration?.();
      worker.state.ctl.send.mockClear();
      const second = openGates(worker);
      const history = Array.from({ length: 10 }, (_, index) => `new ${index + 1}`);
      await replay(worker, second, seed(history, "\x1b[1;1Hp1\x1b[2;1Hp2\x1b[3;1Hp3"));
      expect(worker.error).not.toHaveBeenCalled();
      const lines = bufferLines(term).filter((line) => line.length > 0);
      expect(lines).toEqual([...history, "p1", "p2", "p3"]);
    });
  });
});
