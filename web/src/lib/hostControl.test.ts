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

  constructor(label: string) {
    this.label = label;
  }

  send(value: string) {
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
}

const hostId = "00000000-0000-4000-8000-000000000001";
const metadata = {
  scope_type: "host",
  scope_id: hostId,
  protocol: HOST_CONTROL_PROTOCOL,
  protocol_version: 1,
};

async function readyClient() {
  const client = new HostControlClient(hostId);
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
});
