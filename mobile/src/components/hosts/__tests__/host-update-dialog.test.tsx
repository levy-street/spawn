import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import type { ReactNode } from "react";
import { View } from "react-native";
import { onlineHost } from "@/components/hosts/__tests__/fixtures";
import { HostUpdateDialog } from "@/components/hosts/host-update-dialog";
import type { HostOut } from "@/data/api/schemas/hosts";
import { ThemeProvider } from "@/theme";

let mockPollingHost: HostOut = onlineHost;
const mockMutate = jest.fn();
const mockReset = jest.fn();

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

jest.mock("@/data/api/config", () => ({
  getBaseUrl: jest.fn(async () => "https://spawn.example.com/path"),
}));

jest.mock("@/data/queries/hosts", () => ({
  useHostUpdatePolling: () => ({ data: mockPollingHost, error: null, isError: false }),
  useUpdateHost: () => ({
    error: null,
    isPending: false,
    mutate: mockMutate,
    reset: mockReset,
  }),
}));

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

function availableHost(overrides: Partial<HostOut> = {}): HostOut {
  return {
    ...onlineHost,
    daemon_tree: "old-tree",
    update: {
      state: "available",
      latest_version: "0.1.0+gnew",
      error: null,
      requested_at: null,
    },
    ...overrides,
  };
}

describe("HostUpdateDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPollingHost = availableHost();
  });

  it("shows the shared available copy and lets Not now continue", async () => {
    const onNotNow = jest.fn();
    const onDismiss = jest.fn();
    await render(
      <ThemeProvider>
        <HostUpdateDialog
          host={mockPollingHost}
          onDismiss={onDismiss}
          onNotNow={onNotNow}
          visible
        />
      </ThemeProvider>,
    );

    expect(screen.getByText(`Update SPAWN D on ${onlineHost.name}`)).toBeOnTheScreen();
    expect(
      screen.getByText(
        `This machine is running an older SPAWN D daemon (${onlineHost.version}). Update it to keep working with this version of the app. Running sessions are kept.`,
      ),
    ).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("Update now"));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText("Not now"));
    expect(onNotNow).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows the failed recovery command and copies the active server origin", async () => {
    mockPollingHost = availableHost({
      update: {
        state: "failed",
        latest_version: "0.1.0+gnew",
        error: "verification failed",
        requested_at: "2026-08-25T00:00:00Z",
      },
    });
    await render(
      <ThemeProvider>
        <HostUpdateDialog host={mockPollingHost} onDismiss={jest.fn()} visible />
      </ThemeProvider>,
    );

    expect(
      screen.getByText(
        "The update did not complete: verification failed. Run this on the machine:",
      ),
    ).toBeOnTheScreen();
    await waitFor(() =>
      expect(
        screen.getByText("curl -fsSL https://spawn.example.com/install.sh | sh"),
      ).toBeOnTheScreen(),
    );
    await fireEvent.press(screen.getByLabelText("Copy install command"));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      "curl -fsSL https://spawn.example.com/install.sh | sh",
    );
  });

  it("uses the host OS for Windows recovery even when the controlling phone is not Windows", async () => {
    mockPollingHost = availableHost({
      os: "windows",
      arch: "x86_64",
      update: {
        state: "unsupported",
        latest_version: null,
        error: "self-update unavailable",
        requested_at: null,
      },
    });
    await render(
      <ThemeProvider>
        <HostUpdateDialog host={mockPollingHost} onDismiss={jest.fn()} visible />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("irm https://spawn.example.com/install.ps1 | iex")).toBeOnTheScreen(),
    );
    await fireEvent.press(screen.getByLabelText("Copy install command"));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      "irm https://spawn.example.com/install.ps1 | iex",
    );
  });

  it("keeps WSL hosts on the Linux installer fallback", async () => {
    mockPollingHost = availableHost({
      os: "linux",
      update: {
        state: "unsupported",
        latest_version: null,
        error: "self-update unavailable",
        requested_at: null,
      },
    });
    await render(
      <ThemeProvider>
        <HostUpdateDialog host={mockPollingHost} onDismiss={jest.fn()} visible />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByText("curl -fsSL https://spawn.example.com/install.sh | sh"),
      ).toBeOnTheScreen(),
    );
  });
});
