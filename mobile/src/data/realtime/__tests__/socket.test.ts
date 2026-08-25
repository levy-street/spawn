import {
  ReconnectingSocket,
  retireAll,
  SOCKET_TIMING,
  type SocketState,
  subscribeProtocolRequired,
} from "@/data/realtime/socket";

class FakeWebSocket {
  readonly url: string;
  readonly protocol: string;
  readyState = 0;
  sent: string[] = [];
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.call(
      this as unknown as WebSocket,
      {} as Parameters<NonNullable<WebSocket["onopen"]>>[0],
    );
  }

  message(data: unknown): void {
    this.onmessage?.call(
      this as unknown as WebSocket,
      { data } as Parameters<NonNullable<WebSocket["onmessage"]>>[0],
    );
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.call(
      this as unknown as WebSocket,
      { code } as Parameters<NonNullable<WebSocket["onclose"]>>[0],
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.serverClose(code);
  }
}

function harness(random = 0.5) {
  const sockets: FakeWebSocket[] = [];
  const socket = new ReconnectingSocket<{ type: string }>({
    url: () => "wss://spawn.test/ws",
    protocol: "spawn.test.v1",
    random: () => random,
    createWebSocket: (url, protocol) => {
      const fake = new FakeWebSocket(url, protocol);
      sockets.push(fake);
      return fake as unknown as WebSocket;
    },
  });
  return { socket, sockets };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ReconnectingSocket", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("moves through connect, open, and intentional close states", async () => {
    const { socket, sockets } = harness();
    const states: SocketState[] = [];
    socket.subscribe((state) => states.push(state));

    socket.connect();
    await flushPromises();
    expect(socket.state).toBe("connecting");
    expect(sockets).toHaveLength(1);

    sockets[0]?.open();
    expect(socket.state).toBe("open");
    socket.send({ type: "hello" });
    expect(sockets[0]?.sent).toEqual(['{"type":"hello"}']);

    socket.retire();
    expect(socket.state).toBe("closed");
    expect(states).toEqual(["connecting", "open", "closed"]);
    jest.advanceTimersByTime(SOCKET_TIMING.reconnectCapMs * 2);
    expect(sockets).toHaveLength(1);
  });

  it("fires the watchdog after 80 seconds of silence and reconnects", async () => {
    const { socket, sockets } = harness();
    socket.connect();
    await flushPromises();
    sockets[0]?.open();

    jest.advanceTimersByTime(SOCKET_TIMING.watchdogMs - 1);
    expect(socket.state).toBe("open");
    jest.advanceTimersByTime(1);
    expect(socket.state).toBe("reconnecting");

    jest.advanceTimersByTime(SOCKET_TIMING.reconnectBaseMs);
    await flushPromises();
    expect(sockets).toHaveLength(2);
  });

  it("rearms the watchdog on every server frame", async () => {
    const { socket, sockets } = harness();
    socket.connect();
    await flushPromises();
    sockets[0]?.open();

    jest.advanceTimersByTime(60_000);
    sockets[0]?.message('{"type":"alerts.ping"}');
    jest.advanceTimersByTime(60_000);
    expect(socket.state).toBe("open");
    jest.advanceTimersByTime(20_000);
    expect(socket.state).toBe("reconnecting");
  });

  it("uses exponential jitter and resets its attempt after a successful open", async () => {
    const { socket, sockets } = harness(0);
    socket.connect();
    await flushPromises();
    sockets[0]?.serverClose();
    expect(socket.reconnectAttempt).toBe(1);

    jest.advanceTimersByTime(699);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(sockets).toHaveLength(2);

    sockets[1]?.serverClose();
    jest.advanceTimersByTime(1_399);
    expect(sockets).toHaveLength(2);
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(sockets).toHaveLength(3);

    sockets[2]?.open();
    expect(socket.reconnectAttempt).toBe(0);
    sockets[2]?.serverClose();
    expect(socket.reconnectAttempt).toBe(1);
  });

  it("discards callbacks from retired generations", async () => {
    const { socket, sockets } = harness();
    const frames: unknown[] = [];
    socket.onMessage((frame) => frames.push(frame));

    socket.connect();
    await flushPromises();
    const first = sockets[0];
    first?.open();
    socket.hardReconnect();
    await flushPromises();
    sockets[1]?.open();

    first?.message("stale");
    sockets[1]?.message("current");
    expect(frames).toEqual(["current"]);
  });

  it("retires every registered socket at a lifecycle boundary", async () => {
    const first = harness().socket;
    const second = harness().socket;
    first.connect();
    second.connect();
    await flushPromises();

    retireAll();
    expect(first.state).toBe("closed");
    expect(second.state).toBe("closed");
  });

  it("fails closed when the server selects the wrong subprotocol", async () => {
    const sockets: FakeWebSocket[] = [];
    const socket = new ReconnectingSocket({
      url: () => "wss://spawn.test/ws",
      protocol: "spawn.required.v1",
      createWebSocket: (url) => {
        const fake = new FakeWebSocket(url, "spawn.wrong.v1");
        sockets.push(fake);
        return fake as unknown as WebSocket;
      },
    });
    socket.connect();
    await flushPromises();
    sockets[0]?.open();
    expect(socket.state).toBe("failed");
  });

  it.each([1002, 1008, 1009, 4002, 4003])(
    "does not retry permanent close code %i",
    async (code) => {
      const { socket, sockets } = harness();
      socket.connect();
      await flushPromises();
      sockets[0]?.serverClose(code);
      expect(socket.state).toBe("failed");
      jest.runAllTimers();
      expect(sockets).toHaveLength(1);
    },
  );

  it("surfaces a 4003 protocol refusal while keeping it permanent", async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeProtocolRequired(listener);
    const { socket, sockets } = harness();
    socket.connect();
    await flushPromises();

    sockets[0]?.serverClose(4003);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(socket.state).toBe("failed");

    unsubscribe();
    const second = harness();
    second.socket.connect();
    await flushPromises();
    second.sockets[0]?.serverClose(4003);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
