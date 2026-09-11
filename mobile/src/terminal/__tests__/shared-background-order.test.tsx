import { act, render } from "@testing-library/react-native";
import type { ForwardedRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { setDeviceIdentityAccount } from "@/lib/crypto/identity";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import { TerminalSurface } from "@/terminal/TerminalSurface";
import type {
  HostTransport,
  SessionTransport,
  SignalChannelLike,
} from "@/terminal/transport/types";

jest.mock("@/terminal/transport/daemon-trust", () => ({
  verifyDaemonHost: jest.fn(async () => {}),
}));
jest.mock("@/terminal/transport/signed-signalling", () => ({
  browserIdentityWire: jest.fn(async () => "browser-key"),
  signWorkerRequest: jest.fn(async () => "signature"),
  verifyAnswerFrame: jest.fn((value: unknown) => value),
}));
jest.mock("@/theme", () => {
  const actual = jest.requireActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useTheme: () => actual.darkTheme };
});
let mockRandom = 0;
jest.mock("@/lib/crypto/bootstrap", () => ({
  randomBytes: (length: number) => new Uint8Array(length).fill(++mockRandom),
}));

type Message = { type: string; mode?: string; consumerId?: string; attachmentId?: string };
interface WorkerProps {
  onLoad(): void;
  onMessage(event: { nativeEvent: { data: string } }): void;
}
interface Worker {
  props: WorkerProps;
  sent: Message[];
  mode?: string;
}
const mockWorkers: Worker[] = [];
function mockEmit(worker: Worker, message: Record<string, unknown>) {
  worker.props.onMessage({ nativeEvent: { data: JSON.stringify({ v: 1, ...message }) } });
}
function mockHello() {
  return {
    version: 1,
    type: "hello",
    protocol: "spawn.host.ctl",
    capabilities: ["fs.home", "session.transport.v1"],
  };
}
function mockSend(worker: Worker, raw: string) {
  const m = JSON.parse(raw) as Message;
  worker.sent.push(m);
  if (m.type === "init" && m.mode) worker.mode = m.mode;
  // Only native SDK/worker wire boundaries are stubbed; all transports and leases are real.
  if (m.type === "host-consumer-open")
    void Promise.resolve().then(() => {
      mockEmit(worker, {
        type: "host-consumer-event",
        consumerId: m.consumerId,
        message: { type: "host-response", requestId: "$host.hello", ok: true, result: mockHello() },
      });
      mockEmit(worker, {
        type: "host-consumer-event",
        consumerId: m.consumerId,
        message: { type: "state", state: "ready" },
      });
    });
  if (m.type === "pair-view")
    void Promise.resolve().then(() => {
      mockEmit(worker, { type: "display", owner: true, viewers: 1, attachmentId: m.attachmentId });
      mockEmit(worker, { type: "state", state: "ready", attachmentId: m.attachmentId });
    });
}
jest.mock("react-native-webview", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const Native = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    default: ReactModule.forwardRef(
      (
        props: WorkerProps,
        ref: ForwardedRef<{ postMessage(raw: string): void; reload(): void }>,
      ) => {
        const worker = ReactModule.useRef<Worker>({ props, sent: [] });
        worker.current.props = props;
        ReactModule.useImperativeHandle(ref, () => ({
          postMessage: (raw: string) => mockSend(worker.current, raw),
          reload: jest.fn(),
        }));
        ReactModule.useEffect(() => {
          mockWorkers.push(worker.current);
        }, []);
        return ReactModule.createElement(Native.View, { testID: "worker" });
      },
    ),
  };
});
const host = { hostId: "11111111-2222-4333-8444-555555555555", hostIdentityPublicKey: "host-key" };
class Signal implements SignalChannelLike {
  state = "open";
  closeInfo = null;
  listeners = new Set<(frame: unknown) => void>();
  send() {}
  close() {
    this.listeners.clear();
  }
  onFrame(listener: (frame: unknown) => void) {
    this.listeners.add(listener);
    void Promise.resolve().then(() => {
      if (this.listeners.has(listener))
        listener({
          type: "rtc.config",
          enabled: true,
          ice_servers: [],
          scope_type: "host",
          scope_id: host.hostId,
          protocol: "spawn.host.ctl",
          protocol_version: 2,
        });
    });
    return () => this.listeners.delete(listener);
  }
  onState() {
    return () => {};
  }
}
const listeners = new Set<(state: AppStateStatus) => void>();
let initial: AppStateStatus;
beforeEach(() => {
  jest.useFakeTimers();
  mockWorkers.length = 0;
  initial = AppState.currentState;
  AppState.currentState = "active";
  setDeviceIdentityAccount("00000000-0000-4000-8000-000000000001");
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  });
});
afterEach(() => {
  AppState.currentState = initial;
  listeners.clear();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function transition(state: AppStateStatus, reverse = false) {
  await act(async () => {
    AppState.currentState = state;
    for (const listener of reverse ? [...listeners].reverse() : listeners) listener(state);
    await drain();
  });
}
function rootWorker() {
  const w = mockWorkers.find((w) => w.mode === "host");
  if (!w) throw Error("no host worker");
  return w;
}
async function readyHost() {
  await act(async () => {
    mockEmit(rootWorker(), {
      type: "host-response",
      requestId: "$host.hello",
      ok: true,
      result: mockHello(),
    });
    mockEmit(rootWorker(), { type: "state", state: "ready" });
    await drain();
  });
}
const commandIds = (w: Worker, type: string, key: "attachmentId" | "consumerId") =>
  w.sent.filter((m) => m.type === type).map((m) => m[key]);

test.each([
  [2999, false],
  [3000, false],
  [5549, false],
  [2999, true],
  [3000, true],
  [5549, true],
])(
  "suspended %ims background with reversed callbacks=%s closes one actual root before reattachment",
  async (elapsed, reverse) => {
    let root: HostTransport | undefined;
    const sessions: SessionTransport[] = [];
    const tools: HostTransport[] = [];
    const captureRoot = (t: HostTransport) => {
      root = t;
    };
    const captureSession = (t: SessionTransport) => {
      sessions.push(t);
    };
    const captureTool = (t: HostTransport) => {
      tools.push(t);
    };
    const openSignal = () => new Signal();
    const screen = await render(
      <>
        <HostTransportSurface
          connectionOwner
          {...host}
          openSignal={openSignal}
          onTransport={captureRoot}
        />
        <TerminalSurface
          {...host}
          sessionId="00112233-4455-6677-8899-aabbccddeeff"
          initialSize={{ cols: 80, rows: 24 }}
          onTransport={captureSession}
        />
        <TerminalSurface
          {...host}
          sessionId="00112233-4455-6677-8899-aabbccddee00"
          initialSize={{ cols: 80, rows: 24 }}
          onTransport={captureSession}
        />
        <HostTransportSurface {...host} onTransport={captureTool} />
        <HostTransportSurface {...host} onTransport={captureTool} />
      </>,
    );
    try {
      expect(mockWorkers).toHaveLength(3);
      await act(async () => {
        for (const w of mockWorkers) w.props.onLoad();
        await drain();
      });
      await readyHost();
      expect(root?.state).toBe("ready");
      expect(sessions).toHaveLength(2);
      expect(tools).toHaveLength(2);
      expect([...sessions, ...tools].every((t) => t.state === "ready")).toBe(true);
      const hostWorker = rootWorker();
      const oldAttachments = commandIds(hostWorker, "pair-attach", "attachmentId");
      const oldConsumers = commandIds(hostWorker, "host-consumer-open", "consumerId");
      expect(oldAttachments).toHaveLength(2);
      expect(oldConsumers).toHaveLength(2);
      const offset = hostWorker.sent.length;
      const started = Date.now();
      await transition("background", Boolean(reverse));
      jest.setSystemTime(started + Number(elapsed));
      await transition("active", Boolean(reverse));
      const retired = Number(elapsed) >= 3000;
      const commands = hostWorker.sent.slice(offset);
      expect(commands.filter((m) => m.type === "close")).toHaveLength(retired ? 1 : 0);
      if (retired) {
        expect([...sessions, ...tools].every((t) => t.state !== "ready")).toBe(true);
        const close = commands.findIndex((m) => m.type === "close"),
          init = commands.findIndex((m) => m.type === "init"),
          connect = commands.findIndex((m) => m.type === "connect");
        expect(close).toBeLessThan(init);
        expect(init).toBeLessThan(connect);
        expect(
          commands
            .slice(close + 1)
            .some((m) => m.type === "pair-attach" || m.type === "host-consumer-open"),
        ).toBe(false);
        const retiredAttachments = commandIds(hostWorker, "pair-attach", "attachmentId");
        await act(async () => {
          for (const w of mockWorkers.filter((w) => w.mode === "session"))
            for (const id of retiredAttachments) {
              mockEmit(w, { type: "display", owner: true, viewers: 1, attachmentId: id });
              mockEmit(w, { type: "state", state: "ready", attachmentId: id });
            }
          for (const id of oldConsumers)
            mockEmit(hostWorker, {
              type: "host-consumer-event",
              consumerId: id,
              message: { type: "state", state: "ready" },
            });
          await drain();
        });
        expect([...sessions, ...tools].every((t) => t.state !== "ready")).toBe(true);
        await readyHost();
        expect([...sessions, ...tools].every((t) => t.state === "ready")).toBe(true);
        const newAttachments = commandIds(hostWorker, "pair-attach", "attachmentId");
        const newConsumers = commandIds(hostWorker, "host-consumer-open", "consumerId");
        expect(newAttachments).toHaveLength(retiredAttachments.length + 2);
        expect(newConsumers).toHaveLength(4);
        expect(new Set(newAttachments).size).toBe(newAttachments.length);
        expect(new Set(newConsumers).size).toBe(4);
      } else {
        expect([...sessions, ...tools].every((t) => t.state === "ready")).toBe(true);
        expect(commandIds(hostWorker, "pair-attach", "attachmentId")).toEqual(oldAttachments);
        expect(commandIds(hostWorker, "host-consumer-open", "consumerId")).toEqual(oldConsumers);
      }
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3000);
      });
      await transition("active", Boolean(reverse));
      expect(hostWorker.sent.slice(offset).filter((m) => m.type === "close")).toHaveLength(
        retired ? 1 : 0,
      );
      expect(root?.state).toBe("ready");
    } finally {
      await screen.unmount();
    }
  },
);
