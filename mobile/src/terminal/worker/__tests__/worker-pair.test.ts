import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

type Frame = {
  type: string;
  attachmentId?: string;
  channel?: string;
  event?: string;
  data?: string;
  binary?: boolean;
  sequence?: number;
  [key: string]: unknown;
};
class Channel {
  readyState = "connecting";
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly label: string) {}
  send(value: unknown) {
    this.sent.push(value);
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
}
interface ViewChannel {
  send(value: string | Uint8Array): void;
  close(): void;
  readyState: string;
  bufferedAmount: number;
}
interface Harness {
  state: {
    mode: string;
    pc?: { connectionState: string; createDataChannel(label: string): Channel };
    ctl?: ViewChannel | { readyState: string };
    pty?: ViewChannel;
  };
  post(frame: Frame): void;
  resetSessionGeneration: jest.Mock;
  sessionGate: jest.Mock;
  sessionChannelOpened: jest.Mock;
  receivePty: jest.Mock;
  receiveSessionCtl: jest.Mock;
  bytesFromMessage(value: unknown): Promise<Uint8Array>;
  decodeBase64(value: string): Uint8Array;
  encodeBase64(value: Uint8Array): string;
  handlePairMessage?: (frame: Frame) => boolean;
  closePairChannels?: () => void;
}
const marker = TERMINAL_WORKER_HTML.indexOf("const MAX_RECEIVE = 2 * 1024 * 1024");
const source = TERMINAL_WORKER_HTML.slice(
  TERMINAL_WORKER_HTML.lastIndexOf("(() => {", marker),
  TERMINAL_WORKER_HTML.indexOf("\n})();", marker) + "\n})();".length,
);
const sessionId = "11111111-2222-4333-8444-555555555555";
const viewId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const c = "00000000-0000-4000-8000-000000000003";
function load(mode: string, post: (frame: Frame) => void): Harness {
  const api: Harness = {
    state: { mode },
    post,
    resetSessionGeneration: jest.fn(),
    sessionGate: jest.fn(),
    sessionChannelOpened: jest.fn(),
    receivePty: jest.fn(),
    receiveSessionCtl: jest.fn(),
    bytesFromMessage: async (value) => new Uint8Array(value as ArrayBuffer),
    decodeBase64: (value) => new Uint8Array(Buffer.from(value, "base64")),
    encodeBase64: (value) => Buffer.from(value).toString("base64"),
  };
  new Function("globalThis", source)({ spawnWorker: api });
  return api;
}
async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

test("two terminal workers share one peer; retiring one attachment leaves the other usable", async () => {
  jest.useFakeTimers();
  const views = new Map<string, Harness>();
  const channels: Channel[] = [];
  const owner = load("host", (frame) =>
    views.get(frame.attachmentId ?? "")?.handlePairMessage?.(frame),
  );
  owner.state.pc = {
    connectionState: "connected",
    createDataChannel(label) {
      const dc = new Channel(label);
      channels.push(dc);
      return dc;
    },
  };
  owner.state.ctl = { readyState: "open" };
  function attach(id: string) {
    const view = load("session", (frame) => owner.handlePairMessage?.(frame));
    views.set(id, view);
    view.handlePairMessage?.({ type: "pair-view", attachmentId: id, sessionId, viewId });
    owner.handlePairMessage?.({ type: "pair-attach", attachmentId: id, sessionId, viewId });
    return view;
  }
  try {
    const first = attach(a),
      second = attach(b);
    expect(channels).toHaveLength(4);
    expect(channels.map((dc) => dc.label)).toEqual([
      `spawn.pty/${sessionId}/${viewId}/${a}`,
      `spawn.ctl/${sessionId}/${viewId}/${a}`,
      `spawn.pty/${sessionId}/${viewId}/${b}`,
      `spawn.ctl/${sessionId}/${viewId}/${b}`,
    ]);
    for (const dc of channels) dc.open();
    first.state.pty?.send(Uint8Array.of(1));
    second.state.pty?.send(Uint8Array.of(2));
    jest.advanceTimersByTime(10);
    expect(channels[0]?.sent).toEqual([Uint8Array.of(1)]);
    expect(channels[2]?.sent).toEqual([Uint8Array.of(2)]);
    expect(second.state.pty?.bufferedAmount).toBe(0);
    channels[2]?.onmessage?.({ data: Uint8Array.of(9).buffer });
    await settle();
    expect(second.receivePty).toHaveBeenCalled();
    first.closePairChannels?.();
    expect(channels[0]?.readyState).toBe("closed");
    expect(channels[2]?.readyState).toBe("open");
    second.state.pty?.send(Uint8Array.of(3));
    jest.advanceTimersByTime(10);
    expect(channels[2]?.sent).toHaveLength(2);

    // The replacement view ignores delivery addressed to its retired attachment.
    second.handlePairMessage?.({ type: "pair-view", attachmentId: c, sessionId, viewId });
    const received = second.receivePty.mock.calls.length;
    second.handlePairMessage?.({
      type: "pair-event",
      attachmentId: b,
      channel: "pty",
      event: "data",
      data: "late",
      binary: false,
    });
    expect(second.receivePty).toHaveBeenCalledTimes(received);
  } finally {
    owner.closePairChannels?.();
    for (const view of views.values()) view.closePairChannels?.();
    jest.useRealTimers();
  }
});

test("malformed attachment labels never create a peer channel", () => {
  const post = jest.fn();
  const owner = load("host", post);
  const createDataChannel = jest.fn((label: string) => new Channel(label));
  owner.state.pc = { connectionState: "connected", createDataChannel };
  owner.state.ctl = { readyState: "open" };
  owner.handlePairMessage?.({
    type: "pair-attach",
    attachmentId: a,
    sessionId: "../elsewhere",
    viewId,
  });
  expect(createDataChannel).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ event: "close" }));
  owner.closePairChannels?.();
});

test("pending asynchronous receive decoding is bounded and cannot deliver after retirement", async () => {
  const post = jest.fn();
  const owner = load("host", post);
  const channels: Channel[] = [];
  owner.state.pc = {
    connectionState: "connected",
    createDataChannel(label) {
      const channel = new Channel(label);
      channels.push(channel);
      return channel;
    },
  };
  owner.state.ctl = { readyState: "open" };
  let finishDecode!: (bytes: Uint8Array) => void;
  const decode = jest.fn(
    () =>
      new Promise<Uint8Array>((resolve) => {
        finishDecode = resolve;
      }),
  );
  owner.bytesFromMessage = decode;
  owner.handlePairMessage?.({ type: "pair-attach", attachmentId: a, sessionId, viewId });
  for (const channel of channels) channel.open();
  const receive = channels[0]?.onmessage;
  receive?.({ data: { size: 64 * 1024 } });
  await settle();
  expect(decode).toHaveBeenCalledTimes(1);
  // The first decode is unresolved. Subsequent frames still consume credit.
  for (let index = 0; index < 32; index++) receive?.({ data: { size: 64 * 1024 } });
  expect(channels.every((channel) => channel.readyState === "closed")).toBe(true);
  finishDecode(new Uint8Array(64 * 1024));
  await settle();
  expect(post.mock.calls.some(([frame]: [Frame]) => frame.event === "data")).toBe(false);
  expect(decode).toHaveBeenCalledTimes(1);
  owner.closePairChannels?.();
});
