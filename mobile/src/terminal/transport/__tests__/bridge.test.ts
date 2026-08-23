import {
  BridgeProtocolError,
  decodeBridgeBytes,
  encodeBridgeBytes,
  parseNativeMessage,
  parseWorkerMessage,
  serializeNativeMessage,
  serializeWorkerMessage,
  TERMINAL_BRIDGE_VERSION,
  WorkerEventCoalescer,
} from "@/terminal/transport/bridge";

describe("terminal worker bridge", () => {
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
