import {
  BridgeProtocolError,
  decodeBridgeBytes,
  encodeBridgeBytes,
  parseNativeMessage,
  parseWorkerMessage,
  serializeNativeMessage,
  serializeWorkerMessage,
  TERMINAL_BRIDGE_VERSION,
  WorkerBridge,
  WorkerEventCoalescer,
} from "@/terminal/transport/bridge";

describe("terminal worker bridge", () => {
  test("a loading document cannot receive commands until its own load completes", async () => {
    const bridge = new WorkerBridge();
    const sender = jest.fn();
    const detach = bridge.attach(sender, false);
    const ready = jest.fn();
    const waiting = bridge.whenReady().then(ready);
    bridge.setReady(jest.fn(), true);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(() => bridge.send({ v: 1, type: "close" })).toThrow("not ready");
    expect(sender).not.toHaveBeenCalled();
    bridge.setReady(sender, true);
    await waiting;
    bridge.send({ v: 1, type: "close" });
    expect(sender).toHaveBeenCalledTimes(1);
    detach();
  });

  test("document retirement rejects waiters and stale owners cannot activate a replacement", async () => {
    const bridge = new WorkerBridge();
    const outgoing = jest.fn();
    const incoming = jest.fn();
    const detachOld = bridge.attach(outgoing, false);
    const retired = bridge.whenReady().catch((error: unknown) => error);
    const detachNew = bridge.attach(incoming, false);
    expect(await retired).toEqual(new BridgeProtocolError("Terminal worker document was retired."));
    const ready = jest.fn();
    const waiting = bridge.whenReady().then(ready);
    detachOld();
    bridge.setReady(outgoing, true);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    bridge.setReady(incoming, true);
    await waiting;
    bridge.setReady(incoming, false);
    const reloading = bridge.whenReady().catch((error: unknown) => error);
    detachNew();
    expect(await reloading).toEqual(
      new BridgeProtocolError("Terminal worker document was retired."),
    );
  });

  test("serializes and parses messages in both directions", () => {
    const native = { v: TERMINAL_BRIDGE_VERSION, type: "focus" } as const;
    const worker = { v: TERMINAL_BRIDGE_VERSION, type: "title", title: "shell" } as const;
    expect(parseNativeMessage(serializeNativeMessage(native))).toEqual(native);
    expect(parseWorkerMessage(serializeWorkerMessage(worker))).toEqual(worker);
  });

  test("rejects malformed, unknown, and mismatched versions loudly", () => {
    expect(() => parseWorkerMessage("not-json")).toThrow(BridgeProtocolError);
    expect(() => parseWorkerMessage(JSON.stringify({ v: 2, type: "ready" }))).toThrow(
      "Unsupported worker bridge version",
    );
    expect(() => parseWorkerMessage(JSON.stringify({ v: 1, type: "surprise" }))).toThrow(
      "Unknown worker bridge message",
    );
  });

  test("base64 round-trips every byte value and rejects noncanonical input", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decodeBridgeBytes(encodeBridgeBytes(bytes))).toEqual(bytes);
    expect(() => decodeBridgeBytes("a===")).toThrow(BridgeProtocolError);
  });

  test("coalesces scroll, state, and selection telemetry", () => {
    const coalescer = new WorkerEventCoalescer();
    coalescer.push({ v: 1, type: "state", state: "connecting" });
    coalescer.push({ v: 1, type: "state", state: "ready" });
    coalescer.push({ v: 1, type: "title", title: "one" });
    coalescer.push({
      v: 1,
      type: "scroll-state",
      scroll: {
        atBottom: false,
        viewportY: 1,
        baseY: 2,
        buffer: "normal",
        newOutputWhileAway: false,
      },
    });
    coalescer.push({
      v: 1,
      type: "scroll-state",
      scroll: {
        atBottom: true,
        viewportY: 2,
        baseY: 2,
        buffer: "normal",
        newOutputWhileAway: false,
      },
    });
    const messages = coalescer.flush();
    expect(messages).toHaveLength(3);
    expect(messages).toContainEqual({ v: 1, type: "state", state: "ready" });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "scroll-state",
        scroll: expect.objectContaining({ atBottom: true }),
      }),
    );
    expect(coalescer.flush()).toEqual([]);
  });
});
