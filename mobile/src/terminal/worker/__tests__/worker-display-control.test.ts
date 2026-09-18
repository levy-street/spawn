import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

interface SessionHarness {
  state: {
    term: { cols: number; rows: number } | null;
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
  sessionGate: jest.Mock & ((gate: string) => void);
  bytesFromMessage: jest.Mock;
  decodeBase64: jest.Mock;
  encodeBase64: jest.Mock;
  receiveSessionCtl?: (value: unknown) => void;
  sendResize?: (cols: number, rows: number) => void;
  takeDisplayControl?: () => boolean;
}

/** The session worker is one IIFE inside the bundled asset; run just that. */
function sessionWorkerSource(): string {
  const marker = "const MAX_PREBOOT_BYTES = 12 * 1024 * 1024";
  const markerIndex = TERMINAL_WORKER_HTML.indexOf(marker);
  const start = TERMINAL_WORKER_HTML.lastIndexOf("(() => {", markerIndex);
  const end = TERMINAL_WORKER_HTML.indexOf("\n})();", markerIndex) + "\n})();".length;
  if (markerIndex < 0 || start < 0 || end < start) {
    throw new Error("Session worker source is missing.");
  }
  return TERMINAL_WORKER_HTML.slice(start, end);
}

function harness(overrides: Partial<SessionHarness["state"]> = {}): SessionHarness {
  return {
    state: {
      term: { cols: 53, rows: 30 },
      ctl: { readyState: "open", bufferedAmount: 0, send: jest.fn() },
      cols: 53,
      rows: 30,
      displayOwner: null,
      displayGeometry: null,
      displayViewers: 1,
      ...overrides,
    },
    post: jest.fn(),
    error: jest.fn(),
    telemetry: jest.fn(),
    fitTerminal: jest.fn(),
    sessionGate: jest.fn(),
    bytesFromMessage: jest.fn(async () => null),
    decodeBase64: jest.fn(() => Uint8Array.of()),
    encodeBase64: jest.fn(() => ""),
  };
}

async function runWorker(
  instance: SessionHarness,
  body: (worker: SessionHarness) => Promise<void> | void,
): Promise<void> {
  const root = globalThis as unknown as { spawnWorker?: SessionHarness };
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

function displayEvent(owner: boolean, cols: number, rows: number, viewers = 2): string {
  return JSON.stringify({
    version: 1,
    kind: "event",
    event: "display_state",
    owner,
    cols,
    rows,
    viewers,
  });
}

function sentOperations(send: jest.Mock): { operation: string; cols?: number; rows?: number }[] {
  return send.mock.calls
    .map(([text]: [string]) => JSON.parse(text) as Record<string, unknown>)
    .map((request) => ({
      operation: String(request["operation"]),
      ...(typeof request["cols"] === "number" ? { cols: request["cols"] } : {}),
      ...(typeof request["rows"] === "number" ? { rows: request["rows"] } : {}),
    }));
}

describe("session worker display control", () => {
  test("opening a view preserves the owning device and its geometry", async () => {
    const instance = harness();
    await runWorker(instance, async (worker) => {
      worker.receiveSessionCtl?.(displayEvent(false, 120, 40));
      await Promise.resolve();
      await Promise.resolve();

      expect(sentOperations(worker.state.ctl.send)).toEqual([]);
      expect(worker.state.displayOwner).toBe(false);
      expect(worker.state.displayGeometry).toEqual({ cols: 120, rows: 40 });
      expect(worker.post).toHaveBeenCalledWith({
        type: "display",
        owner: false,
        viewers: 2,
        cols: 120,
        rows: 40,
      });
    });
  });

  test("does not steal the display back after the first frame", async () => {
    const instance = harness();
    await runWorker(instance, async (worker) => {
      worker.receiveSessionCtl?.(displayEvent(true, 53, 30));
      await Promise.resolve();
      await Promise.resolve();
      worker.state.ctl.send.mockClear();

      worker.receiveSessionCtl?.(displayEvent(false, 120, 40));
      await Promise.resolve();
      await Promise.resolve();

      expect(worker.state.ctl.send).not.toHaveBeenCalled();
      expect(worker.state.displayOwner).toBe(false);
      // A follower matches the owner's grid rather than clipping every row.
      expect(worker.state.displayGeometry).toEqual({ cols: 120, rows: 40 });
      expect(worker.fitTerminal).toHaveBeenCalled();
    });
  });

  test("a follower never resizes the PTY it does not own", async () => {
    const instance = harness({ displayOwner: false, displayGeometry: { cols: 120, rows: 40 } });
    await runWorker(instance, (worker) => {
      worker.sendResize?.(53, 30);
      expect(worker.state.ctl.send).not.toHaveBeenCalled();
    });
  });

  test("bootstraps and publishes the fitted grid, then stops repeating it", async () => {
    const instance = harness();
    await runWorker(instance, async (worker) => {
      for (const gate of ["bindingAccepted", "ptyOpen", "ctlOpen", "daemonReady", "historyReady"]) {
        worker.sessionGate(gate);
      }

      const operations = sentOperations(worker.state.ctl.send);
      // History is rendered by the daemon at the columns it is asked for, so the
      // request has to quote the fitted grid and not the 80x24 placeholder.
      expect(operations).toContainEqual({ operation: "history", cols: 53, rows: 30 });
      expect(operations).toContainEqual({ operation: "resize", cols: 53, rows: 30 });

      worker.receiveSessionCtl?.(displayEvent(true, 53, 30));
      await Promise.resolve();
      await Promise.resolve();
      worker.state.ctl.send.mockClear();

      worker.sendResize?.(53, 30);
      expect(worker.state.ctl.send).not.toHaveBeenCalled();

      worker.sendResize?.(53, 20);
      expect(sentOperations(worker.state.ctl.send)).toEqual([
        { operation: "resize", cols: 53, rows: 20 },
      ]);
    });
  });
});

describe("session worker geometry wiring", () => {
  test("fits before the control channel can quote a grid", () => {
    const fit = TERMINAL_WORKER_HTML.indexOf("    fitTerminal();\n    const container = document");
    const ready = TERMINAL_WORKER_HTML.indexOf(
      'api.post({ type: "ready", renderer: state.renderer })',
    );
    expect(fit).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(fit);
  });

  test("scrolls on touch even while the program is tracking the mouse", () => {
    // xterm only handles touch scrolling when mouse tracking is off, and an
    // agent TUI turns it on, so the gesture is read ahead of xterm instead and
    // handed back as the wheel event xterm already knows how to route.
    expect(TERMINAL_WORKER_HTML).toContain("installTouchScroll(container)");
    expect(TERMINAL_WORKER_HTML).toContain("{ capture: true, passive: false }");
    expect(TERMINAL_WORKER_HTML).toContain('new WheelEvent("wheel"');
  });

  test("keeps a gutter so the first column clears the bezel", () => {
    expect(TERMINAL_WORKER_HTML).toContain(".xterm{height:100%;padding:0 8px}");
  });

  test("re-measures itself off the surface rather than waiting to be told", () => {
    // A native fit message sent before the WebView finishes loading is dropped,
    // which used to leave the grid stuck on the 80x24 placeholder forever.
    expect(TERMINAL_WORKER_HTML).toContain("new ResizeObserver(scheduleFit).observe(container)");
    expect(TERMINAL_WORKER_HTML).toContain("document.fonts?.ready.then(scheduleFit)");
  });

  test("a follower shrinks its type instead of clipping the owner's columns", () => {
    expect(TERMINAL_WORKER_HTML).toContain("const MIN_FOLLOWER_FONT_SIZE = 6");
    expect(TERMINAL_WORKER_HTML).toContain("fitFontToColumns(geometry.cols)");
    expect(TERMINAL_WORKER_HTML).toContain("terminal.resize(geometry.cols, geometry.rows)");
  });
});
