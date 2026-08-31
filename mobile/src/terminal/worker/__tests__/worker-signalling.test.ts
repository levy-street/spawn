import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

/**
 * Drives the bundled signalling modules the way the two servers actually speak.
 * /ws/host mints its own binding nonce and never discloses it, and has no
 * binding generation at all; /ws/browser echoes the browser's nonce and a
 * generation on every frame. A worker that applies the session rules to a host
 * drops every daemon frame and hangs in `connecting`.
 */

const HOST_ID = "00112233-4455-6677-8899-aabbccddeeff";
const SESSION_ID = "99887766-5544-3322-1100-ffeeddccbbaa";
const RTC_SESSION_ID = "rtc-session";
const CLIENT_NONCE = "0123456789abcdef0123456789abcdef";
const SERVER_NONCE = "fedcba9876543210fedcba9876543210";
const HOST_KEY = "host-key";
const CARRIED_EDGE = {
  account_id: "account-id",
  endorser_public_key: "endorser-key",
  endorsed_public_key: "browser-key",
  endorsed_device_id: "endorsed-device-id",
  signature: "endorsement-signature",
};

function moduleSource(marker: string): string {
  const markerIndex = TERMINAL_WORKER_HTML.indexOf(marker);
  const start = TERMINAL_WORKER_HTML.lastIndexOf("(() => {", markerIndex);
  const end = TERMINAL_WORKER_HTML.indexOf("\n})();", markerIndex) + "\n})();".length;
  if (markerIndex < 0 || start < 0 || end < start)
    throw new Error(`Missing worker module: ${marker}`);
  return TERMINAL_WORKER_HTML.slice(start, end);
}

const TRANSPORT_SOURCE = moduleSource("const CHANNEL_OPTIONS = Object.freeze({ ordered: true })");
const HOST_SOURCE = moduleSource("const host = { binding: false, channel: false, hello: false }");

interface FakeChannel {
  label: string;
  readyState: string;
  bufferedAmount: number;
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send: jest.Mock;
  close: jest.Mock;
}

class FakePeerConnection {
  static last: FakePeerConnection | null = null;
  readonly channels: FakeChannel[] = [];
  readonly addedCandidates: unknown[] = [];
  remoteDescription: unknown = null;
  connectionState = "new";
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly offerOptions: unknown[] = [];
  readonly setConfiguration = jest.fn();
  readonly restartIce = jest.fn();
  readonly getStats = jest.fn(
    async () =>
      new Map([
        [
          "pair",
          {
            id: "pair",
            type: "candidate-pair",
            state: "succeeded",
            nominated: true,
            localCandidateId: "local",
            remoteCandidateId: "remote",
            currentRoundTripTime: 0.042,
          },
        ],
        ["local", { id: "local", type: "local-candidate", candidateType: "relay" }],
        ["remote", { id: "remote", type: "remote-candidate", candidateType: "host" }],
      ]),
  );

  constructor(readonly config: unknown) {
    FakePeerConnection.last = this;
  }

  createDataChannel(label: string): FakeChannel {
    const channel: FakeChannel = {
      label,
      readyState: "connecting",
      bufferedAmount: 0,
      binaryType: "blob",
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: jest.fn(),
      close: jest.fn(),
    };
    this.channels.push(channel);
    return channel;
  }

  createOffer(options?: unknown): Promise<{ type: string; sdp: string }> {
    this.offerOptions.push(options);
    return Promise.resolve({ type: "offer", sdp: "v=0\r\nlocal-offer" });
  }

  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }

  setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  addIceCandidate(candidate: unknown): Promise<void> {
    this.addedCandidates.push(candidate);
    return Promise.resolve();
  }

  close(): void {
    this.connectionState = "closed";
  }
}

interface Harness {
  state: Record<string, unknown>;
  post: jest.Mock;
  error: jest.Mock;
  decodeBase64(value: string): Uint8Array;
  handleTransportMessage?: (message: Record<string, unknown>) => Promise<void>;
  receiveHostCtl?: (value: unknown) => void;
  sessionGate?: jest.Mock;
  sessionChannelOpened?: jest.Mock;
  resetSessionGeneration?: jest.Mock;
}

function createHarness(mode: "host" | "session"): Harness {
  const harness: Harness = {
    state: {
      mode,
      scopeId: mode === "host" ? HOST_ID : SESSION_ID,
      browserKey: "browser-key",
      hostKey: HOST_KEY,
      pc: null,
      pty: null,
      ctl: null,
      rtcSessionId: null,
      bindingNonce: null,
      bindingGeneration: null,
      offerSent: false,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
      pendingSign: new Map(),
      disconnectTimer: null,
      stopped: false,
    },
    post: jest.fn(),
    error: jest.fn(),
    decodeBase64: () => Uint8Array.of(1),
    sessionGate: jest.fn(),
    sessionChannelOpened: jest.fn(),
    resetSessionGeneration: jest.fn(),
  };
  const root = globalThis as unknown as {
    spawnWorker?: Harness;
    RTCPeerConnection?: unknown;
  };
  root.spawnWorker = harness;
  root.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.last = null;
  new Function(TRANSPORT_SOURCE)();
  if (mode === "host") new Function(HOST_SOURCE)();
  return harness;
}

function posted(harness: Harness, type: string): Record<string, unknown>[] {
  return harness.post.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message["type"] === type);
}

function emittedFrames(harness: Harness, frameType: string): Record<string, unknown>[] {
  return posted(harness, "signal-frame")
    .map((message) => message["frame"] as Record<string, unknown>)
    .filter((frame) => frame["type"] === frameType);
}

/** Everything /ws/host puts on a server→browser frame, and nothing more. */
function hostFrame(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: RTC_SESSION_ID,
    binding_nonce: SERVER_NONCE,
    scope_type: "host",
    scope_id: HOST_ID,
    protocol: "spawn.host.ctl",
    protocol_version: 1,
    ...extra,
  };
}

async function connect(harness: Harness): Promise<void> {
  await harness.handleTransportMessage?.({
    type: "connect",
    rtcSessionId: RTC_SESSION_ID,
    bindingNonce: CLIENT_NONCE,
    iceServers: [],
    forceRelay: false,
  });
}

async function signOffer(
  harness: Harness,
  carriedEndorsements?: readonly Record<string, string>[],
): Promise<void> {
  const request = posted(harness, "sign-request").at(-1);
  await harness.handleTransportMessage?.({
    type: "sign-response",
    requestId: request?.["requestId"],
    signature: "signature",
    ...(carriedEndorsements === undefined ? {} : { carriedEndorsements }),
  });
}

function answerFrame(): Record<string, unknown> {
  return hostFrame({
    type: "rtc.answer",
    signed_envelope: JSON.stringify({
      sender_identity_public_key: HOST_KEY,
      sdp: "v=0\r\nremote-answer",
    }),
  });
}

afterEach(() => {
  const root = globalThis as unknown as { spawnWorker?: Harness; RTCPeerConnection?: unknown };
  delete root.spawnWorker;
  delete root.RTCPeerConnection;
});

describe("host-scoped signalling", () => {
  test("carries endorsements on the outer offer only", async () => {
    const harness = createHarness("host");
    await connect(harness);
    await signOffer(harness, [CARRIED_EDGE]);

    const offer = emittedFrames(harness, "rtc.offer")[0];
    expect(offer?.["carried_endorsements"]).toEqual([CARRIED_EDGE]);
    expect(JSON.parse(String(offer?.["signed_envelope"]))).not.toHaveProperty(
      "carried_endorsements",
    );
  });

  test("omits carried_endorsements when the sign response has none", async () => {
    const harness = createHarness("host");
    await connect(harness);
    await signOffer(harness);

    expect(emittedFrames(harness, "rtc.offer")[0]).not.toHaveProperty("carried_endorsements");
  });

  test("accepts daemon frames carrying the server's own binding nonce", async () => {
    const harness = createHarness("host");
    await connect(harness);
    await signOffer(harness);

    await harness.handleTransportMessage?.({ type: "signal-frame", frame: answerFrame() });

    expect(FakePeerConnection.last?.remoteDescription).toEqual({
      type: "answer",
      sdp: "v=0\r\nremote-answer",
    });
  });

  test("reaches ready without a binding status the host channel never sends", async () => {
    const harness = createHarness("host");
    await connect(harness);
    await signOffer(harness);
    await harness.handleTransportMessage?.({ type: "signal-frame", frame: answerFrame() });

    const channel = FakePeerConnection.last?.channels[0];
    expect(channel?.label).toBe("spawn.host.ctl");
    channel?.onopen?.();
    harness.receiveHostCtl?.(
      JSON.stringify({
        version: 1,
        type: "hello",
        protocol: "spawn.host.ctl",
        capabilities: ["fs.home"],
        limits: {},
      }),
    );

    expect(posted(harness, "state")).toContainEqual({ type: "state", state: "ready" });
  });

  test("holds candidates until the signed offer is on the wire, then flushes", async () => {
    const harness = createHarness("host");
    await connect(harness);

    const pc = FakePeerConnection.last;
    pc?.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "early" }) } });
    expect(emittedFrames(harness, "rtc.candidate")).toHaveLength(0);

    await signOffer(harness);
    expect(emittedFrames(harness, "rtc.offer")).toHaveLength(1);
    expect(emittedFrames(harness, "rtc.candidate")).toHaveLength(1);

    pc?.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "late" }) } });
    expect(emittedFrames(harness, "rtc.candidate")).toHaveLength(2);
  });

  test("surfaces an unavailable status that carries no binding fields at all", async () => {
    const harness = createHarness("host");
    await connect(harness);
    await signOffer(harness);

    await harness.handleTransportMessage?.({
      type: "signal-frame",
      frame: {
        type: "rtc.status",
        session_id: RTC_SESSION_ID,
        scope_type: "host",
        scope_id: HOST_ID,
        protocol: "spawn.host.ctl",
        protocol_version: 1,
        status: "unavailable",
      },
    });

    expect(harness.error).toHaveBeenCalledWith("channel_closed", expect.any(String), true);
  });

  test("still rejects a frame bound to a different host session", async () => {
    const harness = createHarness("host");
    await connect(harness);
    await signOffer(harness);

    await harness.handleTransportMessage?.({
      type: "signal-frame",
      frame: { ...answerFrame(), session_id: "someone-elses-session" },
    });

    expect(FakePeerConnection.last?.remoteDescription).toBeNull();
  });
});

describe("session-scoped signalling", () => {
  test("reports selected path and RTT every five seconds while connected", async () => {
    jest.useFakeTimers();
    const harness = createHarness("session");
    try {
      await connect(harness);
      const pc = FakePeerConnection.last;
      if (pc) pc.connectionState = "connected";
      pc?.onconnectionstatechange?.();

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(posted(harness, "connection-info")).toContainEqual({
        type: "connection-info",
        info: { kind: "relay", rttMs: 42 },
      });
      await harness.handleTransportMessage?.({ type: "close" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("restarts ICE on the same binding after a network change", async () => {
    const harness = createHarness("session");
    await connect(harness);
    await signOffer(harness);
    const pc = FakePeerConnection.last;

    await harness.handleTransportMessage?.({
      type: "network-changed",
      iceServers: [{ urls: "stun:refreshed.example" }],
      iceTransportPolicy: "all",
    });
    await signOffer(harness);

    expect(pc?.setConfiguration).toHaveBeenCalledWith({
      iceServers: [{ urls: "stun:refreshed.example" }],
      iceTransportPolicy: "all",
    });
    expect(pc?.restartIce).toHaveBeenCalledTimes(1);
    expect(pc?.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(emittedFrames(harness, "rtc.offer").at(-1)).toMatchObject({
      session_id: RTC_SESSION_ID,
      binding_nonce: CLIENT_NONCE,
      ice_restart: true,
    });
    await harness.handleTransportMessage?.({ type: "close" });
  });

  test("supersedes a pending restart with the latest network configuration", async () => {
    const harness = createHarness("session");
    await connect(harness);
    await signOffer(harness);
    const pc = FakePeerConnection.last;

    await harness.handleTransportMessage?.({
      type: "network-changed",
      iceServers: [{ urls: "stun:first-network.example" }],
      iceTransportPolicy: "all",
    });
    await harness.handleTransportMessage?.({
      type: "network-changed",
      iceServers: [{ urls: "turn:latest-network.example" }],
      iceTransportPolicy: "relay",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(pc?.restartIce).toHaveBeenCalledTimes(2);
    expect(pc?.setConfiguration).toHaveBeenLastCalledWith({
      iceServers: [{ urls: "turn:latest-network.example" }],
      iceTransportPolicy: "relay",
    });
    expect(pc?.offerOptions.slice(-2)).toEqual([{ iceRestart: true }, { iceRestart: true }]);
    await harness.handleTransportMessage?.({ type: "close" });
  });

  test("carries endorsements on the outer offer only", async () => {
    const harness = createHarness("session");
    await connect(harness);
    await signOffer(harness, [CARRIED_EDGE]);

    const offer = emittedFrames(harness, "rtc.offer")[0];
    expect(offer?.["carried_endorsements"]).toEqual([CARRIED_EDGE]);
    expect(JSON.parse(String(offer?.["signed_envelope"]))).not.toHaveProperty(
      "carried_endorsements",
    );
  });

  test("omits carried_endorsements when the sign response has none", async () => {
    const harness = createHarness("session");
    await connect(harness);
    await signOffer(harness);

    expect(emittedFrames(harness, "rtc.offer")[0]).not.toHaveProperty("carried_endorsements");
  });

  test("keeps the nonce match and generation gate the session channel provides", async () => {
    const harness = createHarness("session");
    await connect(harness);
    await signOffer(harness);

    const pc = FakePeerConnection.last;
    pc?.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "queued" }) } });
    expect(emittedFrames(harness, "rtc.candidate")).toHaveLength(0);

    const status = {
      type: "rtc.status",
      session_id: RTC_SESSION_ID,
      scope_type: "session",
      scope_id: SESSION_ID,
      protocol: "spawn.pty",
      protocol_version: 2,
      status: "negotiating",
      binding_generation: 7,
    };
    // A session frame without the browser's own nonce is not ours.
    await harness.handleTransportMessage?.({
      type: "signal-frame",
      frame: { ...status, binding_nonce: SERVER_NONCE },
    });
    expect(harness.sessionGate).not.toHaveBeenCalled();

    await harness.handleTransportMessage?.({
      type: "signal-frame",
      frame: { ...status, binding_nonce: CLIENT_NONCE },
    });
    expect(harness.sessionGate).toHaveBeenCalledWith("bindingAccepted");
    const candidates = emittedFrames(harness, "rtc.candidate");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.["binding_generation"]).toBe(7);
  });
});
