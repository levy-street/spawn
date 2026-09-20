import { ALERT_PROTOCOL, AlertSocketClient, parseAlertFrame } from "@/data/realtime/alert-socket";

jest.mock("@/data/api/auth-token", () => ({
  authToken: {
    snapshot: jest.fn(async () => ({
      baseUrl: "https://spawn.test",
      token: "secret-token",
      revision: 0,
      identity: 0,
    })),
  },
}));

class FakeWebSocket {
  readonly protocol = ALERT_PROTOCOL;
  readonly url: string;
  readonly options: { headers: Record<string, string> } | undefined;
  readyState = 0;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  constructor(
    url = "wss://spawn.test/ws/alerts",
    _protocol = ALERT_PROTOCOL,
    options?: { headers: Record<string, string> },
  ) {
    this.url = url;
    this.options = options;
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

  send(): void {}

  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.call(
      this as unknown as WebSocket,
      { code } as Parameters<NonNullable<WebSocket["onclose"]>>[0],
    );
  }
}

describe("parseAlertFrame", () => {
  it.each([
    [
      "agent finished",
      {
        type: "alert",
        event: "agent.finished",
        session_id: "session-1",
        command: "codex",
        at: "2026-08-22T03:12:01Z",
      },
    ],
    [
      "agent awaiting input",
      {
        type: "alert",
        event: "agent.awaiting_input",
        session_id: "session-2",
        command: "claude",
        at: "2026-08-22T03:12:09Z",
      },
    ],
    [
      "session died",
      {
        type: "alert",
        event: "session.died",
        session_id: "session-3",
        command: null,
        exit_code: 137,
        signal: "KILL",
        at: "2026-08-22T03:12:10Z",
      },
    ],
  ])("parses %s", (_label, input) => {
    expect(parseAlertFrame(JSON.stringify(input))).toMatchObject(input);
  });

  it("parses a data-changed frame and refuses one it could not act on", () => {
    expect(
      parseAlertFrame(
        JSON.stringify({
          type: "data",
          resource: "workspaces",
          id: "w-1",
          origin: "tab-1",
          at: "2026-08-31T00:00:00Z",
        }),
      ),
    ).toEqual({
      type: "data",
      resource: "workspaces",
      id: "w-1",
      origin: "tab-1",
      at: "2026-08-31T00:00:00Z",
    });
    expect(
      parseAlertFrame(JSON.stringify({ type: "data", resource: "sessions", id: null })),
    ).toMatchObject({ type: "data", resource: "sessions", id: null, origin: null });
    for (const bad of [
      { type: "data" },
      { type: "data", resource: "" },
      { type: "data", resource: 7 },
      { type: "data", resource: "x".repeat(65) },
      { type: "data", resource: "workspaces", id: 9 },
      { type: "data", resource: "workspaces", origin: "x".repeat(65) },
    ]) {
      expect(parseAlertFrame(JSON.stringify(bad))).toBeNull();
    }
  });

  it("parses keepalive and protocol rejection frames", () => {
    expect(parseAlertFrame('{"type":"alerts.ping"}')).toEqual({ type: "alerts.ping" });
    expect(
      parseAlertFrame({ type: "protocol.required", protocol: ALERT_PROTOCOL, version: 1 }),
    ).toEqual({ type: "protocol.required", protocol: ALERT_PROTOCOL, version: 1 });
  });

  it.each([
    "not-json",
    null,
    { type: "alert", event: "unknown", session_id: "s" },
    { type: "alert", event: "agent.finished", session_id: "" },
    { type: "alert", event: "agent.finished", session_id: "s", command: 3 },
    { type: "alert", event: "agent.finished", session_id: "s", command: "x".repeat(65) },
    { type: "protocol.required", protocol: "wrong", version: 1 },
  ])("returns null for malformed input %#", (input) => {
    expect(() => parseAlertFrame(input)).not.toThrow();
    expect(parseAlertFrame(input)).toBeNull();
  });

  it("parses a device-approval knock and its answer", () => {
    expect(
      parseAlertFrame({
        type: "trust",
        event: "device.approval_requested",
        request_id: "req-1",
        browser_device_id: "dev-1",
        label: "iPhone",
        fingerprint: "SHA256:abcdefghijklmnop",
        at: "2026-08-23T00:00:00Z",
      }),
    ).toEqual({
      type: "trust",
      event: "device.approval_requested",
      request_id: "req-1",
      browser_device_id: "dev-1",
      label: "iPhone",
      fingerprint: "SHA256:abcdefghijklmnop",
      status: null,
      at: "2026-08-23T00:00:00Z",
    });
    expect(
      parseAlertFrame({
        type: "trust",
        event: "device.approval_resolved",
        request_id: "req-1",
        browser_device_id: "dev-1",
        status: "approved",
      }),
    ).toMatchObject({ event: "device.approval_resolved", status: "approved" });
  });

  it("parses a host pin delivery failure", () => {
    expect(
      parseAlertFrame({
        type: "trust",
        event: "host.pin_undelivered",
        host_id: "host-1",
        browser_device_id: "device-1",
        reason: "invalid_chain",
      }),
    ).toEqual({
      type: "trust",
      event: "host.pin_undelivered",
      host_id: "host-1",
      browser_device_id: "device-1",
      reason: "invalid_chain",
    });
  });

  it.each([
    { type: "trust", event: "device.exfiltrated", request_id: "r", browser_device_id: "d" },
    { type: "trust", event: "device.approval_requested", request_id: "", browser_device_id: "d" },
    { type: "trust", event: "device.approval_requested", request_id: "r" },
  ])("returns null for a malformed trust frame %#", (input) => {
    expect(parseAlertFrame(input)).toBeNull();
  });

  it("drops a status a client would not know how to act on", () => {
    expect(
      parseAlertFrame({
        type: "trust",
        event: "device.approval_resolved",
        request_id: "req-1",
        browser_device_id: "dev-1",
        status: "elevated",
      }),
    ).toMatchObject({ status: null });
  });

  it("preserves web parity by normalizing invalid optional fields", () => {
    expect(
      parseAlertFrame({
        type: "alert",
        event: "session.died",
        session_id: "session-1",
        exit_code: "bad",
        signal: 9,
      }),
    ).toEqual({
      type: "alert",
      event: "session.died",
      session_id: "session-1",
      command: null,
      exit_code: null,
      signal: null,
      at: "",
    });
  });
});

describe("AlertSocketClient", () => {
  it("delivers only valid alert frames and isolates malformed input", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new AlertSocketClient(
      () => "wss://spawn.test/ws/alerts",
      () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );
    const alerts: string[] = [];
    const frames: string[] = [];
    client.onAlert((alert) => alerts.push(alert.event));
    client.onFrame((frame) => frames.push(frame.type));

    client.connect();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.message("malformed");
    sockets[0]?.message('{"type":"alerts.ping"}');
    sockets[0]?.message(
      '{"type":"alert","event":"agent.finished","session_id":"s","command":"codex","at":"now"}',
    );

    expect(frames).toEqual(["alerts.ping", "alert"]);
    expect(alerts).toEqual(["agent.finished"]);
    client.close();
  });

  it("uses the bearer header on the production alert socket", async () => {
    const original = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];
    class CapturingWebSocket extends FakeWebSocket {
      constructor(url: string, protocol: string, options?: { headers: Record<string, string> }) {
        super(url, protocol, options);
        sockets.push(this);
      }
    }
    globalThis.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;
    const client = new AlertSocketClient(() => "wss://spawn.test/ws/alerts");
    try {
      client.connect();
      await Promise.resolve();
      await Promise.resolve();
      expect(sockets[0]?.url).toBe("wss://spawn.test/ws/alerts");
      expect(sockets[0]?.options).toEqual({
        headers: { Authorization: "Bearer secret-token" },
      });
    } finally {
      client.close();
      globalThis.WebSocket = original;
    }
  });
});
