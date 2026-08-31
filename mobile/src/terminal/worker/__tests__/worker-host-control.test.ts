import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

interface WorkerHarness {
  state: {
    ctl: {
      readyState: string;
      bufferedAmount: number;
      bufferedAmountLowThreshold: number;
      send: jest.Mock;
      addEventListener: jest.Mock;
      removeEventListener: jest.Mock;
    };
  };
  post: jest.Mock;
  error: jest.Mock;
  decodeBase64(value: string): Uint8Array;
  handleHostMessage?: (message: Record<string, unknown>) => void;
}

function hostWorkerSource(): string {
  const marker = "const host = { binding: false, channel: false, hello: false }";
  const markerIndex = TERMINAL_WORKER_HTML.indexOf(marker);
  const start = TERMINAL_WORKER_HTML.lastIndexOf("(() => {", markerIndex);
  const end = TERMINAL_WORKER_HTML.indexOf("\n})();", markerIndex) + "\n})();".length;
  if (markerIndex < 0 || start < 0 || end < start)
    throw new Error("Host worker source is missing.");
  return TERMINAL_WORKER_HTML.slice(start, end);
}

describe("offline host-control worker", () => {
  test("forwards the complete hello before readiness so capabilities cannot race", () => {
    expect(TERMINAL_WORKER_HTML).toContain('const HOST_HELLO_BRIDGE_ID = "$host.hello"');
    expect(TERMINAL_WORKER_HTML).toContain("postResponse(HOST_HELLO_BRIDGE_ID, true, message)");
    expect(TERMINAL_WORKER_HTML.indexOf("postResponse(HOST_HELLO_BRIDGE_ID")).toBeLessThan(
      TERMINAL_WORKER_HTML.indexOf("host.hello = true"),
    );
  });

  test("keeps host writes under the 256 KiB SCTP high-water mark", () => {
    expect(TERMINAL_WORKER_HTML).toContain("const BUFFERED_HIGH_WATER = 256 * 1024");
    expect(TERMINAL_WORKER_HTML).toContain("channel.bufferedAmount <= BUFFERED_HIGH_WATER");
    expect(TERMINAL_WORKER_HTML).toContain('"bufferedamountlow"');
    expect(TERMINAL_WORKER_HTML).toContain("const STREAM_TIMEOUT_MS = 60_000");
    expect(TERMINAL_WORKER_HTML).toContain(
      'if (type === "chunk" || type === "end") await waitForWritable()',
    );
  });

  test("does not acknowledge a chunk until worker backpressure clears", async () => {
    jest.useFakeTimers();
    const send = jest.fn();
    let writable: (() => void) | null = null;
    const harness: WorkerHarness = {
      state: {
        ctl: {
          readyState: "open",
          bufferedAmount: 256 * 1024 + 1,
          bufferedAmountLowThreshold: 0,
          send,
          addEventListener: jest.fn((_type: string, listener: () => void) => {
            writable = listener;
          }),
          removeEventListener: jest.fn(),
        },
      },
      post: jest.fn(),
      error: jest.fn(),
      decodeBase64: () => Uint8Array.of(1),
    };
    const root = globalThis as unknown as { spawnWorker?: WorkerHarness };
    const previous = root.spawnWorker;
    root.spawnWorker = harness;
    try {
      new Function(hostWorkerSource())();
      harness.handleHostMessage?.({
        type: "host-request",
        requestId: "chunk-command",
        operation: "$host.stream.chunk",
        payload: { stream_id: "stream", sequence: 0, bytes_b64: "AQ==" },
      });
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
      harness.state.ctl.bufferedAmount = 0;
      (writable as (() => void) | null)?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(send).toHaveBeenCalledTimes(1);
      expect(harness.post).toHaveBeenCalledWith(
        expect.objectContaining({ type: "host-response", requestId: "chunk-command", ok: true }),
      );
    } finally {
      if (previous) root.spawnWorker = previous;
      else delete root.spawnWorker;
      jest.useRealTimers();
    }
  });

  test("uses host-only stream commands with the 8 KiB wire ceiling", () => {
    expect(TERMINAL_WORKER_HTML).toContain('const STREAM_COMMAND_PREFIX = "$host.stream."');
    expect(TERMINAL_WORKER_HTML).toContain("const MAX_CHUNK_BYTES = 8 * 1024");
    expect(TERMINAL_WORKER_HTML).toContain("type: `stream.");
    expect(TERMINAL_WORKER_HTML).toContain('message.type.startsWith("stream.")');
  });

  test("remains a single offline asset with only the approved base sentinel", () => {
    expect(TERMINAL_WORKER_HTML).toContain('<base href="https://spawn.local/">');
    expect(TERMINAL_WORKER_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(TERMINAL_WORKER_HTML).not.toMatch(/<link[^>]+href=/i);
  });
});
