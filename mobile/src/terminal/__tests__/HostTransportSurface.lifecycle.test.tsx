import { act, render } from "@testing-library/react-native";
import type { ForwardedRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { retireRegisteredGenerations } from "@/data/realtime/lifecycle";
import { deviceIdentity, setDeviceIdentityAccount } from "@/lib/crypto/identity";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";

function mockTransport() {
  return {
    state: "ready",
    on: jest.fn(() => () => undefined),
    prepare: jest.fn(),
    open: jest.fn(async () => undefined),
    close: jest.fn(),
    networkChanged: jest.fn(),
  };
}
const mockRoots: ReturnType<typeof mockTransport>[] = [];
const mockConsumers: ReturnType<typeof mockTransport>[] = [];
jest.mock("@/terminal/transport/host-transport", () => ({
  createHostTransport: () => {
    const transport = mockTransport();
    mockRoots.push(transport);
    return transport;
  },
  createHostConsumerTransport: () => {
    const transport = mockTransport();
    mockConsumers.push(transport);
    return transport;
  },
}));

interface WorkerProps {
  onLoad(): void;
  onContentProcessDidTerminate(): void;
}
const mockWorkers: { props: WorkerProps; reload: jest.Mock }[] = [];
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
        const worker = ReactModule.useRef({ props, reload: jest.fn() });
        worker.current.props = props;
        ReactModule.useImperativeHandle(ref, () => ({
          postMessage: jest.fn(),
          reload: worker.current.reload,
        }));
        ReactModule.useEffect(() => {
          mockWorkers.push(worker.current);
        }, []);
        return ReactModule.createElement(Native.View, { testID: "host-worker" });
      },
    ),
  };
});

const account = "00000000-0000-4000-8000-000000000001";
const host = { hostId: "host", hostIdentityPublicKey: "host-key", onTransport: jest.fn() };
const listeners = new Set<(state: AppStateStatus) => void>();
let initialAppState: AppStateStatus;

beforeEach(() => {
  jest.useFakeTimers();
  mockRoots.length = 0;
  mockConsumers.length = 0;
  mockWorkers.length = 0;
  initialAppState = AppState.currentState;
  AppState.currentState = "active";
  setDeviceIdentityAccount(account);
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  });
});

afterEach(() => {
  AppState.currentState = initialAppState;
  listeners.clear();
  jest.restoreAllMocks();
});

async function appState(next: AppStateStatus) {
  await act(() => {
    AppState.currentState = next;
    for (const listener of listeners) listener(next);
  });
}

function root() {
  const transport = mockRoots.at(-1);
  if (!transport) throw new Error("No shared root transport.");
  return transport;
}

function worker() {
  const current = mockWorkers.at(-1);
  if (!current) throw new Error("No worker WebView.");
  return current;
}

// The real surface, registry, identity events and AppState wiring run together;
// WebView and transport effects are mocked, so these are not device evidence.
test("the app owner survives tool route changes and handles each network change once", async () => {
  const screen = await render(<HostTransportSurface connectionOwner {...host} />);
  const transport = root();
  await act(() => worker().props.onLoad());
  await screen.rerender(
    <>
      <HostTransportSurface connectionOwner {...host} />
      <HostTransportSurface {...host} />
      <HostTransportSurface {...host} />
    </>,
  );
  expect(mockRoots).toHaveLength(1);
  expect(screen.getAllByTestId("host-worker")).toHaveLength(1);
  expect(mockConsumers).toHaveLength(2);
  await act(() => retireRegisteredGenerations("interface-change"));
  expect(transport.networkChanged).toHaveBeenCalledTimes(1);
  await screen.rerender(<HostTransportSurface connectionOwner {...host} />);
  expect(mockConsumers.every((consumer) => consumer.close.mock.calls.length === 1)).toBe(true);
  expect(transport.close).not.toHaveBeenCalled();
  expect(transport.open).toHaveBeenCalledTimes(1);
  await screen.unmount();
  expect(transport.close).toHaveBeenCalledTimes(1);
});

test("inactive and short background transitions preserve the root; three seconds retires it", async () => {
  const screen = await render(<HostTransportSurface connectionOwner {...host} />);
  const transport = root();
  await act(() => worker().props.onLoad());
  await appState("inactive");
  await act(() => jest.advanceTimersByTime(3_000));
  expect(transport.close).not.toHaveBeenCalled();
  await appState("background");
  await act(() => jest.advanceTimersByTime(2_999));
  await appState("active");
  await act(() => jest.advanceTimersByTime(1));
  expect(transport.close).not.toHaveBeenCalled();
  expect(transport.open).toHaveBeenCalledTimes(1);
  await appState("background");
  await act(() => jest.advanceTimersByTime(3_000));
  expect(transport.close).toHaveBeenCalledTimes(1);
  await appState("active");
  expect(transport.open).toHaveBeenCalledTimes(2);
  expect(mockRoots).toHaveLength(1);
  await screen.unmount();
});

test("a worker loaded in the background waits for foreground, including after process loss", async () => {
  AppState.currentState = "background";
  const screen = await render(<HostTransportSurface connectionOwner {...host} />);
  const transport = root();
  await act(() => worker().props.onLoad());
  expect(transport.open).not.toHaveBeenCalled();
  await appState("active");
  expect(transport.open).toHaveBeenCalledTimes(1);
  await act(() => worker().props.onContentProcessDidTerminate());
  expect(transport.close).toHaveBeenCalledTimes(1);
  expect(worker().reload).toHaveBeenCalledTimes(1);
  await appState("background");
  await act(() => worker().props.onLoad());
  expect(transport.open).toHaveBeenCalledTimes(1);
  await appState("active");
  expect(transport.open).toHaveBeenCalledTimes(2);
  await screen.unmount();
});

test.each(["account", "signing-key"])(
  "%s replacement retires the worker and pending background timer",
  async (replacement) => {
    const screen = await render(<HostTransportSurface connectionOwner {...host} />);
    const retired = root();
    await act(() => worker().props.onLoad());
    await appState("background");
    await act(async () => {
      if (replacement === "account") {
        setDeviceIdentityAccount("00000000-0000-4000-8000-000000000002");
      } else {
        await deviceIdentity.reset();
        setDeviceIdentityAccount(account);
      }
    });
    expect(retired.close).toHaveBeenCalled();
    expect(root()).not.toBe(retired);
    const successor = root();
    const closeCount = retired.close.mock.calls.length;
    await act(() => worker().props.onLoad());
    await appState("active");
    await act(() => jest.advanceTimersByTime(3_000));
    expect(retired.close).toHaveBeenCalledTimes(closeCount);
    expect(successor.close).not.toHaveBeenCalled();
    expect(successor.open).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("host-worker")).toHaveLength(1);
    await screen.unmount();
    expect(listeners.size).toBe(0);
  },
);
