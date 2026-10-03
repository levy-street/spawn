import { WorkerBridge } from "@/terminal/transport/bridge";
import {
  HOST_CONSUMER_LIMIT_CODE,
  HOST_CONSUMER_LIMIT_MESSAGE,
  HOST_CONTROL_REQUEST_BUDGET,
  HOST_CONTROL_ROTATE_AFTER_REQUESTS,
} from "@/terminal/transport/host-ctl-codec";
import { createHostConsumerTransport } from "@/terminal/transport/host-transport";
import {
  CONNECT_TIMEOUT_MS,
  type HostTransport,
  type TransportState,
} from "@/terminal/transport/types";
import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

class Channel extends EventTarget {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(readonly label: string) {
    super();
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  receive(text: string) {
    this.onmessage?.({ data: text });
  }
  open(capabilities = ["fs.home", "session.transport.v1"]) {
    this.readyState = "open";
    this.onopen?.();
    this.receive(
      JSON.stringify({ version: 1, type: "hello", protocol: "spawn.host.ctl", capabilities }),
    );
  }
  /** What a daemon at its tool limit does: accept the channel, then close it. */
  refuse() {
    this.readyState = "open";
    this.onopen?.();
    this.close();
  }
  requests() {
    return this.sent
      .map((frame) => JSON.parse(frame) as { type: string; request_id: string; operation: string })
      .filter((frame) => frame.type === "request");
  }
  answerLast(result: unknown = { pong: true }) {
    const request = this.requests().at(-1);
    if (!request) throw new Error(`No request on ${this.label}`);
    this.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result,
      }),
    );
  }
}

function runtimeSource(marker: string) {
  const offset = TERMINAL_WORKER_HTML.indexOf(marker);
  if (offset < 0) throw new Error(`Missing worker module: ${marker}`);
  return TERMINAL_WORKER_HTML.slice(
    TERMINAL_WORKER_HTML.lastIndexOf("(() => {", offset),
    TERMINAL_WORKER_HTML.indexOf("\n})();", offset) + 6,
  );
}

function harness() {
  const bridge = new WorkerBridge();
  let suppressReceiptsFor: string | undefined;
  const channels: Channel[] = [];
  const stateListeners = new Set<(state: TransportState) => void>();
  const parent = {
    hostId: "11111111-2222-4333-8444-555555555555",
    state: "ready" as TransportState,
    on: (_event: string, listener: (state: TransportState) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
  const api = {
    state: {
      mode: "host",
      ctl: { readyState: "open" },
      pc: {
        connectionState: "connected",
        createDataChannel: (label: string) => {
          const channel = new Channel(label);
          channels.push(channel);
          return channel;
        },
      },
    },
    post: (message: unknown) => bridge.receive(JSON.stringify({ ...(message as object), v: 1 })),
    decodeBase64: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
    handleHostConsumerMessage: (_message: unknown): boolean => false,
    closeHostConsumers: () => {},
  };
  for (const marker of ["function createHostProtocol(api)", "const consumers = new Map();"])
    new Function("globalThis", runtimeSource(marker))({ spawnWorker: api });
  bridge.attach((raw) => {
    const message = JSON.parse(raw) as { type: string; consumerId?: string };
    if (message.type === "host-consumer-received" && message.consumerId === suppressReceiptsFor)
      return;
    expect(api.handleHostConsumerMessage(message)).toBe(true);
  });
  const openSignal = jest.fn();
  const create = () =>
    createHostConsumerTransport(
      { hostId: parent.hostId, hostIdentityPublicKey: "root-already-verified", bridge, openSignal },
      parent as unknown as HostTransport,
    );
  return {
    channels,
    channel(index: number) {
      const channel = channels[index];
      if (!channel) throw new Error(`Missing channel ${index}`);
      return channel;
    },
    parent,
    create,
    openSignal,
    stateListeners,
    suppressReceipts(channel: Channel) {
      suppressReceiptsFor = channel.label.slice("spawn.host.ctl/".length);
    },
    setState(state: TransportState) {
      parent.state = state;
      for (const listener of stateListeners) listener(state);
    },
  };
}

afterEach(() => jest.useRealTimers());

test("real native consumer protocols use separate worker channels and isolate protocol failure", async () => {
  jest.useFakeTimers();
  const h = harness();
  const first = h.create(),
    second = h.create();
  try {
    const openings = [first.open(), second.open()];
    expect(h.channels).toHaveLength(2);
    expect(new Set(h.channels.map((channel) => channel.label)).size).toBe(2);
    for (const channel of h.channels) {
      expect(channel.label).toMatch(/^spawn.host.ctl\//);
      channel.open();
    }
    await Promise.all(openings);
    expect(h.openSignal).not.toHaveBeenCalled();
    const a = first.request("fs.home").catch((error: unknown) => error);
    const b = second.request("fs.home");
    await jest.advanceTimersByTimeAsync(5);
    h.channel(0).receive("malformed JSON");
    expect(first.state).toBe("failed");
    expect(second.state).toBe("ready");
    expect(h.parent.state).toBe("ready");
    expect(h.channel(0).readyState).toBe("closed");
    const request = JSON.parse(h.channel(1).sent[0] ?? "") as { request_id: string };
    h.channel(1).receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: { path: "/home/sibling" },
      }),
    );
    expect(await b).toEqual({ path: "/home/sibling" });
    expect(await a).toBeInstanceOf(Error);
  } finally {
    first.close();
    second.close();
  }
});

test("reopening a child while its parent reconnects keeps one subscription and cleans it on close", async () => {
  const h = harness();
  const consumer = h.create();
  try {
    const first = consumer.open();
    h.channel(0).open();
    await first;
    h.setState("connecting");
    const second = consumer.open();
    expect(h.stateListeners.size).toBe(1);
    h.setState("ready");
    expect(h.channels).toHaveLength(2);
    h.channel(1).open();
    await second;
    consumer.close();
    expect(h.stateListeners.size).toBe(0);
    h.setState("connecting");
    h.setState("ready");
    expect(h.channels).toHaveLength(2);
  } finally {
    consumer.close();
  }
});

test("parent recovery cancels a retired child's pending retry timer", async () => {
  jest.useFakeTimers();
  const h = harness();
  const consumer = h.create();
  try {
    const opening = consumer.open();
    h.channel(0).open();
    await opening;
    h.channel(0).close();
    expect(consumer.state).toBe("reconnecting");
    h.setState("connecting");
    h.setState("ready");
    h.channel(1).open();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.channels).toHaveLength(2);
    expect(h.channel(1).readyState).toBe("open");
    expect(consumer.state).toBe("ready");
  } finally {
    consumer.close();
  }
});

test("an unconsumed receive queue closes only its tool while acknowledged siblings keep flowing", async () => {
  const h = harness();
  const stalled = h.create(),
    healthy = h.create();
  try {
    const openings = [stalled.open(), healthy.open()];
    h.channel(0).open();
    h.channel(1).open();
    await Promise.all(openings);
    h.suppressReceipts(h.channel(0));
    const frame = JSON.stringify({
      version: 1,
      type: "response",
      request_id: "late-completed-request",
      ok: true,
      result: { data: "x".repeat(12 * 1024) },
    });
    for (let index = 0; index < 200; index += 1) {
      h.channel(0).receive(frame);
      h.channel(1).receive(frame);
      // Let the native consumer acknowledge receipt before the next frame.
      await Promise.resolve();
    }
    expect(stalled.state).toBe("failed");
    expect(stalled.lastError?.code).toBe("host_consumer_receive_limit");
    expect(h.channel(0).readyState).toBe("closed");
    expect(healthy.state).toBe("ready");
    expect(h.channel(1).readyState).toBe("open");
    expect(h.parent.state).toBe("ready");
    expect(h.openSignal).not.toHaveBeenCalled();
  } finally {
    stalled.close();
    healthy.close();
  }
});

test("parent loss clears backpressured consumer work and fences delayed events on same-peer recovery", async () => {
  jest.useFakeTimers();
  const h = harness();
  const consumer = h.create();
  try {
    const opening = consumer.open();
    h.channel(0).open();
    await opening;
    const old = h.channel(0);
    old.bufferedAmount = 128 * 1024;
    const pending = consumer.request("fs.home").catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(5);
    expect(old.sent).toEqual([]);
    const delayed = old.onmessage;
    h.setState("connecting");
    h.setState("ready");
    expect(old.readyState).toBe("closed");
    expect(h.channels).toHaveLength(2);
    expect(h.channel(1).label).not.toBe(old.label);
    delayed?.({ data: "invalid delayed old frame" });
    h.channel(1).open();
    old.bufferedAmount = 0;
    await jest.advanceTimersByTimeAsync(10);
    expect(consumer.state).toBe("ready");
    expect(old.sent).toEqual([]);
    expect(await pending).toBeInstanceOf(Error);
    expect(h.openSignal).not.toHaveBeenCalled();
  } finally {
    consumer.close();
  }
});

test("parent outage does not consume a fresh tool attachment budget", async () => {
  jest.useFakeTimers();
  const h = harness();
  const consumer = h.create();
  try {
    const opening = consumer.open().catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(20_000);
    h.setState("connecting");
    await jest.advanceTimersByTimeAsync(40_000);
    expect(consumer.state).toBe("connecting");
    h.setState("ready");
    await jest.advanceTimersByTimeAsync(1);
    expect(consumer.state).toBe("connecting");
    h.channel(1).open();
    expect(await opening).toBeUndefined();
    expect(consumer.state).toBe("ready");
  } finally {
    consumer.close();
  }
});

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Send and answer `count` requests, a batch at a time under the 32-pending cap
 * (the worker sends one frame per 4 ms turn, so one at a time would be slow).
 * A replacement channel that is still opening is admitted before each batch.
 */
async function requestRepeatedly(
  h: ReturnType<typeof harness>,
  consumer: HostTransport,
  count: number,
  batch = 25,
): Promise<void> {
  for (let done = 0; done < count; done += batch) {
    const channel = h.channels.at(-1);
    if (!channel) throw new Error("No tool channel");
    if (channel.readyState === "connecting") channel.open(["fs.read", "host.metrics"]);
    const before = channel.requests().length;
    const size = Math.min(batch, count - done);
    const requests = Array.from({ length: size }, () => consumer.request("host.metrics", {}));
    await jest.advanceTimersByTimeAsync(4 * size + 4);
    const sent = channel.requests().slice(before);
    expect(sent).toHaveLength(size);
    for (const frame of sent)
      channel.receive(
        JSON.stringify({ version: 1, type: "response", request_id: frame.request_id, ok: true }),
      );
    await Promise.all(requests);
  }
}

// Thousands of real worker round trips each.
const LONG_TEST_MS = 30_000;

test(
  "a long-lived tool swaps its channel before the daemon's 4,096-id limit, unnoticed",
  async () => {
    jest.useFakeTimers();
    const h = harness();
    const consumer = h.create();
    const states: TransportState[] = [];
    consumer.on("state", (state) => states.push(state));
    try {
      const opening = consumer.open();
      h.channel(0).open(["fs.read", "host.metrics"]);
      await opening;
      await requestRepeatedly(h, consumer, HOST_CONTROL_ROTATE_AFTER_REQUESTS);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.channels).toHaveLength(2);
      expect(h.channel(0).readyState).toBe("closed");
      expect(h.channel(0).requests()).toHaveLength(HOST_CONTROL_ROTATE_AFTER_REQUESTS);
      expect(h.channel(1).label).not.toBe(h.channel(0).label);

      // A request made while the replacement opens waits for it.
      const waiting = consumer.request("host.metrics", {});
      await jest.advanceTimersByTimeAsync(5);
      expect(h.channel(1).sent).toHaveLength(0);
      h.channel(1).open(["fs.read", "host.metrics"]);
      await jest.advanceTimersByTimeAsync(5);
      expect(
        h
          .channel(1)
          .requests()
          .map((frame) => frame.operation),
      ).toEqual(["host.metrics"]);
      h.channel(1).answerLast({ sample: { cpu_percent: 2 } });
      await expect(waiting).resolves.toEqual({ sample: { cpu_percent: 2 } });

      // Past what one channel may carry, and the tool never left ready. (Jest's
      // fake timers also fake queueMicrotask, which defers the swap.)
      await requestRepeatedly(h, consumer, HOST_CONTROL_ROTATE_AFTER_REQUESTS);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.channels).toHaveLength(3);
      for (const channel of h.channels)
        expect(channel.requests().length).toBeLessThanOrEqual(HOST_CONTROL_REQUEST_BUDGET);
      expect(states).toEqual(["connecting", "ready"]);
      expect(consumer.hasCapability("host.metrics")).toBe(true);
      expect(h.openSignal).not.toHaveBeenCalled();
    } finally {
      consumer.close();
    }
  },
  LONG_TEST_MS,
);

test(
  "the swap waits for a read in flight, and past the budget requests wait for it",
  async () => {
    jest.useFakeTimers();
    const h = harness();
    const consumer = h.create();
    try {
      const opening = consumer.open();
      h.channel(0).open(["fs.read", "host.metrics"]);
      await opening;
      await requestRepeatedly(h, consumer, HOST_CONTROL_ROTATE_AFTER_REQUESTS - 1);

      // A read that stays open across the mark: its frames belong to this channel.
      const reading = consumer.readFile("/private/slow.log");
      await jest.advanceTimersByTimeAsync(0);
      h.channel(0).answerLast({
        stream_id: "slow-read",
        path: "/private/slow.log",
        name: "slow.log",
        length: 0,
        sha256: EMPTY_SHA256,
      });
      const read = await reading;
      await jest.advanceTimersByTimeAsync(0);
      expect(h.channels).toHaveLength(1);

      // Under the budget the busy channel keeps carrying requests.
      await requestRepeatedly(
        h,
        consumer,
        HOST_CONTROL_REQUEST_BUDGET - HOST_CONTROL_ROTATE_AFTER_REQUESTS,
      );
      expect(h.channel(0).requests()).toHaveLength(HOST_CONTROL_REQUEST_BUDGET);
      expect(h.channels).toHaveLength(1);

      // At the budget the next request is held, not sent.
      const held = consumer.request("host.metrics", {});
      await jest.advanceTimersByTimeAsync(5);
      expect(h.channel(0).requests()).toHaveLength(HOST_CONTROL_REQUEST_BUDGET);
      expect(h.channels).toHaveLength(1);

      // The read ends; only now is the channel idle and swapped.
      h.channel(0).receive(
        JSON.stringify({
          version: 1,
          type: "stream.end",
          stream_id: "slow-read",
          length: 0,
          sha256: EMPTY_SHA256,
        }),
      );
      const reader = read.stream.getReader();
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      await jest.advanceTimersByTimeAsync(5);
      expect(h.channel(0).readyState).toBe("closed");
      expect(h.channels).toHaveLength(2);
      h.channel(1).open(["fs.read", "host.metrics"]);
      await jest.advanceTimersByTimeAsync(5);
      expect(
        h
          .channel(1)
          .requests()
          .map((frame) => frame.operation),
      ).toEqual(["host.metrics"]);
      h.channel(1).answerLast({ ok: 1 });
      await expect(held).resolves.toEqual({ ok: 1 });
      expect(consumer.state).toBe("ready");
    } finally {
      consumer.close();
    }
  },
  LONG_TEST_MS,
);

test(
  "a replacement channel that is never ready is retired, not left holding requests",
  async () => {
    jest.useFakeTimers();
    const h = harness();
    const consumer = h.create();
    try {
      const opening = consumer.open();
      h.channel(0).open(["fs.read", "host.metrics"]);
      await opening;
      await requestRepeatedly(h, consumer, HOST_CONTROL_ROTATE_AFTER_REQUESTS);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.channels).toHaveLength(2);
      // The held request keeps its own deadline and was never sent, so nothing
      // is cancelled on any channel.
      const held = consumer.request("host.metrics", {}).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
      expect(await held).toMatchObject({ code: "request_timeout" });
      expect(h.channel(1).sent).toHaveLength(0);
      for (const channel of h.channels)
        expect(channel.sent.map((frame) => JSON.parse(frame).type)).not.toContain("cancel");
      // The replacement's own deadline retires it and the tool reconnects.
      expect(consumer.state).toBe("reconnecting");
      await jest.advanceTimersByTimeAsync(1_000);
      expect(h.channels).toHaveLength(3);
      h.channel(2).open(["fs.read", "host.metrics"]);
      await jest.advanceTimersByTimeAsync(0);
      expect(consumer.state).toBe("ready");
    } finally {
      consumer.close();
    }
  },
  LONG_TEST_MS,
);

test("a tool the daemon refuses twice in a row fails with the tool-limit reason", async () => {
  jest.useFakeTimers();
  const h = harness();
  const consumer = h.create();
  try {
    const opening = consumer.open().catch((error: unknown) => error);
    // One refusal can race a channel that is still closing: retry quietly.
    h.channel(0).refuse();
    expect(consumer.state).toBe("reconnecting");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.channels).toHaveLength(2);
    h.channel(1).refuse();
    expect(consumer.state).toBe("failed");
    expect(consumer.lastError).toMatchObject({
      code: HOST_CONSUMER_LIMIT_CODE,
      message: HOST_CONSUMER_LIMIT_MESSAGE,
    });
    expect(HOST_CONSUMER_LIMIT_MESSAGE).toContain("SPAWN D");
    expect(await opening).toMatchObject({ code: HOST_CONSUMER_LIMIT_CODE });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.channels).toHaveLength(2);
    expect(h.parent.state).toBe("ready");
  } finally {
    consumer.close();
  }
});

test("a tool channel that dies before it opens is an ordinary reconnect, never the tool limit", async () => {
  jest.useFakeTimers();
  const h = harness();
  const consumer = h.create();
  try {
    void consumer.open().catch(() => undefined);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.channels.at(-1)?.close();
      expect(consumer.state).toBe("reconnecting");
      expect(consumer.lastError?.code).not.toBe(HOST_CONSUMER_LIMIT_CODE);
      await jest.advanceTimersByTimeAsync(5_000);
    }
    h.channels.at(-1)?.open();
    await jest.advanceTimersByTimeAsync(0);
    expect(consumer.state).toBe("ready");
  } finally {
    consumer.close();
  }
});

test("the worker's own tool limit gives the same reason", async () => {
  const h = harness();
  const consumers = Array.from({ length: 33 }, () => h.create());
  try {
    const openings = consumers.map((consumer) => consumer.open().catch((error: unknown) => error));
    expect(h.channels).toHaveLength(32);
    const last = consumers.at(-1);
    expect(last?.state).toBe("failed");
    expect(last?.lastError).toMatchObject({
      code: HOST_CONSUMER_LIMIT_CODE,
      message: HOST_CONSUMER_LIMIT_MESSAGE,
    });
    expect(await openings.at(-1)).toMatchObject({ code: HOST_CONSUMER_LIMIT_CODE });
  } finally {
    for (const consumer of consumers) consumer.close();
  }
});
