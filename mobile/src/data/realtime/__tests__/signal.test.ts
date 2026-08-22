import { openHostSignal } from "@/data/realtime/host-signal";
import { openSessionSignal } from "@/data/realtime/session-signal";
import { useConnectionStore } from "@/data/stores/connection";
import { useSessionUiStore } from "@/data/stores/session-ui";

jest.mock("@/data/api/socket-urls", () => ({
  buildBrowserSocketUrl: jest.fn(
    async (sessionId: string) => `wss://spawn.test/ws/browser?session_id=${sessionId}&token=secret`,
  ),
  buildHostSocketUrl: jest.fn(
    async (hostId: string) => `wss://spawn.test/ws/host?host_id=${hostId}&token=secret`,
  ),
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

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
    FakeWebSocket.instances.push(this);
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

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.call(
      this as unknown as WebSocket,
      { code } as Parameters<NonNullable<WebSocket["onclose"]>>[0],
    );
  }
}

const OriginalWebSocket = globalThis.WebSocket;

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("signalling relays", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    useConnectionStore.getState().reset();
    useSessionUiStore.getState().clear();
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("opens the session endpoint with spawn.v3 and relays opaque frames both ways", async () => {
    const channel = openSessionSignal("session-1");
    const frames: unknown[] = [];
    channel.onFrame((frame) => frames.push(frame));
    await flushPromises();

    const socket = FakeWebSocket.instances[0];
    expect(socket).toMatchObject({
      url: "wss://spawn.test/ws/browser?session_id=session-1&token=secret",
      protocol: "spawn.v3",
    });
    socket?.open();
    socket?.message('{"type":"rtc.answer","sdp":"opaque"}');
    channel.send({ type: "rtc.offer", sdp: "opaque" });

    expect(frames).toEqual([{ type: "rtc.answer", sdp: "opaque" }]);
    expect(socket?.sent).toEqual(['{"type":"rtc.offer","sdp":"opaque"}']);
    expect(channel.state).toBe("open");
    channel.close();
  });

  it("opens the host endpoint with spawn.host.v1", async () => {
    const channel = openHostSignal("host-1");
    await flushPromises();
    expect(FakeWebSocket.instances[0]).toMatchObject({
      url: "wss://spawn.test/ws/host?host_id=host-1&token=secret",
      protocol: "spawn.host.v1",
    });
    channel.close();
  });

  it("treats binary signalling as a protocol failure", async () => {
    const channel = openSessionSignal("session-1");
    await flushPromises();
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.message(new ArrayBuffer(1));
    expect(channel.state).toBe("failed");
    channel.close();
  });

  it("cleans transport-local session state on exit", async () => {
    useSessionUiStore.getState().setLastKnownTitle("session-1", "Build");
    useConnectionStore.getState().setSessionTransport("session-1", "ready");
    const channel = openSessionSignal("session-1");
    await flushPromises();
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.message('{"type":"session.exit","exit_code":0,"signal":null}');

    expect(useSessionUiStore.getState().sessions["session-1"]).toBeUndefined();
    expect(useConnectionStore.getState().sessionTransports["session-1"]).toBe("closed");
    channel.close();
  });
});
