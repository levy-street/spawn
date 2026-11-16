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
  state: { mode: string; pc: unknown; ctl: Channel; rtcSessionId: string };
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
          // A real microtask: jest's fake timers also hold queueMicrotask.
          void Promise.resolve().then(() => {
            channel.open();
            daemon(channel);
          });
          return channel;
        },
      },
      ctl: root,
      rtcSessionId: "rtc-1",
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
    /** As a view does when it gives up on an attachment. */
    detach(n: number) {
      harness.handlePairMessage?.({
        type: "pair-command",
        attachmentId: uuid(n),
        channel: "ctl",
        event: "close",
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

const SUSPECT = 10_000;
const PROBE = 10_000;
const ROOT = 20_000;
const BASE = 30_000;
const CAP = 300_000;

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a real wedge: two silent probes while the root answers ask native to replace the peer, once", async () => {
  const worker = hostWorker();
  try {
    worker.attach(1);
    await jest.advanceTimersByTimeAsync(SUSPECT);
    expect(worker.probes()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(PROBE);
    expect(worker.probes()).toHaveLength(2);
    expect(worker.peer.pings).toBe(1);
    // The root answered at once; the second probe still gets its full window.
    await jest.advanceTimersByTimeAsync(PROBE - 1);
    expect(worker.rebuilds()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(worker.rebuilds()).toEqual([
      {
        type: "rebuild",
        reason: "channels_unanswered",
        rtcSessionId: "rtc-1",
        waitedMs: SUSPECT,
        probeMs: 2 * PROBE,
        rootAnswered: true,
        rootMs: 0,
        rebuilds: 1,
      },
    ]);
    expect(worker.probes().every((probe) => probe.readyState === "closed")).toBe(true);
    // Native has not replaced it yet; more views waiting on it change nothing
    // until the backoff allows another.
    worker.attach(2);
    worker.attach(3);
    await jest.advanceTimersByTimeAsync(BASE - 5_000);
    expect(worker.rebuilds()).toHaveLength(1);
    expect(worker.probes()).toHaveLength(2);
  } finally {
    worker.close();
  }
});

test("a hello slower than the pong on a working peer stands the watch down", async () => {
  // The first probe's hello five seconds after the pong; or only the second
  // probe's, late in its window.
  for (const late of [
    (index: number) => (index === 0 ? PROBE + 5_000 : null),
    (index: number) => (index === 1 ? PROBE - 2_000 : null),
  ]) {
    const worker = hostWorker();
    let made = 0;
    worker.peer.daemon = (channel) => {
      if (!channel.label.startsWith("spawn.host.ctl/")) return;
      const delay = late(made++);
      if (delay !== null) setTimeout(() => speaks(channel), delay);
    };
    try {
      worker.attach(1);
      await jest.advanceTimersByTimeAsync(SUSPECT + 2 * PROBE + 2 * ROOT);
      expect(worker.peer.pings).toBe(1);
      expect(worker.rebuilds()).toHaveLength(0);
      expect(worker.probes().every((probe) => probe.readyState === "closed")).toBe(true);
    } finally {
      worker.close();
    }
  }
});

test("a silent root gets two pings of twenty seconds before the peer is replaced", async () => {
  // An old daemon's association stops acknowledging anything once channels
  // pile up behind its dead acceptor: the root goes quiet with them.
  const worker = hostWorker();
  worker.peer.rootAnswers = false;
  try {
    worker.attach(1);
    await jest.advanceTimersByTimeAsync(SUSPECT + PROBE + ROOT);
    expect(worker.peer.pings).toBe(2);
    await jest.advanceTimersByTimeAsync(ROOT - 1);
    expect(worker.rebuilds()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(worker.rebuilds()).toEqual([
      expect.objectContaining({
        rootAnswered: false,
        rootMs: 2 * ROOT,
        probeMs: PROBE + 2 * ROOT,
      }),
    ]);
    expect(worker.probes().every((probe) => probe.readyState === "closed")).toBe(true);
  } finally {
    worker.close();
  }
});

test("a fault a new peer does not fix: rebuilds back off 30 s, 60 s, 120 s, 240 s, then 5 min, though views reattach and are answered each time", async () => {
  const worker = hostWorker();
  const rebuiltAt: number[] = [];
  let next = 1;
  try {
    // A terminal that keeps retrying on a peer that never answers it.
    for (let step = 0; step < 300 && rebuiltAt.length < 7; step++) {
      const stuck = next++;
      worker.attach(stuck);
      await jest.advanceTimersByTimeAsync(SUSPECT + 500);
      worker.detach(stuck);
      if (worker.rebuilds().length > rebuiltAt.length) {
        rebuiltAt.push(performance.now());
        // As native does: the peer is replaced, the watch reset, and views
        // reattach and are answered on the new one before the fault returns.
        worker.harness.channelWatch?.reset();
        worker.peer.daemon = speaks;
        for (let view = 0; view < 3; view++) worker.attach(next++);
        await jest.advanceTimersByTimeAsync(1_000);
        worker.peer.daemon = silent;
      }
    }
    const gaps = rebuiltAt.slice(1).map((at, index) => at - (rebuiltAt[index] ?? 0));
    expect(gaps).toHaveLength(6);
    const [first = 0, second = 0, third = 0, fourth = 0, ...capped] = gaps;
    expect(first).toBeGreaterThanOrEqual(BASE);
    expect(second).toBeGreaterThanOrEqual(2 * BASE);
    expect(third).toBeGreaterThanOrEqual(4 * BASE);
    expect(fourth).toBeGreaterThanOrEqual(8 * BASE);
    for (const gap of capped) {
      expect(gap).toBeGreaterThanOrEqual(CAP);
      expect(gap).toBeLessThan(CAP + 2 * (SUSPECT + 500) + 2 * PROBE + 1_000);
    }
    expect(worker.rebuilds().map((message) => message["rebuilds"])).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Five healthy minutes end the run: the next fault starts at the first rung.
    worker.harness.channelWatch?.reset();
    await jest.advanceTimersByTimeAsync(CAP);
    worker.attach(next++);
    await jest.advanceTimersByTimeAsync(SUSPECT + 2 * PROBE);
    expect(worker.rebuilds().at(-1)).toMatchObject({ rebuilds: 1 });
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
    await jest.advanceTimersByTimeAsync(2 * (SUSPECT + 2 * PROBE + 2 * ROOT));
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
    await jest.advanceTimersByTimeAsync(SUSPECT);
    expect(worker.probes()).toHaveLength(1);
    expect(worker.probes()[0]?.readyState).toBe("closed");
    await jest.advanceTimersByTimeAsync(2 * PROBE + 2 * ROOT);
    expect(worker.peer.pings).toBe(0);
    expect(worker.rebuilds()).toHaveLength(0);
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
    await jest.advanceTimersByTimeAsync(SUSPECT + 2 * PROBE + 5_000);
    expect(worker.probes()).toHaveLength(2);
    expect(worker.rebuilds()).toHaveLength(1);
  } finally {
    worker.close();
  }
});

test("a burst bigger than an old daemon's accept queue on a working peer is slow, not a wedge", async () => {
  // Ten views reattach at once: twenty channels against an old SCTP that
  // queues sixteen; the rest are retransmitted once it drains, here after
  // more than a channel's ten seconds. The probes find the acceptor alive.
  const worker = hostWorker();
  let made = 0;
  worker.peer.daemon = (channel) => {
    if (channel.label.startsWith("spawn.host.ctl/") || ++made <= 16) {
      if (channel.label.startsWith("spawn.ctl/") || channel.label.startsWith("spawn.host.ctl/"))
        speaks(channel);
    } else if (channel.label.startsWith("spawn.ctl/")) {
      setTimeout(() => speaks(channel), SUSPECT + 2_000);
    }
  };
  try {
    for (let n = 1; n <= 10; n++) worker.attach(n);
    await jest.advanceTimersByTimeAsync(SUSPECT + 2 * PROBE + 2 * ROOT);
    expect(worker.probes().length).toBeGreaterThanOrEqual(1);
    expect(worker.probes().every((probe) => probe.readyState === "closed")).toBe(true);
    expect(worker.rebuilds()).toHaveLength(0);
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
    await jest.advanceTimersByTimeAsync(3 * SUSPECT);
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
    await jest.advanceTimersByTimeAsync(3 * SUSPECT);
    expect(worker.probes()).toHaveLength(0);

    worker.attach(2);
    await jest.advanceTimersByTimeAsync(SUSPECT + PROBE + 1_000);
    expect(worker.probes()).toHaveLength(2);
    worker.harness.channelWatch?.reset();
    expect(worker.probes().every((probe) => probe.readyState === "closed")).toBe(true);
    await jest.advanceTimersByTimeAsync(2 * PROBE + 2 * ROOT);
    expect(worker.rebuilds()).toHaveLength(0);
  } finally {
    worker.close();
  }
});
