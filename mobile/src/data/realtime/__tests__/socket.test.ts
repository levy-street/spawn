import {
  ReconnectingSocket,
  retireAll,
  SOCKET_TIMING,
  type SocketState,
  subscribeProtocolRequired,
} from "@/data/realtime/socket";

jest.mock("@/data/api/client", () => ({
  ApiError: class extends Error {},
  reportUnauthenticated: jest.fn(async () => undefined),
}));

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

/** Run the fake clock to the next socket and return how long that took. */
async function delayUntilNextSocket(sockets: FakeWebSocket[]): Promise<number> {
  const before = sockets.length;
  const from = Date.now();
  for (let step = 0; step < 20 && sockets.length === before; step += 1) {
    jest.advanceTimersToNextTimer();
    await flushPromises();
  }
  expect(sockets).toHaveLength(before + 1);
  return Date.now() - from;
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
    sockets[0]?.message('{"type":"ping","ts":1}');
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
    sockets[0]?.message('{"type":"ping","ts":1}');

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

  it("does not arm the watchdog until a new server proves ping support", async () => {
    const { socket, sockets } = harness();
    socket.connect();
    await flushPromises();
    sockets[0]?.open();

    jest.advanceTimersByTime(SOCKET_TIMING.watchdogMs * 2);
    expect(socket.state).toBe("open");
    expect(sockets).toHaveLength(1);
  });

  it("reconnects immediately when the server loses its subscription", async () => {
    const { socket, sockets } = harness();
    socket.connect();
    await flushPromises();
    sockets[0]?.serverClose(4010);

    expect(socket.state).toBe("reconnecting");
    jest.advanceTimersByTime(0);
    await flushPromises();
    expect(sockets).toHaveLength(2);
  });

  it("uses exponential jitter and resets its attempt only once a socket proves useful", async () => {
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

    // Opening proves nothing; the server's keepalive does (the default).
    sockets[2]?.open();
    expect(socket.reconnectAttempt).toBe(2);
    sockets[2]?.message('{"type":"ping","ts":1}');
    expect(socket.reconnectAttempt).toBe(0);
    sockets[2]?.serverClose();
    expect(socket.reconnectAttempt).toBe(1);
  });

  it("keeps backing off, up to its cap, while sockets open and then end", async () => {
    const { socket, sockets } = harness(0.5);
    socket.connect();
    await flushPromises();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      sockets.at(-1)?.open();
      sockets.at(-1)?.message('{"type":"rtc.config"}');
      sockets.at(-1)?.serverClose(1011);
      delays.push(await delayUntilNextSocket(sockets));
    }
    const ceilings = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000];
    for (const [attempt, delay] of delays.entries()) {
      const ceiling = ceilings[attempt] ?? 0;
      expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling * SOCKET_TIMING.jitterMin) - 1);
      expect(delay).toBeLessThanOrEqual(Math.ceil(ceiling * SOCKET_TIMING.jitterMax));
      expect(Math.abs(delay - ceiling)).toBeLessThanOrEqual(1);
    }
    socket.close();
  });

  it("restarts the backoff on the frame its caller names, and on nothing else", async () => {
    const sockets: FakeWebSocket[] = [];
    const socket = new ReconnectingSocket({
      url: () => "wss://spawn.test/ws",
      protocol: "spawn.test.v1",
      random: () => 0.5,
      provesUseful: (frame) => frame["type"] === "rtc.status" && frame["status"] === "resumed",
      createWebSocket: (url, protocol) => {
        const fake = new FakeWebSocket(url, protocol);
        sockets.push(fake);
        return fake as unknown as WebSocket;
      },
    });
    socket.connect();
    await flushPromises();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      sockets.at(-1)?.serverClose();
      await delayUntilNextSocket(sockets);
    }
    sockets.at(-1)?.open();
    sockets.at(-1)?.message('{"type":"ping","ts":1}');
    sockets.at(-1)?.message('{"type":"error","code":"invalid_frame"}');
    sockets.at(-1)?.message('{"type":"rtc.status","status":"unavailable"}');
    expect(socket.reconnectAttempt).toBe(3);
    sockets.at(-1)?.message('{"type":"rtc.status","status":"resumed"}');
    expect(socket.reconnectAttempt).toBe(0);
    sockets.at(-1)?.serverClose();
    expect(await delayUntilNextSocket(sockets)).toBe(SOCKET_TIMING.reconnectBaseMs);
    socket.close();
  });

  it("reopens at once after one 4010, and backs off after a second in a row", async () => {
    const { socket, sockets } = harness(0.5);
    socket.connect();
    await flushPromises();
    sockets[0]?.open();
    sockets[0]?.serverClose(4010);
    await flushPromises();
    expect(sockets).toHaveLength(2);

    sockets[1]?.open();
    sockets[1]?.serverClose(4010);
    await flushPromises();
    expect(sockets).toHaveLength(2);
    expect(await delayUntilNextSocket(sockets)).toBe(SOCKET_TIMING.reconnectBaseMs);
    sockets[2]?.serverClose(4010);
    expect(await delayUntilNextSocket(sockets)).toBe(SOCKET_TIMING.reconnectBaseMs * 2);

    // A socket that proved useful in between earns the next 4010 its reopen.
    sockets[3]?.open();
    sockets[3]?.message('{"type":"ping","ts":1}');
    sockets[3]?.serverClose(4010);
    await flushPromises();
    expect(sockets).toHaveLength(5);
    socket.close();
  });

  it("still opens at once when its owner reconnects it, without restarting the backoff", async () => {
    const { socket, sockets } = harness(0.5);
    socket.connect();
    await flushPromises();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      sockets.at(-1)?.serverClose();
      await delayUntilNextSocket(sockets);
    }
    sockets.at(-1)?.serverClose();
    expect(socket.state).toBe("reconnecting");
    socket.hardReconnect();
    await flushPromises();
    expect(sockets).toHaveLength(5);

    socket.retire();
    socket.connect();
    await flushPromises();
    expect(sockets).toHaveLength(6);
    // Four failures so far: the fifth waits 16 s, capped at 15.
    sockets[5]?.serverClose();
    expect(await delayUntilNextSocket(sockets)).toBe(SOCKET_TIMING.reconnectCapMs);
    socket.close();
  });

  it("backs off a refused handshake (error, then close) as before", async () => {
    const { socket, sockets } = harness(0.5);
    socket.connect();
    await flushPromises();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      sockets
        .at(-1)
        ?.onerror?.call(
          sockets.at(-1) as unknown as WebSocket,
          {} as Parameters<NonNullable<WebSocket["onerror"]>>[0],
        );
      sockets.at(-1)?.serverClose(1006);
      expect(await delayUntilNextSocket(sockets)).toBe(
        SOCKET_TIMING.reconnectBaseMs * 2 ** attempt,
      );
    }
    socket.close();
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

  it.each([1002, 1009, 4002, 4003])("does not retry permanent close code %i", async (code) => {
    const { socket, sockets } = harness();
    socket.connect();
    await flushPromises();
    sockets[0]?.serverClose(code);
    expect(socket.state).toBe("failed");
    jest.runAllTimers();
    expect(sockets).toHaveLength(1);
  });

  it("reports an authentication refusal without reconnecting", async () => {
    const { socket, sockets } = harness();
    socket.connect();
    await flushPromises();
    sockets[0]?.serverClose(1008);
    expect(socket.state).toBe("unauthenticated");
    jest.runAllTimers();
    expect(sockets).toHaveLength(1);
  });

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
