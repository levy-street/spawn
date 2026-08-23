import { FakeWebSocket, installFakeWebSocket } from "../fake-socket";

describe("FakeWebSocket", () => {
  it("drives open, message, send, and close without a network connection", () => {
    const installation = installFakeWebSocket();

    try {
      const socket = new WebSocket("wss://spawn.test/ws", "spawn.v3");
      const received: unknown[] = [];
      socket.onmessage = (event) => received.push(event.data);
      const fake = installation.instances[0];

      expect(fake).toBeDefined();
      fake?.open();
      socket.send('{"type":"offer"}');
      fake?.message('{"type":"answer"}');
      socket.close(1000, "done");

      expect(fake?.sent).toEqual(['{"type":"offer"}']);
      expect(received).toEqual(['{"type":"answer"}']);
      expect(fake?.closeCalls).toEqual([{ code: 1000, reason: "done" }]);
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    } finally {
      installation.restore();
    }
  });

  it("rejects sends before the server opens the connection", () => {
    const socket = new FakeWebSocket("wss://spawn.test/ws", "spawn.v3");
    expect(() => socket.send("premature")).toThrow("FakeWebSocket is not open");
  });
});
