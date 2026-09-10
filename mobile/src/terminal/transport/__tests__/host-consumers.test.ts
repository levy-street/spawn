import { WorkerBridge } from "@/terminal/transport/bridge";
import { createHostConsumerTransport } from "@/terminal/transport/host-transport";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
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
  open() {
    this.readyState = "open";
    this.onopen?.();
    this.receive(
      JSON.stringify({
        version: 1,
        type: "hello",
        protocol: "spawn.host.ctl",
        capabilities: ["fs.home", "session.transport.v1"],
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
