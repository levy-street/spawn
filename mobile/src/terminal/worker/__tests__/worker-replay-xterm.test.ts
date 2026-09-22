import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runWorker, spctFrame } from "./worker-harness";

/**
 * The bundled session worker against a real xterm.js, headless in Node — the
 * same build the WebView vendors. A fake terminal proves the write sequence;
 * only the real one proves what the buffer holds afterwards, which is what a
 * reader sees. Skipped where the web workspace's xterm is not installed.
 */

const XTERM_PATH = resolve(__dirname, "../../../../../web/node_modules/@xterm/xterm/lib/xterm.js");
const xtermPresent = existsSync(XTERM_PATH);
if (!xtermPresent && process.env["CI"]) {
  // Skipping here would drop the only real-terminal proof without a red run.
  throw new Error(`The web workspace's xterm is not installed at ${XTERM_PATH}.`);
}

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
  await worker.receiveSessionCtl?.(spctFrame(requestId, 0, true, bytes));
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

(xtermPresent ? describe : describe.skip)("agent notices read off the screen", () => {
  const settle = () => new Promise((done) => setTimeout(done, 600));
  const noticePosts = (worker: Harness) =>
    worker.post.mock.calls
      .map(([message]: [{ type?: string; notice?: string | null }]) => message)
      .filter((message) => message?.type === "agent-notice")
      .map((message) => message.notice);

  test("Claude Code's 'Update installed · Restart to update' status bar is reported once", async () => {
    const term = realTerminal(8, 60);
    await runWorker(harness(term), async (worker) => {
      const requestId = openGates(worker);
      await replay(
        worker,
        requestId,
        seed(
          ["❯ hello"],
          "\x1b[7;1H⏵⏵ bypass permissions on · 1 monitor\r\n✓ Update installed · Restart to update",
        ),
      );
      await settle();
      expect(noticePosts(worker)).toEqual(["update_installed"]);
      expect(worker.error).not.toHaveBeenCalled();
    });
  });

  test("an ordinary screen says nothing, and a new generation withdraws a notice", async () => {
    const term = realTerminal(8, 60);
    await runWorker(harness(term), async (worker) => {
      const requestId = openGates(worker);
      await replay(worker, requestId, seed(["$ ls", "README.md"], "$ "));
      await settle();
      expect(noticePosts(worker)).toEqual([]);

      await new Promise<void>((done) =>
        term.write("\r\n✓ Update installed · Restart to apply", () => done()),
      );
      // Live output goes through the worker's own write queue; the seed above
      // is enough to show a direct paint is not what schedules the scan, so
      // drive it the way the session does.
      worker.resetSessionGeneration?.();
      await settle();
      expect(noticePosts(worker)).toEqual([]);
    });
  });
});
