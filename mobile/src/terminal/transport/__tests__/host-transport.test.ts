import type { NativeToWorkerMessage, WorkerToNativeMessage } from "@/terminal/transport/bridge";
import { createHostTransport } from "@/terminal/transport/host-transport";
import type { SignalChannelLike, WorkerEndpoint } from "@/terminal/transport/types";

jest.mock("@/terminal/transport/signed-signalling", () => ({
  browserIdentityWire: jest.fn(async () => "browser-key"),
  signWorkerRequest: jest.fn(async () => "signature"),
  verifyAnswerFrame: jest.fn((value: unknown) => value),
}));

jest.mock("@/lib/crypto/bootstrap", () => ({
  randomBytes: jest.fn((length: number) => new Uint8Array(length)),
}));

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
  readonly listeners = new Set<(frame: unknown) => void>();
  send(_frame: unknown): void {}
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

describe("HostTransport", () => {
  test("opens a host peer and correlates typed requests", async () => {
    const bridge = new FakeBridge();
    const signal = new FakeSignal();
    const transport = createHostTransport({
      hostId: "00112233-4455-6677-8899-aabbccddeeff",
      hostIdentityPublicKey: "host-key",
      bridge,
      openSignal: () => signal,
    });
    const opening = transport.open();
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    signal.emit({
      type: "rtc.config",
      enabled: true,
      binding_nonce_required: true,
      ice_servers: [],
    });
    bridge.emit({ v: 1, type: "state", state: "ready" });
    await opening;
    expect(bridge.sent[0]).toMatchObject({ type: "init", mode: "host" });

    const request = transport.request<{ home_dir: string }>("fs.home");
    const sent = bridge.sent.find(
      (message): message is Extract<NativeToWorkerMessage, { type: "host-request" }> =>
        message.type === "host-request",
    );
    expect(sent).toBeDefined();
    bridge.emit({
      v: 1,
      type: "host-response",
      requestId: sent?.requestId ?? "missing",
      ok: true,
      result: { home_dir: "/Users/me" },
    });
    await expect(request).resolves.toEqual({ home_dir: "/Users/me" });
    transport.close();
  });
});
