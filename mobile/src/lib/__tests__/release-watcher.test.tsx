import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import type { Release } from "@/data/api/schemas/release";
import { ReleaseWatcher } from "@/lib/release-watcher";
import type { MobileUpdatesClient } from "@/lib/updates";
import { ThemeProvider } from "@/theme";

const mockReleaseRefetch = jest.fn();
let mockProtocolListener: (() => void) | null = null;

function mockDialog({
  children,
  footer,
  title,
  visible,
}: {
  children?: ReactNode;
  footer?: ReactNode;
  title?: string;
  visible: boolean;
}) {
  if (!visible) return null;
  const NativeText = require("react-native").Text;
  return (
    <View>
      <NativeText>{title}</NativeText>
      {children}
      {footer}
    </View>
  );
}

jest.mock("@/components/ui/dialog", () => ({ Dialog: mockDialog }));

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

  it("downloads an advertised OTA and offers the exact restart prompt", async () => {
    const updates = fakeUpdates(true);
    mockReleaseRefetch.mockResolvedValue({ data: release({ tree: "server-tree" }) });
    await render(
      <ThemeProvider>
        <ReleaseWatcher updates={updates} />
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByText("SPAWN D has been updated")).toBeOnTheScreen());
    expect(screen.getByText("Restart to pick up the new version.")).toBeOnTheScreen();
    expect(updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Restart now"));
    expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it("tells a stranded phone what to do and lets it out of the dialog", async () => {
    const updates = fakeUpdates(false);
    mockReleaseRefetch.mockResolvedValue({ data: release() });
    await render(
      <ThemeProvider>
        <ReleaseWatcher updates={updates} />
      </ThemeProvider>,
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
