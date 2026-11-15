import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

/**
 * The host worker's channel watch (worker-channel-watch.js) with the modules
 * that open channels on its peer: terminal pairs, host tools, and the root
 * protocol that carries its ping. The "daemon" here opens every channel the
 * way a WebView does — at once, without waiting for the daemon — and then
 * speaks on it, refuses it, or says nothing, as a daemon whose channel
 * acceptor has ended does while its root channel still answers (#120).
 */

function moduleSource(marker: string): string {
  const markerIndex = TERMINAL_WORKER_HTML.indexOf(marker);
  const start = TERMINAL_WORKER_HTML.lastIndexOf("(() => {", markerIndex);
  const end = TERMINAL_WORKER_HTML.indexOf("\n})();", markerIndex) + "\n})();".length;
  if (markerIndex < 0 || start < 0 || end < start)
    throw new Error(`Missing worker module: ${marker}`);
  return TERMINAL_WORKER_HTML.slice(start, end);
}

const SOURCES = [
  "const host = { binding: false, channel: false, hello: false }",
  "const consumers = new Map();",
  "const DAEMON_SPEAKS_FIRST = ",
  "const MAX_RECEIVE = 2 * 1024 * 1024",
].map(moduleSource);

const sessionId = "11111111-2222-4333-8444-555555555555";
const viewId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Daemon = (channel: Channel) => void;
const silent: Daemon = () => {};
const speaks: Daemon = (channel) =>
  channel.onmessage?.({ data: JSON.stringify({ version: 1, type: "hello" }) });
const refuses: Daemon = (channel) => channel.close();

class Channel {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "arraybuffer";
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(
    readonly label: string,
    private readonly onSend: (channel: Channel, value: unknown) => void = () => {},
  ) {}
  send(value: unknown) {
    this.sent.push(value);
    this.onSend(this, value);
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  /** As the daemon closing it, unless the worker took its handlers first. */
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  addEventListener() {}
  removeEventListener() {}
}

interface Harness {
  state: { mode: string; pc: unknown; ctl: Channel };
  post: jest.Mock;
  error: jest.Mock;
  decodeBase64(value: string): Uint8Array;
  encodeBase64(value: Uint8Array): string;
  bytesFromMessage(value: unknown): Promise<Uint8Array>;
  handlePairMessage?: (message: Record<string, unknown>) => boolean;
  handleHostConsumerMessage?: (message: Record<string, unknown>) => boolean;
  receiveHostCtl?: (value: unknown) => void;
  closePairChannels?: () => void;
  closeHostConsumers?: () => void;
  channelWatch?: { reset(): void };
}

function hostWorker() {
  const channels: Channel[] = [];
  const peer = { daemon: silent, rootAnswers: true, pings: 0 };
  const root = new Channel("spawn.host.ctl", (_channel, value) => {
    const frame = JSON.parse(String(value)) as { request_id: string; operation: string };
    if (frame.operation !== "ping") return;
    peer.pings++;
    if (!peer.rootAnswers) return;
    harness.receiveHostCtl?.(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: frame.request_id,
        ok: true,
        result: { pong: true },
      }),
    );
  });
  root.readyState = "open";
  const harness: Harness = {
    state: {
      mode: "host",
      pc: {
        connectionState: "connected",
        createDataChannel(label: string) {
          const channel = new Channel(label);
          channels.push(channel);
          const daemon = peer.daemon;
          queueMicrotask(() => {
            channel.open();
            daemon(channel);
          });
          return channel;
        },
      },
      ctl: root,
    },
    post: jest.fn(),
    error: jest.fn(),
    decodeBase64: (value) => new Uint8Array(Buffer.from(value, "base64")),
    encodeBase64: (value) => Buffer.from(value).toString("base64"),
    bytesFromMessage: async (value) => new Uint8Array(value as ArrayBuffer),
  };
  new Function("globalThis", SOURCES.join("\n"))({ spawnWorker: harness });
  const tools = new Set<string>();
  return {
    harness,
    peer,
    channels,
    attach(n: number) {
      harness.handlePairMessage?.({
        type: "pair-attach",
        attachmentId: uuid(n),
        sessionId,
        viewId,
      });
    },
    openTool(n: number) {
      tools.add(`spawn.host.ctl/${uuid(n)}`);
      harness.handleHostConsumerMessage?.({ type: "host-consumer-open", consumerId: uuid(n) });
    },
    /** Host-control channels the watch opened for itself. */
    probes() {
      return channels.filter(
        (channel) => channel.label.startsWith("spawn.host.ctl/") && !tools.has(channel.label),
      );
    },
    rebuilds() {
      return harness.post.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .filter((message) => message["type"] === "rebuild");
    },
    close() {
      harness.closePairChannels?.();
      harness.closeHostConsumers?.();
      harness.channelWatch?.reset();
    },
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a peer that stops opening channels asks native to replace it, once", async () => {
  const worker = hostWorker();
  try {
    worker.attach(1);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(worker.probes()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(worker.probes()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(worker.peer.pings).toBe(1);
    expect(worker.rebuilds()).toEqual([
      {
        type: "rebuild",
        reason: "channels_unanswered",
        waitedMs: 10_000,
        probeMs: 10_000,
        pingMs: 0,
        rebuilds: 1,
      },
    ]);
    expect(worker.probes()[0]?.readyState).toBe("closed");

    // Native has not replaced it yet; more views waiting on it change nothing
    // until the backoff allows another.
    worker.attach(2);
    worker.attach(3);
    await jest.advanceTimersByTimeAsync(25_000);
    expect(worker.rebuilds()).toHaveLength(1);
    expect(worker.probes()).toHaveLength(1);
  } finally {
    worker.close();
  }
});

test("rebuilds in a row back off: thirty seconds, then sixty", async () => {
  const worker = hostWorker();
  try {
    const at: number[] = [];
    for (let n = 1; n <= 30 && at.length < 3; n++) {
      worker.attach(n);
      await jest.advanceTimersByTimeAsync(10_000);
      if (worker.rebuilds().length > at.length) at.push(Date.now());
    }
    const [first = 0, second = 0, third = 0] = at;
    expect(at).toHaveLength(3);
    expect(second - first).toBeGreaterThanOrEqual(30_000);
    expect(third - second).toBeGreaterThanOrEqual(60_000);
    expect(worker.rebuilds().map((message) => message["rebuilds"])).toEqual([1, 2, 3]);
  } finally {
    worker.close();
  }
});

test("a refused channel is an answer: refusals never probe or rebuild", async () => {
  const worker = hostWorker();
  worker.peer.daemon = refuses;
  try {
    for (let n = 1; n <= 4; n++) {
      worker.attach(n);
      await jest.advanceTimersByTimeAsync(5_000);
    }
    worker.openTool(9);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(worker.probes()).toHaveLength(0);
    expect(worker.peer.pings).toBe(0);
    expect(worker.rebuilds()).toHaveLength(0);
  } finally {
    worker.close();
  }
});

test("a slow session on a working peer is probed and left alone", async () => {
  const worker = hostWorker();
  // The session's channels wait on its worker; anything else is accepted.
  worker.peer.daemon = (channel) => {
    if (channel.label.startsWith("spawn.host.ctl/")) speaks(channel);
  };
  try {
    worker.attach(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(worker.probes()).toHaveLength(1);
    expect(worker.probes()[0]?.readyState).toBe("closed");
    await jest.advanceTimersByTimeAsync(30_000);
    expect(worker.peer.pings).toBe(0);
    expect(worker.rebuilds()).toHaveLength(0);
  } finally {
    worker.close();
  }
});

test("a peer whose root is silent too is left to its own recovery", async () => {
  const worker = hostWorker();
  worker.peer.rootAnswers = false;
  try {
    worker.attach(1);
    await jest.advanceTimersByTimeAsync(25_000);
    expect(worker.peer.pings).toBe(1);
    expect(worker.rebuilds()).toHaveLength(0);
    expect(worker.probes()[0]?.readyState).toBe("closed");
  } finally {
    worker.close();
  }
});

test("views and tools waiting on one dead peer replace it once", async () => {
  const worker = hostWorker();
  try {
    worker.attach(1);
    worker.attach(2);
    worker.openTool(3);
    await jest.advanceTimersByTimeAsync(25_000);
    expect(worker.probes()).toHaveLength(1);
    expect(worker.rebuilds()).toHaveLength(1);
  } finally {
    worker.close();
  }
});

test("a quiet shell is not a symptom: only channels the daemon speaks on first are watched", async () => {
  const worker = hostWorker();
  // The control channel gets its ready; the pty channel hears nothing.
  worker.peer.daemon = (channel) => {
    if (channel.label.startsWith("spawn.ctl/")) channel.onmessage?.({ data: '{"event":"ready"}' });
  };
  try {
    worker.attach(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(worker.probes()).toHaveLength(0);
  } finally {
    worker.close();
  }
});

test("a peer leaving readiness forgets what it was waiting on", async () => {
  const worker = hostWorker();
  try {
    worker.attach(1);
    await jest.advanceTimersByTimeAsync(5_000);
    worker.harness.channelWatch?.reset();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(worker.probes()).toHaveLength(0);

    worker.attach(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(worker.probes()).toHaveLength(1);
    worker.harness.channelWatch?.reset();
    expect(worker.probes()[0]?.readyState).toBe("closed");
    await jest.advanceTimersByTimeAsync(30_000);
    expect(worker.rebuilds()).toHaveLength(0);
  } finally {
    worker.close();
  }
});
