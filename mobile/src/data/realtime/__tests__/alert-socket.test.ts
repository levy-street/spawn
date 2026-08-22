import { ALERT_PROTOCOL, AlertSocketClient, parseAlertFrame } from "@/data/realtime/alert-socket";

class FakeWebSocket {
  readonly protocol = ALERT_PROTOCOL;
  readyState = 0;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

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
      () => "wss://spawn.test/ws/alerts?token=redacted",
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
});
