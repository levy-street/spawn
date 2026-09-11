import type { WorkerToNativeMessage } from "@/terminal/transport/bridge";
import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

type WithoutVersion<Message> = Message extends unknown ? Omit<Message, "v"> : never;

interface Runtime {
  state: { mode: string | null; rtcSessionId: string | null; ctl: ControlChannel | null };
  post(message: WithoutVersion<WorkerToNativeMessage>): void;
  telemetry(message: WithoutVersion<WorkerToNativeMessage>): void;
}

class ControlChannel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  send = jest.fn();
}

function moduleSource(marker: string) {
  const offset = TERMINAL_WORKER_HTML.indexOf(marker);
  const start = TERMINAL_WORKER_HTML.lastIndexOf("(() => {", offset);
  const end = TERMINAL_WORKER_HTML.indexOf("\n})();", offset) + "\n})();".length;
  if (offset < 0 || start < 0 || end < start) throw new Error(`Missing worker module: ${marker}`);
  return TERMINAL_WORKER_HTML.slice(start, end);
}

// Executes the bundled bridge runtime. DOM and native delivery are fixtures;
// this proves message scoping, not WKWebView/Android WebView scheduling.
function runtime() {
  const messages: WorkerToNativeMessage[] = [];
  const root = {
    ReactNativeWebView: {
      postMessage: (raw: string) => messages.push(JSON.parse(raw) as WorkerToNativeMessage),
    },
    spawnWorker: undefined as Runtime | undefined,
  };
  const target = { addEventListener: jest.fn() };
  new Function(
    "globalThis",
    "navigator",
    "window",
    "document",
    moduleSource("const BRIDGE_VERSION = 1;"),
  )(root, { platform: "iPhone", userAgent: "iPhone" }, target, target);
  if (!root.spawnWorker) throw new Error("Worker runtime did not initialize.");
  return { api: root.spawnWorker, messages, root };
}

afterEach(() => jest.useRealTimers());

test("session worker notifications retain their attachment through delayed native delivery", () => {
  const { api, messages } = runtime();
  api.state.mode = "session";
  api.state.rtcSessionId = "first";
  api.post({ type: "state", state: "ready" });
  api.post({ type: "display", owner: true, viewers: 1 });
  api.state.rtcSessionId = "replacement";
  api.post({ type: "state", state: "connecting" });
  expect(messages).toEqual([
    { v: 1, type: "state", state: "ready", attachmentId: "first" },
    { v: 1, type: "display", owner: true, viewers: 1, attachmentId: "first" },
    { v: 1, type: "state", state: "connecting", attachmentId: "replacement" },
  ]);
});

test("batched telemetry keeps its original attachment when the worker reattaches before flush", () => {
  jest.useFakeTimers();
  const { api, messages } = runtime();
  api.state.mode = "session";
  api.state.rtcSessionId = "first";
  api.telemetry({ type: "selection", text: "old selection" });
  api.state.rtcSessionId = "replacement";
  jest.advanceTimersByTime(8);
  expect(messages).toEqual([
    { v: 1, type: "selection", text: "old selection", attachmentId: "first" },
  ]);
});

test("host notifications, worker diagnostics and explicitly addressed pair commands keep their scope", () => {
  const { api, messages } = runtime();
  api.state.mode = "host";
  api.post({ type: "state", state: "ready" });
  api.state.mode = "session";
  api.state.rtcSessionId = "replacement";
  const diagnostic = {
    isSecureContext: true,
    peerConnection: true,
    dataChannel: true,
    loopback: true,
    renderer: null,
  };
  api.post({ type: "diagnostic", diagnostic });
  api.post({
    type: "pair-command",
    attachmentId: "retired",
    channel: "ctl",
    event: "close",
  });
  expect(messages).toEqual([
    { v: 1, type: "state", state: "ready" },
    { v: 1, type: "diagnostic", diagnostic },
    { v: 1, type: "pair-command", attachmentId: "retired", channel: "ctl", event: "close" },
  ]);
});

test.each(["drain", "timeout"])(
  "an upload waiting for %s cannot dispatch into a replacement attachment",
  async (completion) => {
    jest.useFakeTimers();
    const h = runtime();
    new Function("globalThis", moduleSource("const MAX_PREBOOT_BYTES = 12 * 1024 * 1024"))(h.root);
    const api = h.api as Runtime & {
      sessionGate(gate: string): void;
      sessionReady(): boolean;
      resetSessionGeneration(): void;
      receiveSessionCtl(value: string): Promise<void>;
      handleUploadMessage(message: Record<string, unknown>): Promise<void>;
    };
    const old = new ControlChannel();
    api.state.mode = "session";
    api.state.rtcSessionId = "first";
    api.state.ctl = old;
    for (const gate of ["bindingAccepted", "ptyOpen", "ctlOpen", "historyReady"])
      api.sessionGate(gate);
    await api.receiveSessionCtl(
      JSON.stringify({
        version: 1,
        kind: "event",
        event: "ready",
        upload_capability: "capability",
        agent_generation: 1,
        upload_max_bytes: 20 * 1024 * 1024,
        upload_chunk_bytes: 48 * 1024,
      }),
    );
    expect(api.sessionReady()).toBe(true);
    const uploadId = "00000000-0000-4000-8000-000000000001";
    await api.handleUploadMessage({
      type: "upload-start",
      uploadId,
      name: "file.txt",
      mimeType: "text/plain",
      destination: "cwd",
      totalBytes: 1,
      sha256: "a".repeat(64),
    });
    old.bufferedAmount = 256 * 1024;
    const pending = api.handleUploadMessage({
      type: "upload-chunk",
      uploadId,
      sequence: 0,
      last: true,
      data: "AQ==",
    });
    const result = pending.catch((error: unknown) => error);
    api.resetSessionGeneration();
    api.state.rtcSessionId = "replacement";
    const successor = new ControlChannel();
    api.state.ctl = successor;
    const count = h.messages.length;
    if (completion === "drain") old.dispatchEvent(new Event("bufferedamountlow"));
    else await jest.advanceTimersByTimeAsync(5_000);
    expect(await result).toBeUndefined();
    expect(successor.send).not.toHaveBeenCalled();
    expect(h.messages).toHaveLength(count);
  },
);
