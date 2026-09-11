import type { NativeToWorkerMessage, WorkerToNativeMessage } from "@/terminal/transport/bridge";
import { decodeBridgeBytes } from "@/terminal/transport/bridge";
import {
  type HostTransportLease,
  retainHostTransport,
} from "@/terminal/transport/host-transport-registry";
import { createSessionTransport } from "@/terminal/transport/session-transport";
import type {
  SessionTransport,
  TransportError,
  TransportState,
  UploadProgress,
  WorkerEndpoint,
} from "@/terminal/transport/types";
import { SESSION_UPLOAD_CHUNK_BYTES } from "@/terminal/transport/upload";
import { terminalDark } from "@/theme";

const mockClose = jest.fn();
const mockListeners = new Set<(state: TransportState) => void>();
let mockState: TransportState = "ready";
let mockLastError: TransportError | null = null;
let mockCounter = 0;
const mockCreateHostTransport = jest.fn(() => ({
  get state() {
    return mockState;
  },
  get lastError() {
    return mockLastError;
  },
  close: mockClose,
  on: (event: string, fn: (state: TransportState) => void) => {
    if (event === "state") mockListeners.add(fn);
    return () => mockListeners.delete(fn);
  },
}));
jest.mock("@/terminal/transport/host-transport", () => ({
  createHostTransport: () => mockCreateHostTransport(),
}));
jest.mock("@/lib/crypto/bootstrap", () => ({
  randomBytes: (length: number) => new Uint8Array(length).fill(++mockCounter),
}));
jest.mock("@/lib/crypto/identity", () => ({
  activeDeviceIdentityAccount: () => "account",
  subscribeDeviceIdentityAccount: () => () => undefined,
}));
const options = {
  hostId: "11111111-2222-4333-8444-555555555555",
  hostIdentityPublicKey: "host-key",
};
let root: HostTransportLease;
let commands: NativeToWorkerMessage[];
const views: SessionTransport[] = [];
class FakeBridge implements WorkerEndpoint {
  readonly sent: NativeToWorkerMessage[] = [];
  readonly listeners = new Set<(message: WorkerToNativeMessage) => void>();
  send(message: NativeToWorkerMessage): void {
    this.sent.push(message);
  }
  onMessage(fn: (message: WorkerToNativeMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(message: WorkerToNativeMessage) {
    const attachment = this.sent.filter((frame) => frame.type === "pair-view").at(-1);
    this.emitRaw({ attachmentId: attachment?.attachmentId ?? null, ...message });
  }
  emitRaw(message: WorkerToNativeMessage) {
    for (const listener of this.listeners) listener(message);
  }
}
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
function state(next: TransportState) {
  mockState = next;
  for (const listener of mockListeners) listener(next);
}
function view() {
  const bridge = new FakeBridge();
  const transport = createSessionTransport({
    ...options,
    sessionId: "00112233-4455-6677-8899-aabbccddeeff",
    initialSize: { cols: 80, rows: 24 },
    theme: terminalDark,
    bridge,
  });
  views.push(transport);
  return { bridge, transport };
}
async function readyTransport() {
  const result = view();
  const opening = result.transport.open();
  result.bridge.emit({ v: 1, type: "display", owner: true, viewers: 1 });
  result.bridge.emit({ v: 1, type: "state", state: "ready" });
  await opening;
  return result;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockState = "ready";
  mockLastError = null;
  commands = [];
  root = retainHostTransport(options);
  root.shared.bridge.attach((raw) => commands.push(JSON.parse(raw) as NativeToWorkerMessage));
});
afterEach(() => {
  for (const transport of views.splice(0)) transport.close();
  root.release();
  mockListeners.clear();
});

describe("session channels on the shared daemon connection", () => {
  test("multiple views attach without negotiating or closing the daemon connection", async () => {
    const a = await readyTransport(),
      b = await readyTransport();
    expect(mockCreateHostTransport).toHaveBeenCalledTimes(1);
    expect(commands.filter((message) => message.type === "pair-attach")).toHaveLength(2);
    expect(a.bridge.sent.some((message) => message.type === "connect")).toBe(false);
    a.transport.close();
    expect(mockClose).not.toHaveBeenCalled();
    b.transport.write(Uint8Array.of(8));
    expect(b.bridge.sent.at(-1)?.type).toBe("input");
    expect(root.shared.owner).toBe(root.ownerId);
  });
  test("a disconnected or non-controlling view never queues stdin for later", async () => {
    const { bridge, transport } = view();
    const opening = transport.open();
    transport.write(Uint8Array.of(1));
    bridge.emit({ v: 1, type: "state", state: "ready" });
    await opening;
    transport.write(Uint8Array.of(2));
    expect(bridge.sent.filter((message) => message.type === "input")).toHaveLength(0);
    bridge.emit({ v: 1, type: "display", owner: true, viewers: 1 });
    transport.write(new Uint8Array(64 * 1024));
    const input = bridge.sent.filter((message) => message.type === "input");
    expect(input).toHaveLength(4);
    expect(
      input.every(
        (message) =>
          message.type === "input" && decodeBridgeBytes(message.data).length === 16 * 1024,
      ),
    ).toBe(true);
    state("connecting");
    transport.write(Uint8Array.of(3));
    state("ready");
    bridge.emit({ v: 1, type: "display", owner: true, viewers: 1 });
    bridge.emit({ v: 1, type: "state", state: "ready" });
    expect(bridge.sent.filter((message) => message.type === "input")).toHaveLength(4);
  });
  test("channel events are attachment scoped and old generations cannot reach a reopened view", async () => {
    const a = await readyTransport(),
      b = await readyTransport();
    const attachments = commands.filter((message) => message.type === "pair-attach");
    const first = attachments[0],
      second = attachments[1];
    if (!first || !second) throw new Error("missing attachments");
    const event = {
      v: 1,
      type: "pair-event",
      attachmentId: first.attachmentId,
      channel: "pty",
      event: "data",
      data: "hello",
      binary: false,
    };
    root.shared.bridge.receive(JSON.stringify(event));
    expect(a.bridge.sent.at(-1)).toEqual(event);
    expect(b.bridge.sent).not.toContainEqual(event);
    state("connecting");
    state("ready");
    const count = a.bridge.sent.length;
    root.shared.bridge.receive(JSON.stringify(event));
    expect(a.bridge.sent).toHaveLength(count);
  });
  test("delayed readiness and display events cannot enable input on a replacement attachment", async () => {
    const { bridge, transport } = await readyTransport();
    const attachment = bridge.sent.filter((frame) => frame.type === "pair-view").at(-1);
    if (!attachment) throw new Error("missing attachment");
    const oldReady = { ...attachment, type: "state" as const, state: "ready" as const };
    const oldDisplay = {
      v: 1 as const,
      type: "display" as const,
      owner: true,
      viewers: 1,
      attachmentId: attachment.attachmentId,
    };
    state("connecting");
    state("ready");
    bridge.emit(oldReady);
    bridge.emitRaw({ v: 1, type: "state", state: "ready" });
    bridge.emit(oldDisplay);
    transport.write(Uint8Array.of(1));
    expect(transport.state).toBe("connecting");
    expect(bridge.sent.filter((message) => message.type === "input")).toHaveLength(0);

    bridge.emit({ v: 1, type: "state", state: "ready" });
    transport.write(Uint8Array.of(2));
    expect(bridge.sent.filter((message) => message.type === "input")).toHaveLength(0);
    bridge.emit({ v: 1, type: "display", owner: true, viewers: 1 });
    transport.write(Uint8Array.of(3));
    expect(bridge.sent.filter((message) => message.type === "input")).toHaveLength(1);
  });
  test("a delayed reconnecting event cannot retire a healthy replacement attachment", async () => {
    const { bridge, transport } = await readyTransport();
    const old = bridge.sent.filter((frame) => frame.type === "pair-view").at(-1);
    if (!old) throw new Error("missing attachment");
    state("connecting");
    state("ready");
    bridge.emit({ v: 1, type: "state", state: "ready" });
    const count = commands.length;
    bridge.emit({ ...old, type: "state", state: "reconnecting" });
    expect(transport.state).toBe("ready");
    expect(commands).toHaveLength(count);
  });
  test("closing the view cancels attachment retries and preserves the daemon lease", async () => {
    jest.useFakeTimers();
    try {
      const { bridge, transport } = await readyTransport();
      bridge.emit({ v: 1, type: "state", state: "reconnecting" });
      transport.close();
      const count = commands.length;
      jest.advanceTimersByTime(30_000);
      expect(commands).toHaveLength(count);
      expect(mockClose).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
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

test("a view joining an already refused daemon preserves its approval error", async () => {
  mockState = "failed";
  mockLastError = { code: "device_not_trusted", message: "Approve this device", retryable: false };
  const { transport } = view();
  const error = jest.fn();
  transport.on("error", error);
  await expect(transport.open()).rejects.toMatchObject({ code: "device_not_trusted" });
  expect(error).toHaveBeenCalledWith(mockLastError);
  expect(transport.daemonState).toBe("failed");
});

test("reopening a reconnecting view does not duplicate bridge subscriptions", async () => {
  const { transport, bridge } = await readyTransport();
  state("connecting");
  const opening = transport.open();
  expect(bridge.listeners.size).toBe(1);
  expect(bridge.sent.filter((frame) => frame.type === "init")).toHaveLength(1);
  state("ready");
  bridge.emit({ v: 1, type: "state", state: "ready" });
  await opening;
});
