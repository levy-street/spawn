import { act, fireEvent, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import TerminalScreen from "@/app/terminal/[sessionId]";
import { ApiError } from "@/data/api/client";
import { getHost } from "@/data/api/endpoints/hosts";
import { getSession, listSessions } from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import { RealtimeProvider } from "@/data/realtime/provider";
import type { SocketState } from "@/data/realtime/socket";
import type { NativeToWorkerMessage, WorkerBridge } from "@/terminal/transport/bridge";
import type { HostTransportOptions } from "@/terminal/transport/types";
import { FIXTURE_IDS, makeHost, makeSession } from "../../../../tests/factories";
import { renderWithProviders } from "../../../../tests/render";

jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({
    sessionId: require("../../../../tests/factories").FIXTURE_IDS.session,
  }),
  useRouter: () => ({ back: jest.fn() }),
}));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({}) }));
jest.mock("@/data/api/endpoints/sessions", () => ({
  getSession: jest.fn(),
  listSessions: jest.fn(),
}));
jest.mock("@/data/api/endpoints/hosts", () => ({ getHost: jest.fn() }));
jest.mock("@/data/api/endpoints/agents", () => ({ listAgents: async () => [] }));
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(async () => {}),
}));
jest.mock("@/data/api/auth-token", () => ({
  authToken: { get: async () => "token", subscribe: () => () => {} },
}));
let mockAlertsState: (state: SocketState) => void;
jest.mock("@/data/realtime/alert-socket", () => ({
  AlertSocketClient: jest.fn(() => ({
    state: "idle",
    connect: jest.fn(),
    close: jest.fn(),
    subscribe: (fn: typeof mockAlertsState) => {
      mockAlertsState = fn;
      return () => {};
    },
    onFrame: () => () => {},
  })),
}));

const mockAttachments: { hostId: string; id: string; bridge: WorkerBridge }[] = [];
const mockHostClose = jest.fn();
jest.mock("@/terminal/transport/host-transport", () => ({
  createHostTransport: ({ hostId, bridge }: HostTransportOptions) => {
    const root = bridge as WorkerBridge;
    root.attach((raw) => {
      const frame: NativeToWorkerMessage = JSON.parse(raw);
      if (frame.type === "pair-attach")
        mockAttachments.push({ hostId, id: frame.attachmentId, bridge: root });
    });
    return { state: "ready", on: () => () => {}, close: mockHostClose };
  },
}));
const mockPost = jest.fn();
jest.mock("react-native-webview", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ postMessage: mockPost }));
      return React.createElement(View, { ...props, testID: "worker" });
    }),
  };
});

async function openTerminal() {
  jest.useFakeTimers();
  AppState.currentState = "active";
  const session = makeSession();
  jest.mocked(getSession).mockResolvedValue(session);
  jest.mocked(getHost).mockImplementation(async (id) => makeHost({ id }));
  const screen = await renderWithProviders(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}
    >
      <RealtimeProvider>
        <TerminalScreen />
      </RealtimeProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(mockAttachments).toHaveLength(1));
  return { screen, session };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockAttachments.length = 0;
});

const initialAppState = AppState.currentState;
afterEach(() => {
  AppState.currentState = initialAppState;
});

async function refuse() {
  const first = mockAttachments[0];
  if (!first) throw new Error("Missing first attachment");
  await act(() =>
    first.bridge.receive(
      JSON.stringify({
        v: 1,
        type: "pair-event",
        attachmentId: first.id,
        channel: "ctl",
        event: "data",
        sequence: 1,
        binary: false,
        data: JSON.stringify({
          version: 1,
          kind: "event",
          event: "attach_refused",
          reason: "session_not_running",
        }),
      }),
    ),
  );
}

test.each(["timer", "button"])(
  "direct terminal follows a move missed before alerts opened on %s",
  async (trigger) => {
    const { screen, session } = await openTerminal();
    const moved = { ...session, host_id: FIXTURE_IDS.workspace };
    let finish!: () => void;
    jest
      .mocked(getSession)
      .mockResolvedValue(moved)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(moved);
          }),
      );
    await act(() => mockAlertsState("open"));
    await refuse();
    expect(screen.getByText("Try again")).toBeOnTheScreen();
    expect(getSession).toHaveBeenCalledTimes(1);
    if (trigger === "timer") await act(() => jest.advanceTimersByTimeAsync(30_000));
    else await fireEvent.press(screen.getByText("Try again"));
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(mockAttachments).toHaveLength(1);
    await act(() => finish());
    await waitFor(() =>
      expect(mockAttachments.map((a) => a.hostId)).toEqual([session.host_id, moved.host_id]),
    );
    expect(listSessions).not.toHaveBeenCalled();
    expect(screen.queryByText("Try again")).toBeNull();
  },
);

test("retrying the same run leaves the other viewer in control", async () => {
  const { screen } = await openTerminal();
  await refuse();
  await fireEvent.press(screen.getByText("Try again"));
  await waitFor(() => expect(mockAttachments).toHaveLength(2));
  const view = screen.getByTestId("worker");
  await fireEvent(view, "load");
  for (const event of [
    { type: "display", owner: false, viewers: 2 },
    { type: "state", state: "ready" },
  ]) {
    await fireEvent(view, "message", {
      nativeEvent: {
        data: JSON.stringify({
          v: 1,
          ...event,
          attachmentId: mockAttachments[1]?.id,
        }),
      },
    });
  }
  const claims = () =>
    mockPost.mock.calls.filter(([raw]) => JSON.parse(raw).type === "take-control");
  expect(claims()).toHaveLength(0);
  await fireEvent.press(screen.getByText("Take control"));
  expect(claims()).toHaveLength(1);
});

test("a transient detail error keeps the ready terminal until access is lost", async () => {
  const { screen, session } = await openTerminal();
  const view = screen.getByTestId("worker");
  await fireEvent(view, "load");
  await fireEvent(view, "message", {
    nativeEvent: {
      data: JSON.stringify({
        v: 1,
        type: "state",
        state: "ready",
        attachmentId: mockAttachments[0]?.id,
      }),
    },
  });
  expect(mockPost.mock.calls.map(([raw]) => JSON.parse(raw).type)).toContain("take-control");
  const refresh = () => screen.queryClient.invalidateQueries({ queryKey: qk.session(session.id) });
  jest.mocked(getSession).mockRejectedValueOnce(new Error("temporarily unavailable"));
  await act(refresh);
  await act(() => jest.advanceTimersByTimeAsync(1));
  expect(screen.getByTestId("worker")).toBe(view);
  expect(mockHostClose).not.toHaveBeenCalled();
  expect(mockAttachments).toHaveLength(1);
  expect(screen.queryByText("Try again")).toBeNull();
  jest.mocked(getSession).mockRejectedValueOnce(new ApiError(403, "forbidden", "Access lost"));
  await act(refresh);
  await waitFor(() => expect(screen.getByText("Terminal unavailable")).toBeOnTheScreen());
  expect(mockHostClose).toHaveBeenCalledTimes(1);
});
