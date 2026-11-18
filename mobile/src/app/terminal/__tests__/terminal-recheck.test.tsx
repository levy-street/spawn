import { readFileSync } from "node:fs";
import { act, fireEvent, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import TerminalScreen from "@/app/terminal/[sessionId]";
import { listAgents } from "@/data/api/endpoints/agents";
import { getHost } from "@/data/api/endpoints/hosts";
import {
  deleteSession,
  getSession,
  listSessions,
  restartSession,
} from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import type { NativeToWorkerMessage, WorkerBridge } from "@/terminal/transport/bridge";
import { CONNECT_TIMEOUT_MS, type HostTransportOptions } from "@/terminal/transport/types";
import { FIXTURE_IDS, makeHost, makeSession } from "../../../../tests/factories";
import { renderWithProviders } from "../../../../tests/render";

let mockSessionId: string = FIXTURE_IDS.session;
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ sessionId: mockSessionId }),
  useRouter: () => ({ back: jest.fn() }),
}));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({}) }));
jest.mock("@/data/api/endpoints/sessions", () => ({
  getSession: jest.fn(),
  listSessions: jest.fn(),
  deleteSession: jest.fn(),
  restartSession: jest.fn(),
}));
jest.mock("@/data/api/endpoints/hosts", () => ({ getHost: jest.fn() }));
jest.mock("@/data/api/endpoints/agents", () => ({ listAgents: jest.fn(async () => []) }));
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(async () => {}),
}));

const mockAttachments: { id: string; root: WorkerBridge; at: number }[] = [];
const mockRootCommands: NativeToWorkerMessage[] = [];
jest.mock("@/terminal/transport/host-transport", () => ({
  createHostTransport: ({ bridge }: HostTransportOptions) => {
    const root = bridge as WorkerBridge;
    root.attach((raw) => {
      const frame: NativeToWorkerMessage = JSON.parse(raw);
      mockRootCommands.push(frame);
      if (frame.type === "pair-attach")
        mockAttachments.push({ id: frame.attachmentId, root, at: Date.now() });
    });
    return { state: "ready", on: () => () => {}, close: jest.fn() };
  },
}));

// Run the real terminal worker's channel proxy. A daemon close has to travel
// through the WebView and back before the native transport schedules a retry.
const mockPairSource = readFileSync(require.resolve("@/terminal/worker/worker-pair.js"), "utf8");
const mockPost = jest.fn();
jest.mock("react-native-webview", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    __esModule: true,
    default: React.forwardRef(
      (
        props: {
          onMessage: (event: { nativeEvent: { data: string } }) => void;
        },
        ref,
      ) => {
        const latest = React.useRef(props);
        latest.current = props;
        React.useImperativeHandle(ref, () => {
          const api = {
            state: { mode: "session", rtcSessionId: "" },
            post(frame: object) {
              const data = JSON.stringify({ v: 1, attachmentId: api.state.rtcSessionId, ...frame });
              void Promise.resolve().then(() =>
                latest.current.onMessage({ nativeEvent: { data } }),
              );
            },
            handlePairMessage: (_frame: NativeToWorkerMessage) => false,
          };
          new Function("globalThis", mockPairSource)({ spawnWorker: api });
          return {
            postMessage(raw: string) {
              const frame = JSON.parse(raw) as NativeToWorkerMessage;
              mockPost(frame);
              api.handlePairMessage(frame);
            },
          };
        }, []);
        return React.createElement(View, { ...props, testID: "worker" });
      },
    ),
  };
});

const frame = { version: 1, kind: "event", event: "attach_refused", reason: "session_not_running" };
const hint = "Choose Restart from the window menu to start it again.";
const initialState = AppState.currentState;
afterEach(() => {
  AppState.currentState = initialState;
});

async function openTerminal() {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockAttachments.length = mockRootCommands.length = 0;
  mockSessionId = FIXTURE_IDS.session;
  AppState.currentState = "active";
  const session = makeSession();
  jest.mocked(getSession).mockResolvedValue(session);
  jest.mocked(getHost).mockImplementation(async (id) => makeHost({ id }));
  const element = () => (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}
    >
      <TerminalScreen />
    </SafeAreaProvider>
  );
  const screen = await renderWithProviders(element());
  await waitFor(() => expect(mockAttachments).toHaveLength(1));
  await fireEvent(screen.getByTestId("worker"), "load");
  const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));
  await advance(240);
  const notice = () =>
    screen.queryByText(`This session is no longer running on ${makeHost().name}.`);
  const pair = (
    event: string,
    channel = "ctl",
    data?: unknown,
    index = mockAttachments.length - 1,
  ) =>
    act(() => {
      const attachment = mockAttachments[index];
      if (!attachment) throw new Error("Missing attachment");
      attachment.root.receive(
        JSON.stringify({
          v: 1,
          type: "pair-event",
          attachmentId: attachment.id,
          channel,
          event,
          ...(data === undefined ? {} : { data: JSON.stringify(data), binary: false, sequence: 1 }),
        }),
      );
    });
  return { screen, session, element, advance, notice, pair };
}

test("typed and plain closes produce identical attempts, teardown, requests and control", async () => {
  async function trace(typed: boolean) {
    const { screen, advance, notice, pair } = await openTerminal();
    const start = Date.now();
    for (const channel of ["pty", "ctl", "pty"]) {
      await pair("open", channel);
      if (typed) await pair("data", channel, frame);
      await advance(25);
      await pair("close", channel);
      expect(Boolean(notice())).toBe(typed);
      expect(Boolean(screen.queryByText(hint))).toBe(typed);
      await advance(500);
    }
    await fireEvent(screen.getByTestId("worker"), "message", {
      nativeEvent: {
        data: JSON.stringify({
          v: 1,
          type: "state",
          state: "ready",
          attachmentId: mockAttachments.at(-1)?.id,
        }),
      },
    });
    expect(notice()).toBeNull();
    expect(screen.queryByText(hint)).toBeNull();
    const attempts = mockAttachments.map((a, i) => (i === 0 ? 0 : a.at - start));
    expect(attempts).toEqual([0, 525, 1050, 1575]);
    const commands = mockRootCommands.flatMap((f) => {
      if (f.type === "pair-attach") return ["attach"];
      // Receive credits acknowledge incoming frames inside the local bridge.
      if (f.type === "pair-command" && f.event === "received") return [];
      if (f.type === "pair-command") return [[f.channel, f.event, f.data].join(" ")];
      return [f.type];
    });
    const claims = mockPost.mock.calls.filter(([f]) => f.type === "take-control");
    expect(claims).toHaveLength(1);
    const requests = [
      getSession,
      getHost,
      listSessions,
      listAgents,
      deleteSession,
      restartSession,
    ].map((fn) => [...jest.mocked(fn).mock.calls]);
    await screen.unmount();
    return { attempts, commands, requests, claims };
  }
  const plain = await trace(false);
  expect(await trace(true)).toEqual(plain);
});

test("only the current pair's exact refusal explains a running row", async () => {
  const { screen, session, advance, notice, pair, element } = await openTerminal();
  const row = async (change: Partial<typeof session>) => {
    await act(() =>
      screen.queryClient.setQueryData(qk.session(session.id), { ...session, ...change }),
    );
    await advance(1);
  };
  for (const change of [
    { version: "1" },
    { kind: "response" },
    { event: "different" },
    { reason: "unknown" },
  ]) {
    await pair("data", "ctl", { ...frame, ...change });
    expect(notice()).toBeNull();
  }
  await pair("data", "pty", frame);
  expect(notice()).toBeOnTheScreen();
  await row({ status: "starting" });
  expect(screen.getByText("Opening terminal")).toBeOnTheScreen();
  expect(notice()).toBeNull();
  await row({ status: "running" });
  expect(notice()).toBeOnTheScreen();
  await pair("close");
  await advance(500);
  await pair("data", "ctl", { ...frame, reason: "unknown" });
  await pair("close");
  expect(notice()).toBeNull();
  await advance(500);
  await pair("data", "ctl", frame, 0);
  expect(notice()).toBeNull();
  await pair("data", "ctl", frame);
  await pair("close");
  await advance(500 + CONNECT_TIMEOUT_MS);
  expect(notice()).toBeNull();
  await advance(500);
  await pair("data", "ctl", frame);
  await pair("close");
  await advance(500);
  // A failed write to the host bridge ends the new attempt through retryAttachment.
  const attachment = mockAttachments.at(-1);
  if (!attachment) throw new Error("Missing attachment");
  jest.spyOn(attachment.root, "send").mockImplementationOnce(() => {
    throw new Error("closed");
  });
  await fireEvent(screen.getByTestId("worker"), "message", {
    nativeEvent: {
      data: JSON.stringify({
        v: 1,
        type: "pair-command",
        channel: "ctl",
        event: "send",
        attachmentId: attachment.id,
      }),
    },
  });
  expect(notice()).toBeNull();
  await advance(500);
  await pair("data", "ctl", frame);
  await row({ started_at: new Date(0).toISOString() });
  await pair("data", "pty", frame);
  expect(notice()).toBeNull();
  await pair("close");
  await advance(500);
  await advance(240);
  await pair("data", "ctl", frame);
  expect(notice()).toBeOnTheScreen();
  await row({ host_id: FIXTURE_IDS.workspace });
  expect(notice()).toBeNull();
  await waitFor(() => expect(jest.mocked(getHost)).toHaveBeenCalledWith(FIXTURE_IDS.workspace));
  await advance(241);
  await pair("data", "ctl", frame);
  expect(notice()).toBeOnTheScreen();
  mockSessionId = FIXTURE_IDS.agent;
  jest.mocked(getSession).mockResolvedValue({ ...session, id: mockSessionId });
  await screen.rerender(element());
  await waitFor(() => expect(screen.getByTestId("worker")).toBeOnTheScreen());
  expect(notice()).toBeNull();
});
