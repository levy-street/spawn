import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

/**
 * One bulk gate per connection (proto/README.md, "Bulk pacing"; spike S4):
 * a stream's chunk goes out on a tool channel only while the bytes buffered
 * on every tool channel that has carried bulk sum to at most 64 KiB, whatever
 * each one holds alone. Control frames are not bulk and are not held by it.
 */

class Channel extends EventTarget {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  constructor(readonly label: string) {
    super();
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
    this.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: "hello",
        protocol: "spawn.host.ctl",
        capabilities: ["conv.v2"],
      }),
    });
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

function worker() {
  const channels: Channel[] = [];
  const posted: Array<Record<string, unknown>> = [];
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
    post: (message: Record<string, unknown>) => posted.push(message),
    decodeBase64: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
    handleHostConsumerMessage: (_message: unknown): boolean => false,
    closeHostConsumers: () => {},
  };
  for (const marker of ["function createHostProtocol(api)", "const consumers = new Map();"])
    new Function("globalThis", runtimeSource(marker))({ spawnWorker: api });
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ] as const;
  for (const consumerId of ids) {
    api.handleHostConsumerMessage({ type: "host-consumer-open", consumerId });
  }
  for (const channel of channels) channel.open();
  const command = (consumerId: string, operation: string, payload: unknown) =>
    api.handleHostConsumerMessage({
      type: "host-consumer-command",
      consumerId,
      command: {
        type: "host-request",
        requestId: `${operation}-${posted.length}`,
        operation,
        payload,
      },
    });
  return { api, channels, ids, posted, command };
}

const CHUNK = Buffer.alloc(8192, 7).toString("base64");

describe("the connection's bulk gate", () => {
  afterEach(() => jest.useRealTimers());

  it("holds a chunk while the bulk channels together hold more than 64 KiB", async () => {
    jest.useFakeTimers();
    const { channels, ids, command } = worker();
    const [first, second] = channels as [Channel, Channel];
    // The first channel has carried bulk and still holds 40 KiB of it.
    command(ids[0], "$host.stream.chunk", { stream_id: "a", sequence: 0, bytes_b64: CHUNK });
    await jest.advanceTimersByTimeAsync(5);
    expect(first.sent).toHaveLength(1);
    first.bufferedAmount = 40 * 1024;
    second.bufferedAmount = 30 * 1024;
    command(ids[1], "$host.stream.chunk", { stream_id: "b", sequence: 0, bytes_b64: CHUNK });
    await jest.advanceTimersByTimeAsync(20);
    // 40 + 30 KiB is over the watermark although each is under it alone.
    expect(second.sent).toHaveLength(0);
    // A control frame is not bulk: it goes out on a channel under 32 KiB.
    command(ids[0], "conv.import.status", { transfer_id: "x" });
    first.bufferedAmount = 20 * 1024;
    await jest.advanceTimersByTimeAsync(20);
    expect(first.sent.map((frame) => frame["type"])).toEqual(["stream.chunk", "request"]);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]).toMatchObject({ type: "stream.chunk", stream_id: "b" });
  });

  it("lets one stream alone fill the watermark", async () => {
    jest.useFakeTimers();
    const { channels, ids, command } = worker();
    const first = channels[0] as Channel;
    command(ids[0], "$host.stream.chunk", { stream_id: "a", sequence: 0, bytes_b64: CHUNK });
    await jest.advanceTimersByTimeAsync(5);
    first.bufferedAmount = 48 * 1024;
    command(ids[0], "$host.stream.chunk", { stream_id: "a", sequence: 1, bytes_b64: CHUNK });
    await jest.advanceTimersByTimeAsync(10);
    // Past the old 32 KiB per channel, under the connection's 64 KiB.
    expect(first.sent).toHaveLength(2);
    first.bufferedAmount = 64 * 1024 + 1;
    command(ids[0], "$host.stream.chunk", { stream_id: "a", sequence: 2, bytes_b64: CHUNK });
    await jest.advanceTimersByTimeAsync(10);
    expect(first.sent).toHaveLength(2);
  });
});

describe("a tool channel's readiness", () => {
  it("sends nothing on a hello that arrives before the channel is open (S4 F2)", () => {
    const channels: Channel[] = [];
    const posted: Array<Record<string, unknown>> = [];
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
      post: (message: Record<string, unknown>) => posted.push(message),
      decodeBase64: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
      handleHostConsumerMessage: (_message: unknown): boolean => false,
      closeHostConsumers: () => {},
    };
    for (const marker of ["function createHostProtocol(api)", "const consumers = new Map();"])
      new Function("globalThis", runtimeSource(marker))({ spawnWorker: api });
    api.handleHostConsumerMessage({
      type: "host-consumer-open",
      consumerId: "33333333-3333-4333-8333-333333333333",
    });
    const channel = channels[0] as Channel;
    // Chrome 148 delivered the hello 0.5 ms before `open`.
    channel.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: "hello",
        protocol: "spawn.host.ctl",
        capabilities: [],
      }),
    });
    const ready = () =>
      posted.some(
        (event) =>
          event["type"] === "host-consumer-event" &&
          (event["message"] as { type?: string; state?: string })?.state === "ready",
      );
    expect(ready()).toBe(false);
    channel.readyState = "open";
    channel.onopen?.();
    expect(ready()).toBe(true);
  });
});
