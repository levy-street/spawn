// @ts-nocheck -- focused browser API fakes; production code remains fully type-checked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/** Poll until `cond` holds (deadline-bounded) — fixed sleeps flake on loaded
 * CI runners when a 5ms client timeout races an 8ms wall-clock nap. */
async function waitFor(cond: () => boolean, deadlineMs = 500): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!cond() && Date.now() < deadline) await Bun.sleep(2);
}

import { HOST_CONTROL_PROTOCOL, HostControlClient } from "./hostControl";
import {
  decodeEd25519PublicKeyWire,
  exportEd25519PublicKeyWire,
  generateEd25519IdentityKeyPair,
  signSignedSignalTranscript,
} from "./signed-signal";
import { signRtcSignalWire } from "./signed-signal-wire";

class FakeDataChannel {
  label: string;
  readyState = "open";
  sent: string[] = [];
  bufferedAmount = 0;
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
  restartIceCalls = 0;
  setConfigurationCalls = [];
  offerOptions = [];

  constructor(config) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string) {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }

  async createOffer(options) {
    this.offerOptions.push(options);
    return { type: "offer", sdp: "v=0\r\n" };
  }

  async setLocalDescription() {}

  async setRemoteDescription(value) {
    this.remoteDescription = value;
  }

  async addIceCandidate() {}

  setConfiguration(config) {
    this.config = { ...this.config, ...config };
    this.setConfigurationCalls.push(config);
  }

  restartIce() {
    this.restartIceCalls += 1;
  }

  close() {}
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  protocol = "spawn.host.v1";
  sent: string[] = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  closeCalls = [];

  constructor(
    readonly url: string,
    readonly subprotocol: string,
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
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
const destinationHostId = "00000000-0000-4000-8000-000000000002";
const metadata = {
  scope_type: "host",
  scope_id: hostId,
  protocol: HOST_CONTROL_PROTOCOL,
  protocol_version: 1,
};

async function readyClient(options = {}, clientHostId = hostId, capabilities = ["ping"]) {
  const clientMetadata = { ...metadata, scope_id: clientHostId };
  const client = new HostControlClient(clientHostId, options);
  client.connect();
  const ws = FakeWebSocket.instances.at(-1);
  ws.onopen?.();
  ws.receive({
    type: "rtc.config",
    enabled: true,
    ice_servers: [{ urls: ["turn:relay.example"] }],
    ice_transport_policy: "relay",
    ...clientMetadata,
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
      capabilities,
    }),
  );
  return { client, ws, pc, offer };
}

function framesOf(channel, type) {
  return channel.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === type);
}

async function signedRtcTrust() {
  const browser = await generateEd25519IdentityKeyPair();
  const host = await generateEd25519IdentityKeyPair();
  const browserPublicKeyWire = await exportEd25519PublicKeyWire(browser.publicKey);
  const hostPublicKeyWire = await exportEd25519PublicKeyWire(host.publicKey);
  return {
    browser,
    browserPublicKeyWire,
    host,
    hostPublicKeyWire,
    trust: {
      browserPublicKeyWire,
      hostPublicKeyWire,
      assertActive: () => {},
      signOffer: (input) =>
        signRtcSignalWire(
          {
            publicKeyWire: browserPublicKeyWire,
            sign: (transcript) => signSignedSignalTranscript(browser.privateKey, transcript),
          },
          input,
        ),
    },
  };
}

async function waitForSentFrame(ws, type) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = ws.sent.map((value) => JSON.parse(value)).find((value) => value.type === type);
    if (frame) return frame;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function startedTransfer(destinationOptions = {}) {
  const source = await readyClient();
  const destination = await readyClient(destinationOptions, destinationHostId);
  const transferring = source.client.transferFileTo(
    destination.client,
    "/source/notes.txt",
    "/destination",
  );
  const readRequest = JSON.parse(source.pc.channel.sent.at(-1));
  source.pc.channel.receive(
    JSON.stringify({
      version: 1,
      type: "response",
      request_id: readRequest.request_id,
      ok: true,
      result: {
        stream_id: "source-stream",
        path: "/source/notes.txt",
        name: "notes.txt",
        length: 3,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }),
  );
  await Bun.sleep(1);
  const writeRequest = destination.pc.channel.sent
    .map((frame) => JSON.parse(frame))
    .find((frame) => frame.operation === "fs.write.begin");
  destination.pc.channel.receive(
    JSON.stringify({
      version: 1,
      type: "response",
      request_id: writeRequest.request_id,
      ok: true,
      result: { stream_id: "destination-stream" },
    }),
  );
  await Bun.sleep(1);
  return { source, destination, transferring };
}

async function startedEmptyWrite(options = {}, signal?: AbortSignal) {
  const endpoint = await readyClient(options);
  const writing = endpoint.client.writeStream(
    new Blob([]).stream(),
    {
      dir: "/private",
      name: "empty.bin",
      length: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    signal,
  );
  const begin = endpoint.pc.channel.sent
    .map((frame) => JSON.parse(frame))
    .find((frame) => frame.operation === "fs.write.begin");
  endpoint.pc.channel.receive(
    JSON.stringify({
      version: 1,
      type: "response",
      request_id: begin.request_id,
      ok: true,
      result: { stream_id: "indeterminate-write" },
    }),
  );
  await Bun.sleep(2);
  expect(framesOf(endpoint.pc.channel, "stream.end")).toHaveLength(1);
  return { ...endpoint, writing };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.RTCPeerConnection = FakePeerConnection;
  const fakeWindow = new EventTarget();
  fakeWindow.location = { protocol: "https:", host: "spawn.test" };
  globalThis.window = fakeWindow;
  const fakeDocument = new EventTarget();
  fakeDocument.visibilityState = "visible";
  globalThis.document = fakeDocument;
});

afterEach(() => {
  for (const ws of FakeWebSocket.instances) ws.onclose = null;
});

describe("HostControlClient", () => {
  test("signed HostControl applies only the host-signed transcript SDP", async () => {
    const signed = await signedRtcTrust();
    const client = new HostControlClient(hostId, {
      resolveSignedRtcTrust: async () => ({ mode: "signed", capability: signed.trust }),
    });
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
    const offer = await waitForSentFrame(ws, "rtc.offer");
    expect(offer).toHaveProperty("signed_envelope");
    expect(offer).not.toHaveProperty("sdp");

    const verifiedSdp = "v=0\r\ns=verified-host-control\r\na=fingerprint:sha-256 11:22\r\n";
    const rawRelaySdp = "v=0\r\ns=hostile-relay\r\na=fingerprint:sha-256 AA:BB\r\n";
    const signedEnvelope = await signRtcSignalWire(
      {
        publicKeyWire: signed.hostPublicKeyWire,
        sign: (transcript) => signSignedSignalTranscript(signed.host.privateKey, transcript),
      },
      {
        protocol: HOST_CONTROL_PROTOCOL,
        transcript: {
          signalKind: "answer",
          protocolVersion: 1,
          sessionId: offer.session_id,
          scopeType: "host",
          scopeId: hostId,
          senderRole: "daemon",
          intendedPeerPublicKey: decodeEd25519PublicKeyWire(signed.browserPublicKeyWire),
          sdp: verifiedSdp,
        },
      },
    );
    const pc = FakePeerConnection.instances.at(-1);
    ws.receive({
      type: "rtc.answer",
      session_id: offer.session_id,
      signed_envelope: signedEnvelope,
      sdp: rawRelaySdp,
      ...metadata,
    });
    await waitFor(() => pc.remoteDescription !== null);

    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: verifiedSdp });
    expect(pc.remoteDescription.sdp).not.toBe(rawRelaySdp);
    client.close();
  });

  test("signed HostControl tears down stripped answers without legacy fallback", async () => {
    const signed = await signedRtcTrust();
    const client = new HostControlClient(hostId, {
      resolveSignedRtcTrust: async () => ({ mode: "signed", capability: signed.trust }),
    });
    client.connect();
    const ws = FakeWebSocket.instances.at(-1);
    ws.onopen?.();
    ws.receive({ type: "rtc.config", enabled: true, ...metadata });
    const offer = await waitForSentFrame(ws, "rtc.offer");
    const pc = FakePeerConnection.instances.at(-1);
    ws.receive({
      type: "rtc.answer",
      session_id: offer.session_id,
      sdp: "v=0\r\ns=unsigned-fallback\r\n",
      ...metadata,
    });
    await Bun.sleep(5);

    expect(pc.remoteDescription).toBeNull();
    expect(pc.channel.closed).toBe(true);
    client.close();
  });

  test("signed HostControl buffers ICE and ignores a raw answer before the offer arms", async () => {
    // Reproduce the pre-arm race: a signed generation is selected, but the
    // signing round-trip has not finished, so signedRtcSession is not yet set.
    // A server that learns the session id early and returns a raw answer here
    // must NOT get its fingerprint applied via a legacy setRemoteDescription.
    const signed = await signedRtcTrust();
    let capturedSessionId: string | null = null;
    let reachSigning: () => void;
    const signingReached = new Promise<void>((resolve) => {
      reachSigning = resolve;
    });
    let releaseSigning: () => void;
    const signingGate = new Promise<void>((resolve) => {
      releaseSigning = resolve;
    });
    const capability = {
      ...signed.trust,
      signOffer: async (input) => {
        capturedSessionId = input.transcript.sessionId;
        reachSigning();
        await signingGate;
        return signed.trust.signOffer(input);
      },
    };
    const client = new HostControlClient(hostId, {
      resolveSignedRtcTrust: async () => ({ mode: "signed", capability }),
    });
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

    // Wait until we are inside the signing boundary: offer gathered, but the
    // signed session is not yet armed. This is the exact vulnerable window.
    await signingReached;
    const pc = FakePeerConnection.instances.at(-1);
    expect(capturedSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // (b) Locally-gathered ICE must be buffered, not emitted, before the offer:
    // emitting it would disclose the session id ahead of the signed envelope.
    pc.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: "candidate:host", sdpMid: "0", sdpMLineIndex: 0 }) },
    });
    expect(framesOf(ws, "rtc.candidate")).toHaveLength(0);
    expect(framesOf(ws, "rtc.offer")).toHaveLength(0);

    // (a) A raw answer arriving in the window is ignored — never applied and
    // never allowed to tear the generation into an unpinned reconnect.
    ws.receive({
      type: "rtc.answer",
      session_id: capturedSessionId,
      sdp: "v=0\r\ns=hostile-race\r\na=fingerprint:sha-256 AA:BB\r\n",
      ...metadata,
    });
    await Bun.sleep(2);
    expect(pc.remoteDescription).toBeNull();
    expect(pc.channel.closed).toBe(false);

    // Arm the signed offer: now the offer and the buffered candidate flow, both
    // bound to the same session id, and the raw answer still never took effect.
    releaseSigning();
    const offer = await waitForSentFrame(ws, "rtc.offer");
    expect(offer).toHaveProperty("signed_envelope");
    expect(offer).not.toHaveProperty("sdp");
    expect(offer.session_id).toBe(capturedSessionId);
    const candidateFrame = await waitForSentFrame(ws, "rtc.candidate");
    expect(candidateFrame.session_id).toBe(capturedSessionId);
    expect(pc.remoteDescription).toBeNull();
    client.close();
  });

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

  test("returns one directory page at a time and advances only on an explicit cursor", async () => {
    const { client, pc } = await readyClient();
    const first = client.list("/private");
    const firstRequest = JSON.parse(pc.channel.sent.at(-1));
    expect(firstRequest).toMatchObject({
      operation: "fs.list",
      payload: { path: "/private", cursor: 0 },
    });
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: firstRequest.request_id,
        ok: true,
        result: {
          path: "/private",
          home_dir: "/private",
          entries: [{ name: "first", path: "/private/first", kind: "file", is_dir: false }],
          next_cursor: 1,
        },
      }),
    );
    await expect(first).resolves.toMatchObject({
      entries: [expect.objectContaining({ name: "first" })],
      next_cursor: 1,
    });
    expect(
      pc.channel.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.operation === "fs.list"),
    ).toHaveLength(1);

    const second = client.listPage("/private", 1);
    const secondRequest = JSON.parse(pc.channel.sent.at(-1));
    expect(secondRequest.payload.cursor).toBe(1);
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: secondRequest.request_id,
        ok: true,
        result: { path: "/private", home_dir: "/private", entries: [], next_cursor: null },
      }),
    );
    await expect(second).resolves.toMatchObject({ entries: [], next_cursor: null });
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
    await waitFor(
      () => FakePeerConnection.instances[0].channel.closed && FakeWebSocket.instances.length === 2,
    );

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
    await waitFor(() => noHelloPc.channel.closed && FakeWebSocket.instances.length === 2);
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
    await waitFor(() => FakeWebSocket.instances.length === 2);
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
    await waitFor(() => FakeWebSocket.instances.length === 2);
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

  test("the first config frame resets websocket backoff after an unavailable host", async () => {
    const client = new HostControlClient(hostId, {
      connectTimeoutMs: 1000,
      reconnectBaseDelayMs: 20,
      reconnectRandom: () => 0.5,
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

  test("a protocol-required close is terminal without becoming a trust refusal", async () => {
    const client = new HostControlClient(hostId, { reconnectBaseDelayMs: 1 });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    ws.onclose?.({ code: 4003 });

    await Bun.sleep(5);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getState()).toBe("error");
    expect(client.getTerminalReason()).toBe("protocol_required");
    expect(client.getSignedRtcRefusal()).toBeNull();
    client.close();
  });

  test("a 1008 close is terminal and surfaces the signed-out state", async () => {
    const client = new HostControlClient(hostId, { reconnectBaseDelayMs: 1 });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    ws.onclose?.({ code: 1008 });

    await Bun.sleep(5);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getState()).toBe("unauthorized");
    client.close();
  });

  test("arms the host watchdog only after the first server ping", async () => {
    const client = new HostControlClient(hostId, { watchdogMs: 5 });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await Bun.sleep(8);
    expect(ws.closeCalls).toHaveLength(0);

    ws.receive({ type: "ping", ts: 42 });
    expect(JSON.parse(ws.sent.at(-1))).toEqual({ type: "pong", ts: 42 });
    await waitFor(() => ws.closeCalls.some((call) => call.code === 4008));
    client.close();
  });

  test("resumes a healthy data channel after signalling reconnect without a new offer", async () => {
    const first = await readyClient({
      reconnectBaseDelayMs: 1,
      reconnectRandom: () => 0.5,
      resumeTimeoutMs: 10,
    });
    const binding = {
      binding_nonce: "a".repeat(32),
      binding_generation: 7,
    };
    first.ws.receive({
      type: "rtc.status",
      session_id: first.offer.session_id,
      status: "connected",
      ...binding,
      ...metadata,
    });
    first.ws.onclose?.({ code: 1012 });
    await waitFor(() => FakeWebSocket.instances.length === 2);
    const resumedWs = FakeWebSocket.instances[1];
    resumedWs.onopen?.();
    resumedWs.receive({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      ice_transport_policy: "all",
      ...metadata,
    });
    const resume = await waitForSentFrame(resumedWs, "rtc.resume");
    expect(resume).toMatchObject({
      session_id: first.offer.session_id,
      ...binding,
    });
    expect(FakePeerConnection.instances).toHaveLength(1);
    resumedWs.receive({
      type: "rtc.status",
      session_id: first.offer.session_id,
      status: "resumed",
      ...binding,
      ...metadata,
    });
    await Bun.sleep(15);
    expect(FakePeerConnection.instances).toHaveLength(1);
    first.client.close();
  });

  test("falls back to a fresh offer when rtc.resume is ignored", async () => {
    const first = await readyClient({
      reconnectBaseDelayMs: 1,
      reconnectRandom: () => 0.5,
      resumeTimeoutMs: 5,
    });
    first.ws.receive({
      type: "rtc.status",
      session_id: first.offer.session_id,
      status: "connected",
      binding_nonce: "b".repeat(32),
      binding_generation: 8,
      ...metadata,
    });
    first.ws.onclose?.({ code: 1012 });
    await waitFor(() => FakeWebSocket.instances.length === 2);
    const resumedWs = FakeWebSocket.instances[1];
    resumedWs.onopen?.();
    resumedWs.receive({ type: "rtc.config", enabled: true, ice_servers: [], ...metadata });
    await waitForSentFrame(resumedWs, "rtc.resume");
    await waitFor(() => FakePeerConnection.instances.length === 2);
    const freshOffer = await waitForSentFrame(resumedWs, "rtc.offer");
    expect(freshOffer.session_id).not.toBe(first.offer.session_id);
    first.client.close();
  });

  test("wake restarts ICE on the binding, then rebuilds if recovery never connects", async () => {
    const endpoint = await readyClient({ iceRestartTimeoutMs: 5 });
    endpoint.ws.receive({
      type: "rtc.status",
      session_id: endpoint.offer.session_id,
      status: "connected",
      binding_nonce: "c".repeat(32),
      binding_generation: 9,
      ...metadata,
    });
    endpoint.pc.connectionState = "disconnected";
    window.dispatchEvent(new Event("online"));
    await waitFor(() => endpoint.pc.restartIceCalls === 1);
    const restartOffer = endpoint.ws.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "rtc.offer" && frame.ice_restart === true);
    expect(restartOffer).toMatchObject({
      session_id: endpoint.offer.session_id,
      binding_nonce: "c".repeat(32),
      binding_generation: 9,
      ice_restart: true,
    });
    expect(endpoint.pc.offerOptions.at(-1)).toEqual({ iceRestart: true });
    await waitFor(() => FakePeerConnection.instances.length === 2);
    endpoint.client.close();
  });

  test("queued callbacks from a replaced websocket cannot affect the current attempt", async () => {
    const client = new HostControlClient(hostId, {
      connectTimeoutMs: 1000,
      reconnectBaseDelayMs: 1,
    });
    client.connect();
    const oldWs = FakeWebSocket.instances[0];
    const staleOpen = oldWs.onopen;
    const staleMessage = oldWs.onmessage;
    const staleError = oldWs.onerror;
    const staleClose = oldWs.onclose;

    oldWs.onopen?.();
    staleClose?.();
    await Bun.sleep(5);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(oldWs.onopen).toBeNull();
    expect(oldWs.onmessage).toBeNull();
    expect(oldWs.onerror).toBeNull();
    expect(oldWs.onclose).toBeNull();

    const newWs = FakeWebSocket.instances[1];
    newWs.onopen?.();
    newWs.receive({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      ice_transport_policy: "all",
      ...metadata,
    });
    await Promise.resolve();
    await Promise.resolve();
    const newPc = FakePeerConnection.instances.at(-1);
    newPc.channel.onopen?.();
    newPc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "hello",
        protocol: HOST_CONTROL_PROTOCOL,
        capabilities: ["ping"],
      }),
    );
    expect(client.getState()).toBe("ready");
    const newSocketSignals = newWs.sent.length;

    staleOpen?.();
    staleMessage?.({
      data: JSON.stringify({
        type: "rtc.config",
        enabled: true,
        ice_servers: [{ urls: ["turn:stale.example"] }],
        ice_transport_policy: "relay",
        ...metadata,
      }),
    });
    staleMessage?.({ data: "null" });
    staleError?.();
    staleClose?.();
    await Promise.resolve();
    await Promise.resolve();
    await Bun.sleep(2);

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(newPc.channel.closed).toBe(false);
    expect(newWs.sent).toHaveLength(newSocketSignals);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.getState()).toBe("ready");
    client.close();
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

  test("lost acknowledgements classify every dispatched ordinary mutation as outcome_unknown", async () => {
    const cases = [
      ["fs.mkdir", (client) => client.mkdir("/private/new")],
      ["fs.rename", (client) => client.rename("/private/old", "new")],
      ["fs.remove", (client) => client.remove("/private/old")],
    ];
    for (const [operation, mutate] of cases) {
      const { client, pc } = await readyClient({ reconnectBaseDelayMs: 1000 });
      const mutation = mutate(client);
      expect(JSON.parse(pc.channel.sent.at(-1)).operation).toBe(operation);
      const failed = mutation.catch((error) => error);
      pc.channel.onclose?.();
      await expect(failed).resolves.toMatchObject({
        name: "HostControlError",
        code: "outcome_unknown",
      });
      client.close();
    }
  });

  test("mutation timeout and abort are conservative only after dispatch", async () => {
    const timed = await readyClient();
    const timedOut = timed.client.mkdir("/private/new", { timeoutMs: 1 }).catch((error) => error);
    await Bun.sleep(5);
    await expect(timedOut).resolves.toMatchObject({ code: "outcome_unknown" });
    expect(JSON.parse(timed.pc.channel.sent.at(-1)).type).toBe("cancel");
    timed.client.close();

    const activeAbort = new AbortController();
    const active = await readyClient();
    const aborted = active.client
      .rename("/private/old", "new", false, { signal: activeAbort.signal })
      .catch((error) => error);
    expect(JSON.parse(active.pc.channel.sent.at(-1)).operation).toBe("fs.rename");
    activeAbort.abort();
    await expect(aborted).resolves.toMatchObject({ code: "outcome_unknown" });
    active.client.close();

    const preDispatchAbort = new AbortController();
    preDispatchAbort.abort();
    const before = await readyClient();
    const preDispatch = await before.client
      .remove("/private/old", false, { signal: preDispatchAbort.signal })
      .catch((error) => error);
    expect(preDispatch.name).toBe("AbortError");
    expect(preDispatch.code).not.toBe("outcome_unknown");
    expect(
      before.pc.channel.sent.some((frame) => JSON.parse(frame).operation === "fs.remove"),
    ).toBe(false);
    before.client.close();
  });

  test("read-only acknowledgement loss and explicit no-effect mutation errors stay definitive", async () => {
    const readOnly = await readyClient();
    const ping = readOnly.client.ping({ timeoutMs: 1 }).catch((error) => error);
    await Bun.sleep(5);
    const pingError = await ping;
    expect(pingError.code).toBeUndefined();
    expect(pingError.message).toContain("timed out");
    readOnly.client.close();

    const explicit = await readyClient();
    const mutation = explicit.client.mkdir("/private/new");
    const request = JSON.parse(explicit.pc.channel.sent.at(-1));
    explicit.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: false,
        error: { code: "already_exists", detail: "destination exists" },
      }),
    );
    await expect(mutation).rejects.toMatchObject({ code: "already_exists" });
    explicit.client.close();
  });

  test("propagates an explicit daemon outcome_unknown without retrying", async () => {
    const { client, pc } = await readyClient();
    const mutation = client.remove("/private/old");
    const request = JSON.parse(pc.channel.sent.at(-1));
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: false,
        error: {
          code: "outcome_unknown",
          detail: "filesystem mutation may have completed; reconcile host state before retrying",
        },
      }),
    );
    await expect(mutation).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(
      pc.channel.sent.filter((frame) => JSON.parse(frame).operation === "fs.remove"),
    ).toHaveLength(1);
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

  test("streams a verified file with bounded acknowledgement flow", async () => {
    const { client, pc } = await readyClient();
    const opening = client.readFile("/private/notes.txt");
    const request = JSON.parse(pc.channel.sent.at(-1));
    const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: {
          stream_id: "read-stream",
          path: "/private/notes.txt",
          name: "notes.txt",
          length: 5,
          sha256,
        },
      }),
    );
    const read = await opening;
    const reader = read.stream.getReader();
    const next = reader.read();
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.chunk",
        stream_id: "read-stream",
        sequence: 0,
        bytes_b64: btoa("hello"),
      }),
    );
    expect(new TextDecoder().decode((await next).value)).toBe("hello");
    await Promise.resolve();
    expect(pc.channel.sent.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({ type: "stream.ack", stream_id: "read-stream", sequence: 1 }),
    );
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.end",
        stream_id: "read-stream",
        length: 5,
        sha256,
      }),
    );
    expect((await reader.read()).done).toBe(true);
    client.close();
  });

  test("accepts only the bounded late read window after cancellation and keeps the channel usable", async () => {
    const { client, pc } = await readyClient();
    const reading = client.readFile("/private/late.txt");
    const request = JSON.parse(pc.channel.sent.at(-1));
    const sha256 = "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab";
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: {
          stream_id: "late-read",
          path: "/private/late.txt",
          name: "late.txt",
          length: 8,
          sha256,
        },
      }),
    );
    const read = await reading;
    await read.stream.cancel("destination failed");
    expect(framesOf(pc.channel, "stream.cancel")).toContainEqual(
      expect.objectContaining({ stream_id: "late-read" }),
    );

    for (const [sequence, byte] of [..."abcdefgh"].entries()) {
      pc.channel.receive(
        JSON.stringify({
          version: 1,
          type: "stream.chunk",
          stream_id: "late-read",
          sequence,
          bytes_b64: btoa(byte),
        }),
      );
    }
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.end",
        stream_id: "late-read",
        length: 8,
        sha256,
      }),
    );
    expect(pc.channel.closed).toBe(false);

    const ping = client.ping();
    const pingRequest = JSON.parse(pc.channel.sent.at(-1));
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: pingRequest.request_id,
        ok: true,
        result: { pong: true },
      }),
    );
    await expect(ping).resolves.toEqual({ pong: true });
    client.close();
  });

  test("still closes on an unknown or replayed stream after cancellation drain", async () => {
    const { client, pc } = await readyClient();
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.chunk",
        stream_id: "unknown-stream",
        sequence: 0,
        bytes_b64: btoa("x"),
      }),
    );
    expect(pc.channel.closed).toBe(true);
    client.close();
  });

  test("rejects a read declaration that reuses a cancelled stream id", async () => {
    const { client, pc } = await readyClient();
    const sha256 = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
    const firstOpening = client.readFile("/private/first.txt");
    const firstRequest = JSON.parse(pc.channel.sent.at(-1));
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: firstRequest.request_id,
        ok: true,
        result: {
          stream_id: "reused-read",
          path: "/private/first.txt",
          name: "first.txt",
          length: 1,
          sha256,
        },
      }),
    );
    const first = await firstOpening;
    await first.stream.cancel("caller stopped reading");

    const replayedOpening = client.readFile("/private/second.txt");
    const replayedRequest = JSON.parse(pc.channel.sent.at(-1));
    const oldSessionHandler = pc.channel.onmessage;
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: replayedRequest.request_id,
        ok: true,
        result: {
          stream_id: "reused-read",
          path: "/private/second.txt",
          name: "second.txt",
          length: 1,
          sha256,
        },
      }),
    );

    await expect(replayedOpening).rejects.toMatchObject({ code: "invalid_response" });
    expect(pc.channel.closed).toBe(true);
    oldSessionHandler?.({
      data: JSON.stringify({
        version: 1,
        type: "stream.chunk",
        stream_id: "reused-read",
        sequence: 0,
        bytes_b64: btoa("x"),
      }),
    });
    expect(framesOf(pc.channel, "stream.ack")).toHaveLength(0);
    client.close();
  });

  test("declares and commits a chunked verified write", async () => {
    const { client, pc } = await readyClient();
    const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const writing = client.writeStream(new Blob(["hello"]).stream(), {
      dir: "/private",
      name: "notes.txt",
      length: 5,
      sha256,
    });
    const begin = JSON.parse(pc.channel.sent.at(-1));
    expect(begin).toMatchObject({ operation: "fs.write.begin" });
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: begin.request_id,
        ok: true,
        result: { stream_id: "write-stream" },
      }),
    );
    await Bun.sleep(2);
    const frames = pc.channel.sent.map((frame) => JSON.parse(frame));
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "stream.chunk",
        stream_id: "write-stream",
        sequence: 0,
        bytes_b64: btoa("hello"),
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "stream.end", stream_id: "write-stream" }),
    );
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.committed",
        stream_id: "write-stream",
        path: "/private/notes.txt",
      }),
    );
    await expect(writing).resolves.toBe("/private/notes.txt");
    client.close();
  });

  test("write acknowledgement loss after stream.end is outcome_unknown", async () => {
    const closed = await startedEmptyWrite({ reconnectBaseDelayMs: 1000 });
    const lost = closed.writing.catch((error) => error);
    closed.pc.channel.onclose?.();
    await expect(lost).resolves.toMatchObject({ code: "outcome_unknown" });
    closed.client.close();

    const timed = await startedEmptyWrite({ streamTimeoutMs: 5 });
    const timedOut = timed.writing.catch((error) => error);
    await Bun.sleep(10);
    await expect(timedOut).resolves.toMatchObject({ code: "outcome_unknown" });
    expect(framesOf(timed.pc.channel, "stream.cancel")).toHaveLength(1);
    timed.client.close();

    const controller = new AbortController();
    const aborted = await startedEmptyWrite({}, controller.signal);
    const abortError = aborted.writing.catch((error) => error);
    controller.abort();
    await expect(abortError).resolves.toMatchObject({ code: "outcome_unknown" });
    aborted.client.close();
  });

  test("pre-commit write loss and explicit post-end errors retain their ordinary outcome", async () => {
    const preCommit = await readyClient({ reconnectBaseDelayMs: 1000 });
    const stalledInput = new ReadableStream({ pull: () => new Promise(() => {}) });
    const writing = preCommit.client.writeStream(stalledInput, {
      dir: "/private",
      name: "pending.bin",
      length: 1,
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const begin = JSON.parse(preCommit.pc.channel.sent.at(-1));
    preCommit.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: begin.request_id,
        ok: true,
        result: { stream_id: "pre-commit-write" },
      }),
    );
    const preCommitError = writing.catch((error) => error);
    preCommit.pc.channel.onclose?.();
    await expect(preCommitError).resolves.toMatchObject({ code: "connection_closed" });
    preCommit.client.close();

    const explicit = await startedEmptyWrite();
    explicit.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.error",
        stream_id: "indeterminate-write",
        error: { code: "already_exists", detail: "destination exists" },
      }),
    );
    await expect(explicit.writing).rejects.toMatchObject({ code: "already_exists" });
    explicit.client.close();
  });

  test("pumps cross-host bytes through two independent host sessions", async () => {
    const source = await readyClient();
    const destination = await readyClient({}, destinationHostId);
    expect(source.client.hostId).toBe(hostId);
    expect(destination.client.hostId).toBe(destinationHostId);
    expect(source.ws.url).toContain(`host_id=${hostId}`);
    expect(destination.ws.url).toContain(`host_id=${destinationHostId}`);
    expect(source.offer.scope_id).toBe(hostId);
    expect(destination.offer.scope_id).toBe(destinationHostId);
    expect(source.offer.session_id).not.toBe(destination.offer.session_id);
    expect(source.pc.channel).not.toBe(destination.pc.channel);
    const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const transferring = source.client.transferFileTo(
      destination.client,
      "/source/notes.txt",
      "/destination",
    );
    const readRequest = JSON.parse(source.pc.channel.sent.at(-1));
    source.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: readRequest.request_id,
        ok: true,
        result: {
          stream_id: "source-stream",
          path: "/source/notes.txt",
          name: "notes.txt",
          length: 5,
          sha256,
        },
      }),
    );
    await Bun.sleep(1);
    const writeRequest = destination.pc.channel.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.operation === "fs.write.begin");
    expect(writeRequest.payload).toMatchObject({
      dir: "/destination",
      name: "notes.txt",
      length: 5,
      sha256,
    });
    destination.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: writeRequest.request_id,
        ok: true,
        result: { stream_id: "destination-stream" },
      }),
    );
    source.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.chunk",
        stream_id: "source-stream",
        sequence: 0,
        bytes_b64: btoa("hello"),
      }),
    );
    source.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.end",
        stream_id: "source-stream",
        length: 5,
        sha256,
      }),
    );
    await Bun.sleep(2);
    const destinationFrames = destination.pc.channel.sent.map((frame) => JSON.parse(frame));
    expect(destinationFrames).toContainEqual(
      expect.objectContaining({
        type: "stream.chunk",
        stream_id: "destination-stream",
        bytes_b64: btoa("hello"),
      }),
    );
    expect(destinationFrames).toContainEqual(
      expect.objectContaining({ type: "stream.end", stream_id: "destination-stream" }),
    );
    destination.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.committed",
        stream_id: "destination-stream",
        path: "/destination/notes.txt",
      }),
    );
    await expect(transferring).resolves.toEqual({ path: "/destination/notes.txt" });
    source.client.close();
    destination.client.close();
  });

  test("rejects cross-host signaling and cannot settle a request on the other host channel", async () => {
    const source = await readyClient();
    const destination = await readyClient({}, destinationHostId);
    source.ws.receive({
      type: "rtc.status",
      session_id: source.offer.session_id,
      status: "failed",
      ...metadata,
      scope_id: destinationHostId,
    });
    expect(source.pc.channel.closed).toBe(false);

    const ping = source.client.ping();
    let settled = false;
    void ping.finally(() => {
      settled = true;
    });
    const request = JSON.parse(source.pc.channel.sent.at(-1));
    destination.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: { pong: "wrong-host" },
      }),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    source.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: { pong: true },
      }),
    );
    await expect(ping).resolves.toEqual({ pong: true });
    source.client.close();
    destination.client.close();
  });

  test("destination stream errors stop both sides before more source bytes are forwarded", async () => {
    const { source, destination, transferring } = await startedTransfer();
    const failed = transferring.catch((error) => error);
    source.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.chunk",
        stream_id: "source-stream",
        sequence: 0,
        bytes_b64: btoa("a"),
      }),
    );
    await Bun.sleep(1);
    const forwarded = framesOf(destination.pc.channel, "stream.chunk").length;
    destination.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.error",
        stream_id: "destination-stream",
        error: { code: "disk_full", detail: "destination rejected the write" },
      }),
    );
    expect((await failed).code).toBe("disk_full");
    expect(framesOf(source.pc.channel, "stream.cancel")).toHaveLength(1);
    expect(framesOf(destination.pc.channel, "stream.cancel")).toHaveLength(1);

    source.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.chunk",
        stream_id: "source-stream",
        sequence: 1,
        bytes_b64: btoa("b"),
      }),
    );
    await Bun.sleep(1);
    expect(framesOf(destination.pc.channel, "stream.chunk")).toHaveLength(forwarded);
    source.client.close();
    destination.client.close();
  });

  test("destination stream timeout cancels the stalled source and sends no further bytes", async () => {
    const { source, destination, transferring } = await startedTransfer({ streamTimeoutMs: 5 });
    const failed = transferring.catch((error) => error);
    source.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.chunk",
        stream_id: "source-stream",
        sequence: 0,
        bytes_b64: btoa("a"),
      }),
    );
    await Bun.sleep(15);
    expect((await failed).code).toBe("stream_timeout");
    const forwarded = framesOf(destination.pc.channel, "stream.chunk").length;
    expect(framesOf(source.pc.channel, "stream.cancel")).toHaveLength(1);
    expect(framesOf(destination.pc.channel, "stream.cancel").length).toBeGreaterThanOrEqual(1);
    await Bun.sleep(5);
    expect(framesOf(destination.pc.channel, "stream.chunk")).toHaveLength(forwarded);
    source.client.close();
    destination.client.close();
  });

  test("source stream errors immediately abort the destination write", async () => {
    const { source, destination, transferring } = await startedTransfer();
    const failed = transferring.catch((error) => error);
    source.pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "stream.error",
        stream_id: "source-stream",
        error: { code: "read_failed", detail: "source read failed" },
      }),
    );
    expect((await failed).code).toBe("read_failed");
    expect(framesOf(destination.pc.channel, "stream.cancel")).toHaveLength(1);
    expect(framesOf(destination.pc.channel, "stream.chunk")).toHaveLength(0);
    source.client.close();
    destination.client.close();
  });

  test("source peer loss aborts the destination write", async () => {
    const { source, destination, transferring } = await startedTransfer();
    const failed = transferring.catch((error) => error);
    source.pc.channel.onclose?.();
    expect((await failed).code).toBe("connection_closed");
    expect(framesOf(destination.pc.channel, "stream.cancel")).toHaveLength(1);
    expect(framesOf(destination.pc.channel, "stream.chunk")).toHaveLength(0);
    source.client.close();
    destination.client.close();
  });

  test("destination peer loss cancels the source read before more bytes are consumed", async () => {
    const { source, destination, transferring } = await startedTransfer();
    const failed = transferring.catch((error) => error);
    destination.pc.channel.onclose?.();
    expect((await failed).code).toBe("connection_closed");
    expect(framesOf(source.pc.channel, "stream.cancel")).toHaveLength(1);
    expect(framesOf(destination.pc.channel, "stream.chunk")).toHaveLength(0);
    source.client.close();
    destination.client.close();
  });
});

describe("HostControlClient capabilities", () => {
  const FULL = [
    "ping",
    "fs.list",
    "fs.read",
    "fs.read.range",
    "fs.preview",
    "desktop.reveal",
    "desktop.open",
  ];

  test("a hello's capabilities are readable as soon as the client is ready", async () => {
    // Parsed before the ready transition, so no subscriber can see a ready
    // client that appears to support nothing and latch that conclusion.
    const seen: Array<ReadonlySet<string>> = [];
    const client = new HostControlClient(hostId, {});
    client.subscribe((state) => {
      if (state === "ready") seen.push(client.getCapabilities());
    });
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
    pc.channel.onopen?.();
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "hello",
        protocol: HOST_CONTROL_PROTOCOL,
        capabilities: FULL,
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].has("desktop.reveal")).toBe(true);
    expect(client.hasCapability("fs.read.range")).toBe(true);
    client.close();
  });

  test("a malformed capability list degrades to empty without dropping the channel", async () => {
    // An odd hello from a future daemon means "we cannot read its menu", not
    // "this connection is broken".
    const { client, pc } = await readyClient({}, hostId, ["fs.list", 42]);
    expect(client.state).toBe("ready");
    expect(client.getCapabilities().size).toBe(0);
    expect(pc.channel.closed).toBe(false);
    client.close();
  });

  test("a hello without a capability list is simply no capabilities", async () => {
    const { client } = await readyClient({}, hostId, null);
    expect(client.state).toBe("ready");
    expect(client.getCapabilities().size).toBe(0);
    client.close();
  });

  test("capabilities are dropped on teardown", async () => {
    // A reconnect onto a downgraded daemon must not inherit the old menu.
    const { client } = await readyClient({}, hostId, FULL);
    expect(client.hasCapability("desktop.open")).toBe(true);
    client.close();
    expect(client.getCapabilities().size).toBe(0);
  });
});

describe("HostControlClient desktop actions", () => {
  const FULL = ["ping", "fs.read.range", "fs.preview", "desktop.reveal", "desktop.open"];

  test("reveal and open send a path and nothing else", async () => {
    // The wire has no field for an application, arguments or flags, so no
    // caller can steer what the host launches.
    const { client, pc } = await readyClient({}, hostId, FULL);
    client.reveal("~/Desktop/report.pdf").catch(() => {});
    client.openDefault("~/Desktop/report.pdf").catch(() => {});
    await Promise.resolve();
    const requests = framesOf(pc.channel, "request");
    const reveal = requests.find((frame) => frame.operation === "desktop.reveal");
    const open = requests.find((frame) => frame.operation === "desktop.open");
    expect(reveal.payload).toEqual({ path: "~/Desktop/report.pdf" });
    expect(open.payload).toEqual({ path: "~/Desktop/report.pdf" });
    expect(Object.keys(open.payload)).toEqual(["path"]);
    client.close();
  });

  test("stat rejects a malformed response rather than trusting it", async () => {
    const { client, pc } = await readyClient({}, hostId, FULL);
    const pending = client.stat("~/notes.txt");
    await Promise.resolve();
    const request = framesOf(pc.channel, "request").at(-1);
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: { path: 42, name: "notes.txt", kind: "file" },
      }),
    );
    await expect(pending).rejects.toThrow(/invalid file stat/i);
    client.close();
  });

  test("stat returns a well-formed result", async () => {
    const { client, pc } = await readyClient({}, hostId, FULL);
    const pending = client.stat("~/notes.txt");
    await Promise.resolve();
    const request = framesOf(pc.channel, "request").at(-1);
    expect(request.operation).toBe("fs.stat");
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: { path: "/home/me/notes.txt", name: "notes.txt", kind: "file", size: 12 },
      }),
    );
    expect((await pending).size).toBe(12);
    client.close();
  });
});

describe("HostControlClient ranged reads", () => {
  const FULL = ["ping", "fs.read", "fs.read.range", "fs.preview"];

  test("rejects nonsensical ranges before they reach the wire", async () => {
    const { client, pc } = await readyClient({}, hostId, FULL);
    const before = framesOf(pc.channel, "request").length;
    await expect(client.readRange("~/a", -1, 10)).rejects.toThrow(/non-negative/i);
    await expect(client.readRange("~/a", 0, 0)).rejects.toThrow(/between 1 and 16 MiB/i);
    await expect(client.readRange("~/a", 0, 64 * 1024 * 1024)).rejects.toThrow(
      /between 1 and 16 MiB/i,
    );
    expect(framesOf(pc.channel, "request")).toHaveLength(before);
    client.close();
  });

  test("sends offset and length as its own operation", async () => {
    // Never as extra keys on fs.read: an older daemon ignores unknown keys and
    // would whole-file hash a 512 MiB video to answer a 4 KiB question.
    const { client, pc } = await readyClient({}, hostId, FULL);
    client.readRange("~/video.mp4", 0, 4096).catch(() => {});
    await Promise.resolve();
    const request = framesOf(pc.channel, "request").at(-1);
    expect(request.operation).toBe("fs.read.range");
    expect(request.payload).toEqual({ path: "~/video.mp4", offset: 0, length: 4096 });
    client.close();
  });

  test("refuses a host that returns more bytes than were asked for", async () => {
    const { client, pc } = await readyClient({}, hostId, FULL);
    const pending = client.readRange("~/video.mp4", 0, 16);
    await Promise.resolve();
    const request = framesOf(pc.channel, "request").at(-1);
    pc.channel.receive(
      JSON.stringify({
        version: 1,
        type: "response",
        request_id: request.request_id,
        ok: true,
        result: {
          stream_id: "range-1",
          path: "/home/me/video.mp4",
          name: "video.mp4",
          offset: 0,
          length: 999,
          file_size: 999,
          sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        },
      }),
    );
    await expect(pending).rejects.toThrow(/more bytes than requested/i);
    client.close();
  });

  test("previewImage only accepts allowlisted render sizes", async () => {
    // A free integer would let a caller ask a third-party QuickLook generator
    // for a 16384px render and allocate a gigabyte on someone's laptop.
    const { client, pc } = await readyClient({}, hostId, FULL);
    const before = framesOf(pc.channel, "request").length;
    await expect(client.previewImage("~/deck.key", 16384)).rejects.toThrow(/unsupported/i);
    await expect(client.previewImage("~/deck.key", 300)).rejects.toThrow(/unsupported/i);
    expect(framesOf(pc.channel, "request")).toHaveLength(before);

    client.previewImage("~/deck.key", 256).catch(() => {});
    await Promise.resolve();
    const request = framesOf(pc.channel, "request").at(-1);
    expect(request.operation).toBe("fs.preview");
    expect(request.payload).toEqual({ path: "~/deck.key", max_pixels: 256 });
    client.close();
  });
});

describe("HostControlClient readHead", () => {
  test("reads a small file whole rather than cancelling a stream", async () => {
    // Cancelling leaves a tombstone, and enough live tombstones tear the
    // control channel down. A file already under the limit needs no range.
    const { client, pc } = await readyClient({}, hostId, ["fs.read", "fs.read.range"]);
    client.readHead("~/notes.txt", 96 * 1024, { size: 12 }).catch(() => {});
    await Promise.resolve();
    const request = framesOf(pc.channel, "request").at(-1);
    expect(request.operation).toBe("fs.read");
    expect(framesOf(pc.channel, "request").some((f) => f.operation === "fs.read.range")).toBe(
      false,
    );
    client.close();
  });

  test("uses a real ranged read for a large file", async () => {
    const { client, pc } = await readyClient({}, hostId, ["fs.read", "fs.read.range"]);
    client.readHead("~/huge.log", 4096, { size: 50_000_000 }).catch(() => {});
    await Promise.resolve();
    const request = framesOf(pc.channel, "request").at(-1);
    expect(request.operation).toBe("fs.read.range");
    expect(request.payload.length).toBe(4096);
    client.close();
  });

  test("declines rather than cancelling when the host has no ranged read", async () => {
    const { client, pc } = await readyClient({}, hostId, ["fs.read"]);
    const before = framesOf(pc.channel, "request").length;
    await expect(client.readHead("~/huge.log", 4096, { size: 50_000_000 })).rejects.toThrow(
      /cannot read part of a file/i,
    );
    // Nothing was started, so nothing needs cancelling.
    expect(framesOf(pc.channel, "request")).toHaveLength(before);
    client.close();
  });
});
