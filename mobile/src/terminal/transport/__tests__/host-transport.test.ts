import { sha256 } from "@noble/hashes/sha2.js";

jest.mock("@/terminal/transport/daemon-trust", () => ({
  verifyDaemonHost: jest.fn(async () => {}),
}));

import type { CarriedEndorsement } from "@/data/trust/carried-endorsements";
import { createHostPinStore, type HostPin } from "@/data/trust/host-pins";
import type { NativeToWorkerMessage, WorkerToNativeMessage } from "@/terminal/transport/bridge";
import { decodeBridgeBytes, encodeBridgeBytes } from "@/terminal/transport/bridge";
import { HOST_FILE_MAX_BYTES, HOST_STREAM_CHUNK_BYTES } from "@/terminal/transport/host-ctl-codec";
import { createHostTransport } from "@/terminal/transport/host-transport";
import type { SignalChannelLike, WorkerEndpoint } from "@/terminal/transport/types";

jest.mock("@/terminal/transport/signed-signalling", () => ({
  browserIdentityWire: jest.fn(async () => "browser-key"),
  signWorkerRequest: jest.fn(async () => "signature"),
  verifyAnswerFrame: jest.fn((value: unknown) => value),
}));

jest.mock("@/lib/crypto/bootstrap", () => ({
  ...jest.requireActual("@/lib/crypto/bootstrap"),
  randomBytes: jest.fn((length: number) => new Uint8Array(length)),
}));

const FULL_CAPABILITIES = ["fs.read", "fs.read.range", "fs.preview", "fs.write.begin"] as const;
const CARRIED_EDGE: CarriedEndorsement = {
  account_id: "account-id",
  endorser_public_key: "endorser-key",
  endorsed_public_key: "browser-key",
  endorsed_device_id: "endorsed-device-id",
  signature: "endorsement-signature",
};

function digest(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class FakeBridge implements WorkerEndpoint {
  readonly sent: NativeToWorkerMessage[] = [];
  readonly listeners = new Set<(message: WorkerToNativeMessage) => void>();
  autoAcknowledgeCommands = true;

  send(message: NativeToWorkerMessage): void {
    this.sent.push(message);
    if (
      this.autoAcknowledgeCommands &&
      message.type === "host-request" &&
      message.operation.startsWith("$host.stream.")
    ) {
      this.acknowledge(message);
    }
  }

  onMessage(listener: (message: WorkerToNativeMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: WorkerToNativeMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  acknowledge(message: Extract<NativeToWorkerMessage, { type: "host-request" }>): void {
    this.emit({
      v: 1,
      type: "host-response",
      requestId: message.requestId,
      ok: true,
      result: { sent: true },
    });
  }

  stream(frame: Record<string, unknown>): void {
    this.emit({
      v: 1,
      type: "host-response",
      requestId: `$host.stream:${String(frame["stream_id"])}`,
      ok: true,
      result: frame,
    });
  }
}

class FakeSignal implements SignalChannelLike {
  state = "open";
  closeInfo: { code: number; reason: string } | null = null;
  readonly sent: unknown[] = [];
  readonly listeners = new Set<(frame: unknown) => void>();
  readonly stateListeners = new Set<(state: string) => void>();
  send(frame: unknown): void {
    this.sent.push(frame);
  }
  onFrame(listener: (frame: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.listeners.clear();
    this.stateListeners.clear();
  }
  emit(frame: unknown): void {
    for (const listener of this.listeners) listener(frame);
  }
  onState(listener: (state: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  emitState(state: string): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function hostRequests(bridge: FakeBridge, operation: string) {
  return bridge.sent.filter(
    (message): message is Extract<NativeToWorkerMessage, { type: "host-request" }> =>
      message.type === "host-request" && message.operation === operation,
  );
}

async function waitForRequest(bridge: FakeBridge, operation: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = hostRequests(bridge, operation).at(-1);
    if (request) return request;
    await flush();
  }
  throw new Error(`Timed out waiting for ${operation}.`);
}

function respond(bridge: FakeBridge, request: { requestId: string }, result: unknown): void {
  bridge.emit({
    v: 1,
    type: "host-response",
    requestId: request.requestId,
    ok: true,
    result,
  });
}

async function readyTransport(options?: {
  capabilities?: readonly string[];
  omitCapabilities?: boolean;
  streamTimeoutMs?: number;
  loadCarriedEndorsements?: () => Promise<readonly CarriedEndorsement[]>;
}) {
  const bridge = new FakeBridge();
  const signal = new FakeSignal();
  const transport = createHostTransport({
    hostId: "00112233-4455-6677-8899-aabbccddeeff",
    hostIdentityPublicKey: "host-key",
    bridge,
    openSignal: () => signal,
    ...(options?.streamTimeoutMs === undefined ? {} : { streamTimeoutMs: options.streamTimeoutMs }),
    ...(options?.loadCarriedEndorsements === undefined
      ? {}
      : { loadCarriedEndorsements: options.loadCarriedEndorsements }),
  });
  const opening = transport.open();
  await flush();
  signal.emit({
    type: "rtc.config",
    enabled: true,
    ice_servers: [],
    scope_type: "host",
    scope_id: "00112233-4455-6677-8899-aabbccddeeff",
    protocol: "spawn.host.ctl",
    protocol_version: 2,
  });
  bridge.emit({
    v: 1,
    type: "host-response",
    requestId: "$host.hello",
    ok: true,
    result: {
      version: 1,
      type: "hello",
      protocol: "spawn.host.ctl",
      ...(options?.omitCapabilities
        ? {}
        : {
            capabilities: [...(options?.capabilities ?? FULL_CAPABILITIES), "session.transport.v1"],
          }),
      limits: {
        frame_bytes: 16 * 1024,
        chunk_bytes: HOST_STREAM_CHUNK_BYTES,
        file_bytes: HOST_FILE_MAX_BYTES,
        range_bytes: 16 * 1024 * 1024,
        preview_bytes: 2 * 1024 * 1024,
        preview_pixels: [128, 256, 512, 1024],
      },
    },
  });
  bridge.emit({ v: 1, type: "state", state: "ready" });
  try {
    await opening;
  } catch (error) {
    transport.close();
    throw error;
  }
  return { bridge, signal, transport };
}

test("reconfirmed trust preserves a ready root and retries a refused root only once", async () => {
  const pins: HostPin[] = [];
  const store = createHostPinStore({
    load: async () => pins,
    save: async (pin) => {
      pins.splice(0, pins.length, pin);
    },
    deleteAccount: async () => {
      pins.length = 0;
    },
  });
  const approval = {
    accountId: "00000000-0000-4000-8000-000000000001",
    serverOrigin: "https://spawn.example",
    hostPublicKey: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
    hostId: "00112233-4455-6677-8899-aabbccddeeff",
  };
  await store.approveExact(approval);
  const { bridge, signal, transport } = await readyTransport();
  const count = (type: string) => bridge.sent.filter((message) => message.type === type).length;
  try {
    const initialMessages = bridge.sent.length;
    await store.approveExact(approval);
    await flush();
    expect(transport.state).toBe("ready");
    expect(bridge.sent).toHaveLength(initialMessages);
    const request = transport.request("fs.read", { path: "~/notes.txt" });
    respond(bridge, await waitForRequest(bridge, "fs.read"), { stillAttached: true });
    await expect(request).resolves.toEqual({ stillAttached: true });

    signal.emitState("failed");
    expect(transport.state).toBe("failed");
    signal.state = "open";
    await store.approveExact(approval);
    await flush();
    expect(transport.state).toBe("connecting");
    expect(count("init")).toBe(2);
    const closes = count("close");
    await store.approveExact(approval);
    await store.approveExact(approval);
    await flush();
    expect(count("init")).toBe(2);
    expect(count("close")).toBe(closes);

    // A genuine trust change still fences a recovering root immediately.
    await store.revokeExact(approval);
    await flush();
    expect(count("close")).toBeGreaterThan(closes);
  } finally {
    transport.close();
  }
});

async function beginRead(
  bridge: FakeBridge,
  transport: Awaited<ReturnType<typeof readyTransport>>["transport"],
  bytes: Uint8Array,
) {
  const pending = transport.readFile("~/notes.txt");
  const request = await waitForRequest(bridge, "fs.read");
  respond(bridge, request, {
    stream_id: "read-stream",
    path: "/Users/me/notes.txt",
    name: "notes.txt",
    length: bytes.byteLength,
    sha256: digest(bytes),
  });
  return pending;
}

const HOST_ID = "00112233-4455-6677-8899-aabbccddeeff";

function openTransport(bridge: FakeBridge, signal: FakeSignal) {
  const transport = createHostTransport({
    hostId: HOST_ID,
    hostIdentityPublicKey: "host-key",
    bridge,
    openSignal: () => signal,
  });
  // Settle before any frame arrives: #fail rejects synchronously from emit().
  const settled = transport.open().then(
    () => null,
    (error: unknown) => error,
  );
  return { transport, settled };
}

describe("HostTransport signalling", () => {
  test("an early retry waits for the worker document before sending initialization", async () => {
    let loaded!: () => void;
    const workerReady = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const bridge = Object.assign(new FakeBridge(), { whenReady: () => workerReady });
    const signal = new FakeSignal();
    const { transport, settled } = openTransport(bridge, signal);
    try {
      await flush();
      signal.emit({
        type: "rtc.config",
        enabled: true,
        ice_servers: [],
        scope_type: "host",
        scope_id: HOST_ID,
        protocol: "spawn.host.ctl",
        protocol_version: 2,
      });
      expect(bridge.sent).toEqual([]);
      loaded();
      await flush();
      expect(bridge.sent.map((message) => message.type)).toEqual(["init", "connect"]);
    } finally {
      transport.close();
      loaded();
      await settled;
    }
  });

  test("closing an attempt waiting for its document cannot revive it after load", async () => {
    let loaded!: () => void;
    const workerReady = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const bridge = Object.assign(new FakeBridge(), { whenReady: () => workerReady });
    const { transport, settled } = openTransport(bridge, new FakeSignal());
    const cancelled = jest.fn();
    void settled.then(cancelled);
    try {
      await flush();
      transport.close();
      await flush();
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(transport.state).toBe("closed");
      loaded();
      await flush();
      expect(bridge.sent.map((message) => message.type)).toEqual(["close"]);
    } finally {
      transport.close();
      loaded();
      await settled;
    }
  });

  test("an unavailable initial offer waits for worker teardown and delayed reconnect", async () => {
    jest.useFakeTimers();
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const { transport, settled } = openTransport(bridge, signal);
    const config = {
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      scope_type: "host",
      scope_id: HOST_ID,
      protocol: "spawn.host.ctl",
      protocol_version: 2,
    };
    try {
      await jest.advanceTimersByTimeAsync(0);
      signal.emit(config);
      const first = bridge.sent.find((message) => message.type === "connect");
      if (first?.type !== "connect") throw new Error("Missing initial peer.");
      const unavailable = {
        type: "rtc.status",
        session_id: first.rtcSessionId,
        scope_type: "host",
        scope_id: HOST_ID,
        protocol: "spawn.host.ctl",
        protocol_version: 2,
        status: "unavailable",
      };
      signal.emit(unavailable);
      expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(1);
      expect(bridge.sent).toContainEqual({ v: 1, type: "signal-frame", frame: unavailable });
      // The bundled worker closes its peer before requesting a delayed retry.
      bridge.emit({ v: 1, type: "state", state: "reconnecting" });
      await jest.advanceTimersByTimeAsync(349);
      expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(302);
      signal.emit(config);
      expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(2);
    } finally {
      transport.close();
      await settled;
      jest.useRealTimers();
    }
  });

  test("prompt repeated refusals cannot extend the initial connection deadline", async () => {
    jest.useFakeTimers();
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const transport = createHostTransport({
      hostId: HOST_ID,
      hostIdentityPublicKey: "host-key",
      bridge,
      openSignal: () => signal,
      connectTimeoutMs: 2_000,
    });
    const settled = transport.open().catch((error: unknown) => error);
    try {
      await jest.advanceTimersByTimeAsync(0);
      for (let tick = 0; tick < 20 && transport.state !== "failed"; tick += 1) {
        signal.emit({
          type: "rtc.config",
          enabled: true,
          ice_servers: [],
          scope_type: "host",
          scope_id: HOST_ID,
          protocol: "spawn.host.ctl",
          protocol_version: 2,
        });
        bridge.emit({ v: 1, type: "state", state: "reconnecting" });
        await jest.advanceTimersByTimeAsync(250);
      }
      expect(transport.state).toBe("failed");
      await expect(settled).resolves.toMatchObject({ code: "connect_timeout" });
      const created = bridge.sent.filter((message) => message.type === "connect").length;
      expect(created).toBeLessThanOrEqual(4);
      await jest.advanceTimersByTimeAsync(180_000);
      expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(created);
      expect(bridge.listeners.size).toBe(0);
    } finally {
      transport.close();
      await settled;
      jest.useRealTimers();
    }
  });

  test("prompt repeated refusals stop at the established connection recovery budget", async () => {
    const { transport, signal, bridge } = await readyTransport();
    jest.useFakeTimers();
    try {
      bridge.emit({ v: 1, type: "state", state: "reconnecting" });
      for (let second = 0; second < 180; second += 1) {
        signal.emit({
          type: "rtc.config",
          enabled: true,
          ice_servers: [],
          scope_type: "host",
          scope_id: HOST_ID,
          protocol: "spawn.host.ctl",
          protocol_version: 2,
        });
        bridge.emit({ v: 1, type: "state", state: "reconnecting" });
        await jest.advanceTimersByTimeAsync(1_000);
      }
      expect(transport.state).toBe("failed");
      expect(transport.lastError).toMatchObject({ code: "connect_timeout", retryable: false });
      const created = bridge.sent.filter((message) => message.type === "connect").length;
      expect(created).toBeLessThan(20);
      await jest.advanceTimersByTimeAsync(180_000);
      expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(created);
    } finally {
      transport.close();
      jest.useRealTimers();
    }
  });

  test("a refused resume rebuilds immediately once, then ordinary refusal tears down", async () => {
    const { transport, signal, bridge } = await readyTransport();
    jest.useFakeTimers();
    try {
      const first = bridge.sent.find((message) => message.type === "connect");
      if (first?.type !== "connect") throw new Error("Missing initial peer.");
      signal.emit({
        type: "rtc.status",
        session_id: first.rtcSessionId,
        status: "connected",
        binding_generation: 1,
      });
      signal.emitState("open");
      expect(signal.sent).toContainEqual(expect.objectContaining({ type: "rtc.resume" }));
      const unavailable = {
        type: "rtc.status",
        session_id: first.rtcSessionId,
        status: "unavailable",
      };
      signal.emit(unavailable);
      expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(2);
      signal.emit(unavailable);
      expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(2);
      expect(bridge.sent.at(-1)).toEqual({ v: 1, type: "signal-frame", frame: unavailable });
      bridge.emit({ v: 1, type: "state", state: "reconnecting" });
      transport.close();
      await jest.advanceTimersByTimeAsync(180_000);
      expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(2);
    } finally {
      transport.close();
      jest.useRealTimers();
    }
  });

  test("fatal signalling retires the worker and rejects active work without losing the failure", async () => {
    const { bridge, signal, transport } = await readyTransport();
    const pending = transport.request("host.metrics", {});
    const rejected = expect(pending).rejects.toMatchObject({ code: "signal_failed" });
    signal.emitState("failed");
    await rejected;
    expect(transport.state).toBe("failed");
    expect(transport.lastError).toMatchObject({ code: "signal_failed", retryable: false });
    expect(bridge.sent.filter((message) => message.type === "close")).toHaveLength(1);
    expect(bridge.listeners.size).toBe(0);
    expect(signal.listeners.size).toBe(0);
    await expect(transport.open()).rejects.toThrow("failed state");
    transport.close();
  });

  test("trust refusal after peer creation closes the worker and rejects opening", async () => {
    let refuse = (_status: "untrusted") => {};
    const verdict = new Promise<"untrusted">((resolve) => {
      refuse = resolve;
    });
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const transport = createHostTransport({
      hostId: HOST_ID,
      hostIdentityPublicKey: "host-key",
      bridge,
      openSignal: () => signal,
      probeTrust: () => verdict,
    });
    const settled = transport.open().catch((error: unknown) => error);
    await flush();
    signal.emit({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      scope_type: "host",
      scope_id: HOST_ID,
      protocol: "spawn.host.ctl",
      protocol_version: 2,
    });
    expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(1);
    refuse("untrusted");
    await expect(settled).resolves.toMatchObject({ code: "device_not_trusted" });
    expect(transport.state).toBe("failed");
    expect(bridge.sent.filter((message) => message.type === "close")).toHaveLength(1);
    transport.close();
  });

  test("pending endorsements cannot deliver a signature after fatal failure", async () => {
    let release = (_edges: readonly CarriedEndorsement[]) => {};
    const edges = new Promise<readonly CarriedEndorsement[]>((resolve) => {
      release = resolve;
    });
    const { bridge, signal, transport } = await readyTransport({
      loadCarriedEndorsements: () => edges,
    });
    bridge.emit({
      v: 1,
      type: "sign-request",
      requestId: "retired-signature",
      transcript: {
        signalKind: "offer",
        sessionId: "11112222-3333-4444-8888-9999aaaabbbb",
        scopeType: "host",
        scopeId: HOST_ID,
        protocolVersion: 2,
        senderRole: "browser",
        intendedPeerIdentityPublicKey: "host-key",
        sdp: "offer",
      },
    });
    signal.emitState("failed");
    release([CARRIED_EDGE]);
    await flush();
    expect(bridge.sent.filter((message) => message.type === "sign-response")).toHaveLength(0);
    expect(transport.state).toBe("failed");
    transport.close();
  });

  test("a refused prepare generation cannot fail an explicit retry", async () => {
    let refuse = (_status: "untrusted") => {};
    const verdict = new Promise<"untrusted">((resolve) => {
      refuse = resolve;
    });
    const probeTrust = jest.fn().mockReturnValueOnce(verdict).mockResolvedValue("trusted");
    const bridge = new FakeBridge();
    const first = new FakeSignal();
    const second = new FakeSignal();
    const openSignal = jest.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const transport = createHostTransport({
      hostId: HOST_ID,
      hostIdentityPublicKey: "host-key",
      bridge,
      openSignal,
      probeTrust,
    });
    const failed = transport.open().catch((error: unknown) => error);
    await flush();
    first.emitState("failed");
    await failed;
    transport.close();
    const retry = transport.open().catch((error: unknown) => error);
    await flush();
    expect(transport.state).toBe("signalling");
    refuse("untrusted");
    await flush();
    expect(transport.state).toBe("signalling");
    expect(second.listeners.size).toBe(1);
    transport.close();
    await retry;
  });

  test("a retired ICE refresh cannot change the replacement worker after retry", async () => {
    const { bridge, signal, transport } = await readyTransport();
    jest.useFakeTimers();
    let retry: Promise<unknown> | undefined;
    try {
      signal.emit({
        type: "rtc.config",
        enabled: true,
        ice_servers: [{ urls: "turn:localhost:3478", username: "1:expired", credential: "test" }],
        scope_type: "host",
        scope_id: HOST_ID,
        protocol: "spawn.host.ctl",
        protocol_version: 2,
      });
      transport.networkChanged?.();
      expect(signal.sent).toContainEqual({ type: "rtc.config.request" });
      signal.emitState("failed");
      transport.close();
      signal.state = "open";
      retry = transport.open().catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(2_001);
      expect(transport.state).toBe("connecting");
      expect(bridge.sent.filter((message) => message.type === "network-changed")).toHaveLength(0);
    } finally {
      transport.close();
      await retry;
      jest.useRealTimers();
    }
  });

  test("rejects active requests as retryable and schedules reconnect after channel loss", async () => {
    const { bridge, transport } = await readyTransport();
    jest.useFakeTimers();
    try {
      const errors: Array<{ code: string; retryable: boolean }> = [];
      transport.on("error", (error) => errors.push(error));
      const pending = transport.request("host.metrics", {});
      bridge.emit({ v: 1, type: "state", state: "reconnecting" });
      await expect(pending).rejects.toMatchObject({ code: "connection_lost" });
      expect(transport.state).toBe("reconnecting");
      expect(errors).toContainEqual({
        code: "connection_lost",
        retryable: true,
        message: expect.any(String),
      });
      transport.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("passes loaded carried endorsements in the sign response", async () => {
    const loadCarriedEndorsements = jest.fn(async () => [CARRIED_EDGE]);
    const { bridge, transport } = await readyTransport({ loadCarriedEndorsements });

    bridge.emit({
      v: 1,
      type: "sign-request",
      requestId: "sign-with-chain",
      transcript: {
        signalKind: "offer",
        protocolVersion: 2,
        sessionId: "11112222-3333-4444-8888-9999aaaabbbb",
        scopeType: "host",
        scopeId: HOST_ID,
        senderRole: "browser",
        intendedPeerIdentityPublicKey: "host-key",
        sdp: "v=0",
      },
    });
    await flush();

    expect(loadCarriedEndorsements).toHaveBeenCalledTimes(1);
    expect(bridge.sent).toContainEqual({
      v: 1,
      type: "sign-response",
      requestId: "sign-with-chain",
      signature: "signature",
      carriedEndorsements: [CARRIED_EDGE],
    });
    transport.close();
  });

  test("still sends the signature when loading carried endorsements fails", async () => {
    const loadCarriedEndorsements = jest.fn(async () => {
      throw new Error("offline");
    });
    const { bridge, transport } = await readyTransport({ loadCarriedEndorsements });

    bridge.emit({
      v: 1,
      type: "sign-request",
      requestId: "sign-without-chain",
      transcript: {
        signalKind: "offer",
        protocolVersion: 2,
        sessionId: "11112222-3333-4444-8888-9999aaaabbbb",
        scopeType: "host",
        scopeId: HOST_ID,
        senderRole: "browser",
        intendedPeerIdentityPublicKey: "host-key",
        sdp: "v=0",
      },
    });
    await flush();

    const response = bridge.sent.find(
      (message) => message.type === "sign-response" && message.requestId === "sign-without-chain",
    );
    expect(response).toEqual({
      v: 1,
      type: "sign-response",
      requestId: "sign-without-chain",
      signature: "signature",
    });
    expect(response).not.toHaveProperty("carriedEndorsements");
    transport.close();
  });

  test("accepts the bound rtc.config /ws/host actually sends", async () => {
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const { transport, settled } = openTransport(bridge, signal);
    await flush();

    // Byte-for-byte the server frame: no `binding_nonce_required` field.
    signal.emit({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      ice_transport_policy: "all",
      scope_type: "host",
      scope_id: HOST_ID,
      protocol: "spawn.host.ctl",
      protocol_version: 2,
    });
    await flush();

    expect(transport.state).toBe("connecting");
    expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(1);
    signal.emit({
      type: "rtc.config",
      enabled: true,
      ice_servers: [{ urls: "stun:refreshed.example" }],
      scope_type: "host",
      scope_id: HOST_ID,
      protocol: "spawn.host.ctl",
      protocol_version: 2,
    });
    expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(1);
    transport.close();
    await settled;
  });

  test("carries the deployment's relay-only policy through to the worker", async () => {
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const { transport, settled } = openTransport(bridge, signal);
    await flush();

    signal.emit({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      // A deployment with no direct path on offer says so here. Native used to
      // ignore this field entirely and keep hunting for one.
      ice_transport_policy: "relay",
      scope_type: "host",
      scope_id: HOST_ID,
      protocol: "spawn.host.ctl",
      protocol_version: 2,
    });
    await flush();

    const connect = bridge.sent.find((message) => message.type === "connect");
    expect(connect).toMatchObject({ iceTransportPolicy: "relay" });
    transport.close();
    await settled;
  });

  test("a server that never sends the policy still gets direct paths", async () => {
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const { transport, settled } = openTransport(bridge, signal);
    await flush();

    // An older server omits the field; that is not an instruction to relay.
    signal.emit({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      scope_type: "host",
      scope_id: HOST_ID,
      protocol: "spawn.host.ctl",
      protocol_version: 2,
    });
    await flush();

    const connect = bridge.sent.find((message) => message.type === "connect");
    expect(connect).toMatchObject({ iceTransportPolicy: "all" });
    transport.close();
    await settled;
  });

  test("rejects an rtc.config bound to another host", async () => {
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const { transport, settled } = openTransport(bridge, signal);
    await flush();

    signal.emit({
      type: "rtc.config",
      enabled: true,
      ice_servers: [],
      scope_type: "host",
      scope_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      protocol: "spawn.host.ctl",
      protocol_version: 2,
    });
    await flush();

    expect(transport.state).toBe("failed");
    expect(bridge.sent.filter((message) => message.type === "connect")).toHaveLength(0);
    expect(await settled).toMatchObject({ code: "rtc_config" });
  });
});

describe("HostTransport capabilities", () => {
  test("exposes supported operations and correlates unary requests", async () => {
    const { bridge, transport } = await readyTransport();
    expect(transport.capabilities?.limits.chunkBytes).toBe(HOST_STREAM_CHUNK_BYTES);
    expect(transport.hasCapability("fs.read")).toBe(true);

    const pending = transport.request<{ home_dir: string }>("fs.home");
    const request = await waitForRequest(bridge, "fs.home");
    respond(bridge, request, { home_dir: "/Users/me" });
    await expect(pending).resolves.toEqual({ home_dir: "/Users/me" });
    transport.close();
  });

  test("rejects an unsupported streamed operation before dispatch", async () => {
    const { bridge, transport } = await readyTransport({ capabilities: ["fs.list"] });
    await expect(transport.readFile("~/notes.txt")).rejects.toMatchObject({
      code: "unsupported_operation",
    });
    expect(hostRequests(bridge, "fs.read")).toHaveLength(0);
    transport.close();
  });

  test("refuses shared root readiness without the session transport capability", async () => {
    await expect(readyTransport({ omitCapabilities: true })).rejects.toMatchObject({
      code: "daemon_update_required",
    });
  });
});

describe("HostTransport verified reads", () => {
  test("delivers exact 8 KiB chunks, verifies SHA-256, and acknowledges pulls", async () => {
    const bytes = Uint8Array.from({ length: HOST_STREAM_CHUNK_BYTES + 1 }, (_, index) => index);
    const { bridge, transport } = await readyTransport();
    const read = await beginRead(bridge, transport, bytes);
    const reader = read.stream.getReader();

    const firstPending = reader.read();
    bridge.stream({
      version: 1,
      type: "stream.chunk",
      stream_id: read.streamId,
      sequence: 0,
      bytes_b64: encodeBridgeBytes(bytes.subarray(0, HOST_STREAM_CHUNK_BYTES)),
    });
    await expect(firstPending).resolves.toEqual({
      done: false,
      value: bytes.subarray(0, HOST_STREAM_CHUNK_BYTES),
    });

    const secondPending = reader.read();
    bridge.stream({
      version: 1,
      type: "stream.chunk",
      stream_id: read.streamId,
      sequence: 1,
      bytes_b64: encodeBridgeBytes(bytes.subarray(HOST_STREAM_CHUNK_BYTES)),
    });
    await expect(secondPending).resolves.toEqual({
      done: false,
      value: bytes.subarray(HOST_STREAM_CHUNK_BYTES),
    });
    await flush();
    bridge.stream({
      version: 1,
      type: "stream.end",
      stream_id: read.streamId,
      length: bytes.byteLength,
      sha256: digest(bytes),
    });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(hostRequests(bridge, "$host.stream.ack").map((item) => item.payload)).toEqual([
      { stream_id: "read-stream", sequence: 1 },
      { stream_id: "read-stream", sequence: 2 },
    ]);
    transport.close();
  });

  test("rejects a corrupted chunk when the final digest is verified", async () => {
    const expected = Uint8Array.of(1, 2, 3);
    const { bridge, transport } = await readyTransport();
    const read = await beginRead(bridge, transport, expected);
    const reader = read.stream.getReader();
    const first = reader.read();
    bridge.stream({
      version: 1,
      type: "stream.chunk",
      stream_id: read.streamId,
      sequence: 0,
      bytes_b64: encodeBridgeBytes(Uint8Array.of(1, 2, 4)),
    });
    await first;
    bridge.stream({
      version: 1,
      type: "stream.end",
      stream_id: read.streamId,
      length: expected.byteLength,
      sha256: digest(expected),
    });
    await expect(reader.read()).rejects.toMatchObject({ code: "hash_mismatch" });
    transport.close();
  });

  test("cancels mid-stream and authorizes only the bounded late window", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const { bridge, transport } = await readyTransport();
    const read = await beginRead(bridge, transport, bytes);
    const reader = read.stream.getReader();
    await reader.cancel("leave preview");
    expect(hostRequests(bridge, "$host.stream.cancel")).toHaveLength(1);
    transport.close();
  });

  test("enforces the inactivity timeout and 512 MiB ceiling", async () => {
    const { bridge, transport } = await readyTransport({ streamTimeoutMs: 5 });
    const read = await beginRead(bridge, transport, Uint8Array.of(1));
    await expect(read.stream.getReader().read()).rejects.toMatchObject({ code: "stream_timeout" });

    const oversized = transport.readFile("~/huge.bin");
    const request = await waitForRequest(bridge, "fs.read");
    respond(bridge, request, {
      stream_id: "huge",
      path: "/Users/me/huge.bin",
      name: "huge.bin",
      length: HOST_FILE_MAX_BYTES + 1,
      sha256: "0".repeat(64),
    });
    await expect(oversized).rejects.toMatchObject({ code: "file_too_large" });
    transport.close();
  });
});

describe("HostTransport streamed writes", () => {
  test("writes exact 8 KiB chunks and completes only after atomic commit", async () => {
    const bytes = Uint8Array.from({ length: HOST_STREAM_CHUNK_BYTES + 1 }, (_, index) => index);
    const phases: string[] = [];
    const { bridge, transport } = await readyTransport();
    const pending = transport.writeStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      {
        dir: "/Users/me",
        name: "upload.bin",
        length: bytes.byteLength,
        sha256: digest(bytes),
      },
      { onProgress: (progress) => phases.push(progress.phase) },
    );
    respond(bridge, await waitForRequest(bridge, "fs.write.begin"), {
      stream_id: "write-stream",
    });
    await waitForRequest(bridge, "$host.stream.end");
    const chunks = hostRequests(bridge, "$host.stream.chunk");
    expect(
      chunks.map((item) => {
        const payload = item.payload as Readonly<Record<string, unknown>>;
        return decodeBridgeBytes(String(payload["bytes_b64"])).length;
      }),
    ).toEqual([HOST_STREAM_CHUNK_BYTES, 1]);
    expect(phases).toContain("outcome_unknown");
    bridge.stream({
      version: 1,
      type: "stream.committed",
      stream_id: "write-stream",
      path: "/Users/me/upload.bin",
    });
    await expect(pending).resolves.toEqual({
      path: "/Users/me/upload.bin",
      length: bytes.byteLength,
      sha256: digest(bytes),
    });
    expect(phases.at(-1)).toBe("complete");
    transport.close();
  });

  test("waits for each worker acknowledgement to bound backpressure", async () => {
    const bytes = new Uint8Array(HOST_STREAM_CHUNK_BYTES * 2);
    const { bridge, transport } = await readyTransport();
    bridge.autoAcknowledgeCommands = false;
    const pending = transport.writeStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { dir: "/tmp", name: "two.bin", length: bytes.length, sha256: digest(bytes) },
    );
    respond(bridge, await waitForRequest(bridge, "fs.write.begin"), { stream_id: "bounded" });
    const first = await waitForRequest(bridge, "$host.stream.chunk");
    expect(hostRequests(bridge, "$host.stream.chunk")).toHaveLength(1);
    bridge.acknowledge(first);
    const second = (await (async () => {
      for (;;) {
        const chunks = hostRequests(bridge, "$host.stream.chunk");
        if (chunks.length === 2) return chunks[1];
        await flush();
      }
    })()) as Extract<NativeToWorkerMessage, { type: "host-request" }>;
    bridge.acknowledge(second);
    const end = await waitForRequest(bridge, "$host.stream.end");
    bridge.acknowledge(end);
    bridge.stream({
      version: 1,
      type: "stream.committed",
      stream_id: "bounded",
      path: "/tmp/two.bin",
    });
    await pending;
    transport.close();
  });

  test("cancellation before final dispatch sends cancel and never publishes an end frame", async () => {
    const controller = new AbortController();
    const bytes = new Uint8Array(HOST_STREAM_CHUNK_BYTES * 2);
    const { bridge, transport } = await readyTransport({ streamTimeoutMs: 50 });
    bridge.autoAcknowledgeCommands = false;
    const pending = transport.writeStream(
      new ReadableStream({
        start(streamController) {
          streamController.enqueue(bytes);
        },
      }),
      { dir: "/tmp", name: "partial.bin", length: bytes.length, sha256: digest(bytes) },
      { signal: controller.signal },
    );
    respond(bridge, await waitForRequest(bridge, "fs.write.begin"), { stream_id: "partial" });
    await waitForRequest(bridge, "$host.stream.chunk");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(hostRequests(bridge, "$host.stream.cancel")).toHaveLength(1);
    expect(hostRequests(bridge, "$host.stream.end")).toHaveLength(0);
    transport.close();
  });

  test("reports outcome_unknown after final dispatch times out", async () => {
    const bytes = Uint8Array.of(7);
    const { bridge, transport } = await readyTransport({ streamTimeoutMs: 5 });
    const pending = transport.writeStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { dir: "/tmp", name: "maybe.bin", length: 1, sha256: digest(bytes) },
    );
    // Observe rejection before yielding: the deliberately short timeout may
    // expire while a loaded runner is still polling for the final frame.
    const outcome = expect(pending).rejects.toMatchObject({ code: "outcome_unknown" });
    respond(bridge, await waitForRequest(bridge, "fs.write.begin"), { stream_id: "maybe" });
    await waitForRequest(bridge, "$host.stream.end");
    await outcome;
    transport.close();
  });

  test("rejects digest changes and the hard 512 MiB ceiling before final dispatch", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const { bridge, transport } = await readyTransport();
    const mismatch = transport.writeStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { dir: "/tmp", name: "bad.bin", length: 3, sha256: "0".repeat(64) },
    );
    respond(bridge, await waitForRequest(bridge, "fs.write.begin"), { stream_id: "bad" });
    await expect(mismatch).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(hostRequests(bridge, "$host.stream.end")).toHaveLength(0);

    await expect(
      transport.writeStream(new ReadableStream(), {
        dir: "/tmp",
        name: "huge.bin",
        length: HOST_FILE_MAX_BYTES + 1,
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    transport.close();
  });
});
