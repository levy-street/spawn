import type { CarriedEndorsement } from "@/data/trust/carried-endorsements";
import type { NativeToWorkerMessage, WorkerToNativeMessage } from "@/terminal/transport/bridge";
import { decodeBridgeBytes } from "@/terminal/transport/bridge";
import { createSessionTransport } from "@/terminal/transport/session-transport";
import type {
  SignalChannelLike,
  TransportError,
  TransportState,
  UploadProgress,
  WorkerEndpoint,
} from "@/terminal/transport/types";
import { SESSION_UPLOAD_CHUNK_BYTES } from "@/terminal/transport/upload";
import { terminalDark } from "@/theme";

jest.mock("@/terminal/transport/signed-signalling", () => ({
  browserIdentityWire: jest.fn(async () => "browser-key"),
  signWorkerRequest: jest.fn(async () => "signature"),
  verifyAnswerFrame: jest.fn((value: unknown) => value),
}));

jest.mock("@/lib/crypto/bootstrap", () => ({
  randomBytes: jest.fn((length: number) => new Uint8Array(length)),
}));

const CARRIED_EDGE: CarriedEndorsement = {
  account_id: "account-id",
  endorser_public_key: "endorser-key",
  endorsed_public_key: "browser-key",
  endorsed_device_id: "endorsed-device-id",
  signature: "endorsement-signature",
};

class FakeBridge implements WorkerEndpoint {
  readonly sent: NativeToWorkerMessage[] = [];
  readonly listeners = new Set<(message: WorkerToNativeMessage) => void>();

  send(message: NativeToWorkerMessage): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: WorkerToNativeMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: WorkerToNativeMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

class FakeSignal implements SignalChannelLike {
  readonly state = "open";
  readonly sent: unknown[] = [];
  readonly listeners = new Set<(frame: unknown) => void>();

  send(frame: unknown): void {
    this.sent.push(frame);
  }

  onFrame(listener: (frame: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  emit(frame: unknown): void {
    for (const listener of this.listeners) listener(frame);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => resolve()));
}

async function readyTransport(
  options: { loadCarriedEndorsements?: () => Promise<readonly CarriedEndorsement[]> } = {},
): Promise<{
  bridge: FakeBridge;
  signal: FakeSignal;
  transport: ReturnType<typeof createSessionTransport>;
}> {
  const bridge = new FakeBridge();
  const signal = new FakeSignal();
  const transport = createSessionTransport({
    sessionId: "00112233-4455-6677-8899-aabbccddeeff",
    hostIdentityPublicKey: "host-key",
    initialSize: { cols: 80, rows: 24 },
    theme: terminalDark,
    bridge,
    openSignal: () => signal,
    loadCarriedEndorsements: options.loadCarriedEndorsements ?? (async () => []),
  });
  const opening = transport.open();
  await flush();
  signal.emit({
    type: "rtc.config",
    enabled: true,
    binding_nonce_required: true,
    ice_servers: [],
  });
  for (const gate of ["bindingAccepted", "ptyOpen", "ctlOpen", "daemonReady", "historyReady"]) {
    bridge.emit({ v: 1, type: "state", state: "connecting", gate });
  }
  await opening;
  return { bridge, signal, transport };
}

describe("SessionTransport", () => {
  test("relays the terminal's own relay-only policy to the worker", async () => {
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const transport = createSessionTransport({
      sessionId: "00112233-4455-6677-8899-aabbccddeeff",
      hostIdentityPublicKey: "host-key",
      initialSize: { cols: 80, rows: 24 },
      theme: terminalDark,
      bridge,
      openSignal: () => signal,
      loadCarriedEndorsements: async () => [],
    });
    // Never becomes ready here: this test only cares what the worker is told
    // at connect time, so the open promise is expected to reject on close.
    const opening = transport.open().catch(() => undefined);
    await flush();

    // The session channel is the one that carries the terminal, and it was the
    // one channel never told whether a direct path exists.
    signal.emit({
      type: "rtc.config",
      enabled: true,
      binding_nonce_required: true,
      ice_servers: [],
      ice_transport_policy: "relay",
    });
    await flush();

    const connect = bridge.sent.find((message) => message.type === "connect");
    expect(connect).toMatchObject({ iceTransportPolicy: "relay" });
    transport.close();
    await opening;
  });

  test("initializes the worker, relays signalling, and signs worker requests", async () => {
    const { bridge, signal, transport } = await readyTransport();
    expect(bridge.sent[0]).toMatchObject({
      type: "init",
      mode: "session",
      browserIdentityPublicKey: "browser-key",
    });
    expect(bridge.sent).toContainEqual(
      expect.objectContaining({ type: "connect", forceRelay: false }),
    );

    bridge.emit({
      v: 1,
      type: "signal-frame",
      frame: { type: "rtc.offer", signed_envelope: "signed" },
    });
    expect(signal.sent).toContainEqual({ type: "rtc.offer", signed_envelope: "signed" });

    bridge.emit({
      v: 1,
      type: "sign-request",
      requestId: "sign-1",
      transcript: {
        signalKind: "offer",
        protocolVersion: 2,
        sessionId: "11112222-3333-4444-8888-9999aaaabbbb",
        scopeType: "session",
        scopeId: "00112233-4455-6677-8899-aabbccddeeff",
        senderRole: "browser",
        intendedPeerIdentityPublicKey: "host-key",
        sdp: "v=0",
      },
    });
    await flush();
    expect(bridge.sent).toContainEqual({
      v: 1,
      type: "sign-response",
      requestId: "sign-1",
      signature: "signature",
    });
    transport.close();
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
        scopeType: "session",
        scopeId: "00112233-4455-6677-8899-aabbccddeeff",
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
        scopeType: "session",
        scopeId: "00112233-4455-6677-8899-aabbccddeeff",
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

  test("buffers premature stdin and splits every large write at 64 KiB", async () => {
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const transport = createSessionTransport({
      sessionId: "00112233-4455-6677-8899-aabbccddeeff",
      hostIdentityPublicKey: "host-key",
      initialSize: { cols: 80, rows: 24 },
      theme: terminalDark,
      bridge,
      openSignal: () => signal,
    });
    const opening = transport.open();
    await flush();
    transport.write(new Uint8Array([1, 2, 3]));
    expect(bridge.sent.some((message) => message.type === "input")).toBe(false);
    signal.emit({
      type: "rtc.config",
      enabled: true,
      binding_nonce_required: true,
      ice_servers: [],
    });
    for (const gate of ["bindingAccepted", "ptyOpen", "ctlOpen", "daemonReady", "historyReady"]) {
      bridge.emit({ v: 1, type: "state", state: "connecting", gate });
    }
    await opening;
    const firstInput = bridge.sent.find((message) => message.type === "input");
    expect(firstInput?.type === "input" ? decodeBridgeBytes(firstInput.data) : null).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    transport.write(new Uint8Array(64 * 1024 * 2 + 1));
    const lengths = bridge.sent
      .filter(
        (message): message is Extract<NativeToWorkerMessage, { type: "input" }> =>
          message.type === "input",
      )
      .slice(1)
      .map((message) => decodeBridgeBytes(message.data).byteLength);
    expect(lengths).toEqual([64 * 1024, 64 * 1024, 1]);
    transport.close();
  });

  test("streams resumable 48 KiB upload chunks and persists before final dispatch", async () => {
    const { bridge, transport } = await readyTransport();
    const beforeFinalDispatch = jest.fn(async () => undefined);
    const progress: UploadProgress[] = [];
    const totalBytes = SESSION_UPLOAD_CHUNK_BYTES + 1;
    const handle = transport.upload({
      uploadId: "11112222-3333-4444-8888-9999aaaabbbb",
      name: "notes.txt",
      mimeType: "text/plain",
      destination: "cwd",
      totalBytes,
      sha256: "a".repeat(64),
      source: {
        size: totalBytes,
        read: async (_offset, length) => new Uint8Array(length).fill(7),
      },
      beforeFinalDispatch,
    });
    handle.onProgress((value) => progress.push(value));
    expect(bridge.sent).toContainEqual(
      expect.objectContaining({ type: "upload-start", uploadId: handle.uploadId }),
    );

    bridge.emit({
      v: 1,
      type: "upload-progress",
      uploadId: handle.uploadId,
      state: "uploading",
      sentBytes: 0,
      totalBytes,
      nextSequence: 0,
    });
    await flush();
    const chunks = (): Array<Extract<NativeToWorkerMessage, { type: "upload-chunk" }>> =>
      bridge.sent.filter(
        (message): message is Extract<NativeToWorkerMessage, { type: "upload-chunk" }> =>
          message.type === "upload-chunk",
      );
    expect(decodeBridgeBytes(chunks()[0]?.data ?? "").byteLength).toBe(SESSION_UPLOAD_CHUNK_BYTES);
    expect(beforeFinalDispatch).not.toHaveBeenCalled();

    bridge.emit({
      v: 1,
      type: "upload-progress",
      uploadId: handle.uploadId,
      state: "uploading",
      sentBytes: SESSION_UPLOAD_CHUNK_BYTES,
      totalBytes,
      nextSequence: 1,
    });
    await flush();
    expect(beforeFinalDispatch).toHaveBeenCalledTimes(1);
    expect(chunks()[1]).toMatchObject({ sequence: 1, last: true });

    bridge.emit({
      v: 1,
      type: "upload-progress",
      uploadId: handle.uploadId,
      state: "outcome_unknown",
      sentBytes: totalBytes,
      totalBytes,
    });
    bridge.emit({
      v: 1,
      type: "upload-progress",
      uploadId: handle.uploadId,
      state: "complete",
      sentBytes: totalBytes,
      totalBytes,
      path: "/tmp/notes.txt",
      sha256: "a".repeat(64),
    });
    await expect(handle.result).resolves.toEqual({
      uploadId: handle.uploadId,
      path: "/tmp/notes.txt",
      totalBytes,
      sha256: "a".repeat(64),
    });
    expect(progress.some((value) => value.state === "outcome_unknown")).toBe(true);
    transport.close();
  });
});

describe("SessionTransport connect failures", () => {
  test("names an unapproved device instead of waiting out the watchdog", async () => {
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const errors: TransportError[] = [];
    const states: TransportState[] = [];
    const transport = createSessionTransport({
      sessionId: "00112233-4455-6677-8899-aabbccddeeff",
      hostIdentityPublicKey: "host-key",
      initialSize: { cols: 80, rows: 24 },
      theme: terminalDark,
      bridge,
      openSignal: () => signal,
      hostId: "b3ae000c-1da3-4c6c-aeda-23a37ecb01ac",
      probeTrust: async () => "untrusted",
    });
    transport.on("error", (error) => errors.push(error));
    transport.on("state", (state) => states.push(state));
    // The rejection carries the code too: a caller that rewraps the rejection
    // must still be able to tell a trust failure from a network one.
    await expect(transport.open()).rejects.toMatchObject({
      code: "device_not_trusted",
      message: expect.stringMatching(/has not approved this device/i),
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ code: "device_not_trusted", retryable: false }),
    );
    expect(states).toContain("failed");
    transport.close();
  });

  test("fails a stalled connect on the watchdog rather than spinning forever", async () => {
    jest.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      const signal = new FakeSignal();
      const errors: TransportError[] = [];
      const transport = createSessionTransport({
        sessionId: "00112233-4455-6677-8899-aabbccddeeff",
        hostIdentityPublicKey: "host-key",
        initialSize: { cols: 80, rows: 24 },
        theme: terminalDark,
        bridge,
        openSignal: () => signal,
        connectTimeoutMs: 1_000,
      });
      transport.on("error", (error) => errors.push(error));
      const opening = transport.open().catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      signal.emit({
        type: "rtc.config",
        enabled: true,
        binding_nonce_required: true,
        ice_servers: [],
      });
      expect(transport.state).toBe("connecting");
      jest.advanceTimersByTime(1_000);
      await opening;
      expect(transport.state).toBe("failed");
      expect(errors).toContainEqual(
        expect.objectContaining({ code: "connect_timeout", retryable: false }),
      );
      transport.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("clears the watchdog once the session is ready", async () => {
    jest.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      const signal = new FakeSignal();
      const errors: TransportError[] = [];
      const transport = createSessionTransport({
        sessionId: "00112233-4455-6677-8899-aabbccddeeff",
        hostIdentityPublicKey: "host-key",
        initialSize: { cols: 80, rows: 24 },
        theme: terminalDark,
        bridge,
        openSignal: () => signal,
        connectTimeoutMs: 1_000,
      });
      transport.on("error", (error) => errors.push(error));
      const opening = transport.open();
      await Promise.resolve();
      await Promise.resolve();
      signal.emit({
        type: "rtc.config",
        enabled: true,
        binding_nonce_required: true,
        ice_servers: [],
      });
      for (const gate of ["bindingAccepted", "ptyOpen", "ctlOpen", "daemonReady", "historyReady"]) {
        bridge.emit({ v: 1, type: "state", state: "connecting", gate });
      }
      await opening;
      jest.advanceTimersByTime(10_000);
      expect(transport.state).toBe("ready");
      expect(errors).toEqual([]);
      transport.close();
    } finally {
      jest.useRealTimers();
    }
  });
});
