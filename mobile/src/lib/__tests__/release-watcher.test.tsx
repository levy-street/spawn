import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Release } from "@/data/api/schemas/release";
import { ReleaseWatcher } from "@/lib/release-watcher";
import type { MobileUpdatesClient } from "@/lib/updates";
import { ThemeProvider } from "@/theme";

const mockReleaseRefetch = jest.fn();
let mockProtocolListener: (() => void) | null = null;

// The overlay presents into a window-level container that has no test
// renderer behind it; everything else about it renders for real.
jest.mock("react-native-screens", () => {
  const ReactModule = jest.requireActual("react") as typeof import("react");
  const Native = jest.requireActual("react-native") as typeof import("react-native");
  return {
    FullWindowOverlay: ({ children }: PropsWithChildren) =>
      ReactModule.createElement(Native.View, { testID: "update-window-overlay" }, children),
  };
});

jest.mock("@/data/queries/release", () => ({
  useRelease: () => ({ refetch: mockReleaseRefetch }),
}));

jest.mock("@/data/realtime/socket", () => ({
  subscribeProtocolRequired: (listener: () => void) => {
    mockProtocolListener = listener;
    return () => {
      mockProtocolListener = null;
    };
  },
}));

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: { version: "0.1.0", extra: { mobileTree: "client-tree" } },
  },
}));

jest.mock("expo-updates", () => ({
  isEnabled: false,
  runtimeVersion: null,
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

function release(overrides: Partial<Release["mobile"]> = {}): Release {
  return {
    server: { commit: "commit", dirty: false },
    web: { build_id: "build" },
    daemon: null,
    mobile: { tree: "client-tree", runtime_version: "0.1.0", ...overrides },
    protocols: { daemon: "daemon", browser: "browser", alerts: "alerts" },
  };
}

function fakeUpdates(available: boolean): MobileUpdatesClient {
  return {
    isEnabled: true,
    runtimeVersion: "0.1.0",
    checkForUpdateAsync: jest.fn(async () => available),
    fetchUpdateAsync: jest.fn(async () => undefined),
    reloadAsync: jest.fn(async () => undefined),
  };
}

describe("ReleaseWatcher", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProtocolListener = null;
  });

  it("downloads an advertised OTA and offers to take it in place", async () => {
    const updates = fakeUpdates(true);
    mockReleaseRefetch.mockResolvedValue({ data: release({ tree: "server-tree" }) });
    await render(
      <Providers>
        <ReleaseWatcher updates={updates} />
      </Providers>,
    );

    await waitFor(() => expect(screen.getByText("A new SPAWN D is ready")).toBeOnTheScreen());
    expect(
      screen.getByText(
        "It is already downloaded. Updating takes a moment, and your sessions keep running.",
      ),
    ).toBeOnTheScreen();
    expect(updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);

    // Optional, so it keeps a way out — and the way in takes the update
    // without anyone leaving the app.
    expect(screen.getByText("Later")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Update now"));
    expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it("tells a stranded phone what to do and lets it off the screen", async () => {
    const updates = fakeUpdates(false);
    mockReleaseRefetch.mockResolvedValue({ data: release() });
    await render(
      <Providers>
        <ReleaseWatcher updates={updates} />
      </Providers>,
    );
    await waitFor(() => expect(mockReleaseRefetch).toHaveBeenCalledTimes(1));

    await act(async () => mockProtocolListener?.());

    await waitFor(() => expect(screen.getByText("Update SPAWN D")).toBeOnTheScreen());
    // There is no listing yet, so there is no App Store to send anyone to —
    // and a hard prompt with nowhere to go must not also be a locked door.
    expect(
      screen.getByText(
        "This version of SPAWN D no longer works with the server. It cannot update itself yet — SPAWN D is not in the App Store — so reinstall it from wherever you installed it.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Open App Store")).toBeNull();
    expect(screen.queryByText("Later")).toBeNull();
    expect(screen.getByText("Close")).toBeOnTheScreen();
  });
});
