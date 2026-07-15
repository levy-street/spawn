// @ts-nocheck -- focused browser API fakes; production code remains fully type-checked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HOST_CONTROL_PROTOCOL, HostControlClient } from "./hostControl";

class FakeDataChannel {
  label: string;
  readyState = "open";
  sent: string[] = [];
  closed = false;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  throwOnCancel = false;

  constructor(label: string) {
    this.label = label;
  }

  send(value: string) {
    if (this.throwOnCancel && JSON.parse(value).type === "cancel") {
      throw new Error("channel closed during cancellation");
    }
    this.sent.push(value);
  }

  close() {
    this.closed = true;
  }

  receive(value: string) {
    this.onmessage?.({ data: value });
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "connected";
  remoteDescription = null;
  onicecandidate = null;
  onconnectionstatechange = null;
  channel = null;
  config;

  constructor(config) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string) {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }

  async createOffer() {
    return { type: "offer", sdp: "v=0\r\n" };
  }

  async setLocalDescription() {}

  async setRemoteDescription(value) {
    this.remoteDescription = value;
  }

  async addIceCandidate() {}

  close() {}
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  protocol = "spawn.host.v1";
  sent: string[] = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(
    readonly url: string,
    readonly subprotocol: string,
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
  }

  receive(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  receiveRaw(value: string) {
    this.onmessage?.({ data: value });
  }
}

const hostId = "00000000-0000-4000-8000-000000000001";
const metadata = {
  scope_type: "host",
  scope_id: hostId,
  protocol: HOST_CONTROL_PROTOCOL,
  protocol_version: 1,
};

async function readyClient(options = {}) {
  const client = new HostControlClient(hostId, options);
  client.connect();
  const ws = FakeWebSocket.instances.at(-1);
  ws.onopen?.();
  ws.receive({
    type: "rtc.config",
    enabled: true,
    ice_servers: [{ urls: ["turn:relay.example"] }],
    ice_transport_policy: "relay",
    ...metadata,
  });
  await Promise.resolve();
  await Promise.resolve();
  const pc = FakePeerConnection.instances.at(-1);
  const offer = JSON.parse(ws.sent.at(-1));
  pc.channel.onopen?.();
  pc.channel.receive(
    JSON.stringify({
      version: 1,
      type: "hello",
      protocol: HOST_CONTROL_PROTOCOL,
      capabilities: ["ping"],
    }),
  );
  return { client, ws, pc, offer };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.RTCPeerConnection = FakePeerConnection;
});

afterEach(() => {
  for (const ws of FakeWebSocket.instances) ws.onclose = null;
});

describe("HostControlClient", () => {
  test("creates a host-bound TURN-only channel and completes a bound ping", async () => {
    const { client, pc, offer } = await readyClient();
    expect(pc.channel.label).toBe(HOST_CONTROL_PROTOCOL);
    expect(pc.config.iceTransportPolicy).toBe("relay");
    expect(offer).toMatchObject({ type: "rtc.offer", ...metadata });
    expect(client.getState()).toBe("ready");

    const ping = client.ping();
    const request = JSON.parse(pc.channel.sent.at(-1));
    expect(request.operation).toBe("ping");
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: { pong: true },
      }),
    );
    await expect(ping).resolves.toEqual({ pong: true });
    client.close();
  });

  test("times out with a cancellation frame and rejects malformed replies", async () => {
    const first = await readyClient();
    const timedOut = first.client.ping({ timeoutMs: 1 });
    const timedOutAssertion = expect(timedOut).rejects.toThrow("timed out");
    await Bun.sleep(5);
    await timedOutAssertion;
    expect(JSON.parse(first.pc.channel.sent.at(-1)).type).toBe("cancel");

    const abort = new AbortController();
    const aborted = first.client.ping({ signal: abort.signal });
    const abortedError = aborted.catch((error) => error);
    abort.abort();
    expect((await abortedError).name).toBe("AbortError");
    expect(JSON.parse(first.pc.channel.sent.at(-1)).type).toBe("cancel");
    first.client.close();

    const second = await readyClient();
    second.pc.channel.receive("not json");
    expect(second.pc.channel.closed).toBe(true);
    expect(second.client.getState()).not.toBe("ready");
    second.client.close();
  });

  test("ignores signaling metadata for another host", async () => {
    const client = new HostControlClient(hostId);
    client.connect();
    const ws = FakeWebSocket.instances.at(-1);
    ws.onopen?.();
    ws.receive({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      ice_transport_policy: "all",
      ...metadata,
      scope_id: "00000000-0000-4000-8000-000000000002",
    });
    await Promise.resolve();
    expect(FakePeerConnection.instances).toHaveLength(0);
    client.close();
  });

  test("times out before an answer or hello and reconnects exactly once", async () => {
    const client = new HostControlClient(hostId, {
      connectTimeoutMs: 5,
      reconnectBaseDelayMs: 1,
    });
    client.connect();
    const ws = FakeWebSocket.instances.at(-1);
    ws.onopen?.();
    ws.receive({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      ice_transport_policy: "all",
      ...metadata,
    });
    await Bun.sleep(8);

    expect(FakePeerConnection.instances[0].channel.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(JSON.parse(ws.sent.at(-1)).type).toBe("rtc.close");
    client.close();

    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const noHelloClient = new HostControlClient(hostId, {
      connectTimeoutMs: 5,
      reconnectBaseDelayMs: 1,
    });
    noHelloClient.connect();
    const noHelloWs = FakeWebSocket.instances.at(-1);
    noHelloWs.onopen?.();
    noHelloWs.receive({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      ice_transport_policy: "all",
      ...metadata,
    });
    await Promise.resolve();
    await Promise.resolve();
    const noHelloPc = FakePeerConnection.instances.at(-1);
    const noHelloOffer = JSON.parse(noHelloWs.sent.at(-1));
    noHelloWs.receive({
      type: "rtc.answer",
      session_id: noHelloOffer.session_id,
      sdp: "v=0\r\nanswer",
      ...metadata,
    });
    noHelloPc.channel.onopen?.();
    await Bun.sleep(8);
    expect(noHelloPc.channel.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    noHelloClient.close();
  });

  test("attempt deadline covers a websocket that never opens or never receives config", async () => {
    const neverOpen = new HostControlClient(hostId, {
      connectTimeoutMs: 5,
      reconnectBaseDelayMs: 1,
    });
    neverOpen.connect();
    await Bun.sleep(8);
    expect(FakeWebSocket.instances).toHaveLength(2);
    neverOpen.close();

    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const noConfig = new HostControlClient(hostId, {
      connectTimeoutMs: 5,
      reconnectBaseDelayMs: 1,
    });
    noConfig.connect();
    FakeWebSocket.instances[0].onopen?.();
    await Bun.sleep(8);
    expect(FakeWebSocket.instances).toHaveLength(2);
    noConfig.close();
  });

  test("null and primitive signaling or control JSON close and reconnect cleanly", async () => {
    for (const value of [null, 7, "primitive"]) {
      FakeWebSocket.instances = [];
      FakePeerConnection.instances = [];
      const signaling = await readyClient({ reconnectBaseDelayMs: 1 });
      signaling.ws.receive(value);
      await Bun.sleep(5);
      expect(signaling.pc.channel.closed).toBe(true);
      expect(FakeWebSocket.instances).toHaveLength(2);
      signaling.client.close();
    }

    for (const raw of ["null", "7", JSON.stringify("primitive")]) {
      FakeWebSocket.instances = [];
      FakePeerConnection.instances = [];
      const control = await readyClient({ reconnectBaseDelayMs: 1 });
      control.pc.channel.receive(raw);
      await Bun.sleep(5);
      expect(control.pc.channel.closed).toBe(true);
      expect(FakeWebSocket.instances).toHaveLength(2);
      control.client.close();
    }
  });

  test("repeated unavailable attempts increase backoff until a valid hello", async () => {
    const client = new HostControlClient(hostId, {
      connectTimeoutMs: 1000,
      reconnectBaseDelayMs: 20,
    });
    client.connect();
    const firstWs = FakeWebSocket.instances[0];
    firstWs.onopen?.();
    firstWs.receive({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      ice_transport_policy: "all",
      ...metadata,
    });
    await Promise.resolve();
    await Promise.resolve();
    const firstOffer = JSON.parse(firstWs.sent.at(-1));
    firstWs.receive({
      type: "rtc.status",
      session_id: firstOffer.session_id,
      status: "unavailable",
      ...metadata,
    });
    await Bun.sleep(25);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const secondWs = FakeWebSocket.instances[1];
    secondWs.onopen?.();
    secondWs.receive({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      ice_transport_policy: "all",
      ...metadata,
    });
    await Promise.resolve();
    await Promise.resolve();
    const secondOffer = JSON.parse(secondWs.sent.at(-1));
    secondWs.receive({
      type: "rtc.status",
      session_id: secondOffer.session_id,
      status: "unavailable",
      ...metadata,
    });
    await Bun.sleep(25);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await Bun.sleep(25);
    expect(FakeWebSocket.instances).toHaveLength(3);
    client.close();
  });

  test("channel, daemon, and browser loss each schedule only one reconnect", async () => {
    const first = await readyClient({ reconnectBaseDelayMs: 1 });
    const closeHandler = first.pc.channel.onclose;
    closeHandler?.();
    closeHandler?.();
    await Bun.sleep(5);
    expect(FakeWebSocket.instances).toHaveLength(2);
    first.client.close();

    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const second = await readyClient({ reconnectBaseDelayMs: 1 });
    second.ws.receive({
      type: "rtc.status",
      session_id: second.offer.session_id,
      status: "unavailable",
      ...metadata,
    });
    second.ws.receive({
      type: "rtc.status",
      session_id: second.offer.session_id,
      status: "failed",
      ...metadata,
    });
    await Bun.sleep(5);
    expect(FakeWebSocket.instances).toHaveLength(2);
    second.client.close();

    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const third = await readyClient({ reconnectBaseDelayMs: 1 });
    const wsCloseHandler = third.ws.onclose;
    wsCloseHandler?.();
    wsCloseHandler?.();
    await Bun.sleep(5);
    expect(FakeWebSocket.instances).toHaveLength(2);
    third.client.close();
  });

  test("bounds pending requests and ignores a response with the wrong request id", async () => {
    const { client, pc } = await readyClient({ maxPendingRequests: 2, requestTimeoutMs: 1000 });
    const first = client.ping();
    const firstRequest = JSON.parse(pc.channel.sent.at(-1));
    const second = client.request("second");
    const secondRequest = JSON.parse(pc.channel.sent.at(-1));
    await expect(client.request("over-cap")).rejects.toThrow("Too many pending");

    let firstSettled = false;
    void first.finally(() => {
      firstSettled = true;
    });
    pc.channel.receive(
      JSON.stringify({ version: 1, type: "response", request_id: "wrong-id", ok: true }),
    );
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: firstRequest.request_id,
        ok: true,
        result: { pong: true },
      }),
    );
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: secondRequest.request_id,
        ok: true,
        result: "second-result",
      }),
    );
    await expect(first).resolves.toEqual({ pong: true });
    await expect(second).resolves.toBe("second-result");
    client.close();
  });

  test("request timeout still settles when sending cancel fails", async () => {
    const { client, pc } = await readyClient();
    const request = client.ping({ timeoutMs: 1 });
    pc.channel.throwOnCancel = true;
    const assertion = expect(request).rejects.toThrow("timed out");
    await Bun.sleep(5);
    await assertion;
    client.close();
  });

  test("configured pending cap can lower but never raise the protocol maximum", async () => {
    const { client, pc } = await readyClient({
      maxPendingRequests: 1000,
      requestTimeoutMs: 1000,
    });
    const pending = Array.from({ length: 32 }, (_, index) =>
      client.request(`pending-${index}`).catch((error) => error),
    );
    expect(pc.channel.sent).toHaveLength(32);
    await expect(client.request("hard-cap")).rejects.toThrow("Too many pending");
    client.close();
    await Promise.all(pending);
  });
});
