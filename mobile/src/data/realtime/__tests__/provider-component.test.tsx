import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { Text as NativeText } from "react-native";

import { RealtimeProvider } from "@/data/realtime/provider";
import type { SocketState } from "@/data/realtime/socket";
import { useConnectionStore } from "@/data/stores/connection";

let mockToken: string | null = null;
let mockTokenListener: (() => void) | undefined;
let mockStateListener: ((state: SocketState) => void) | undefined;
const mockConnect = jest.fn();
const mockRetire = jest.fn();
const mockHardReconnect = jest.fn();
const mockClose = jest.fn();

jest.mock("@/data/api/auth-token", () => ({
  authToken: {
    get: jest.fn(async () => mockToken),
    subscribe: jest.fn((listener: () => void) => {
      mockTokenListener = listener;
      return () => {
        mockTokenListener = undefined;
      };
    }),
  },
}));

jest.mock("@/data/realtime/alert-socket", () => ({
  AlertSocketClient: jest.fn(() => ({
    state: "idle",
    connect: mockConnect,
    retire: mockRetire,
    hardReconnect: mockHardReconnect,
    close: mockClose,
    subscribe: (listener: (state: SocketState) => void) => {
      mockStateListener = listener;
      return () => {
        mockStateListener = undefined;
      };
    },
    onFrame: () => () => undefined,
  })),
}));

jest.mock("@/data/realtime/lifecycle", () => ({
  installRealtimeLifecycle: jest.fn(() => ({ dispose: jest.fn() })),
  reopenRegisteredGenerations: jest.fn(async () => undefined),
  retireRegisteredGenerations: jest.fn(),
}));

jest.mock("@/theme", () => {
  const actual = jest.requireActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useTheme: () => actual.darkTheme };
});

function Wrapper({ children }: PropsWithChildren): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("RealtimeProvider socket auth", () => {
  beforeEach(() => {
    mockToken = null;
    mockTokenListener = undefined;
    mockStateListener = undefined;
    jest.clearAllMocks();
    useConnectionStore.getState().reset();
  });

  test("retires without a token, connects after sign-in, and exposes persistent retry", async () => {
    const screen = await render(
      <RealtimeProvider>
        <NativeText>Application</NativeText>
      </RealtimeProvider>,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(mockRetire).toHaveBeenCalledTimes(1));
    expect(mockConnect).not.toHaveBeenCalled();

    mockToken = "access-token";
    mockTokenListener?.();
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));

    await act(() => mockStateListener?.("failed"));
    await waitFor(() => expect(screen.getByText("Live updates paused —")).toBeOnTheScreen());
    fireEvent.press(screen.getByRole("button", { name: "Retry" }));
    expect(mockHardReconnect).toHaveBeenCalledTimes(1);

    mockToken = null;
    mockTokenListener?.();
    await waitFor(() => expect(mockRetire).toHaveBeenCalledTimes(2));
  });
});
