import { fireEvent, render, screen } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fileEntry } from "@/components/files/__tests__/fixtures";
import { FileViewer } from "@/components/files/file-viewer";
import { useTransfersStore } from "@/data/stores/transfers";
import type { ConnectionInfo, HostTransport } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";

jest.mock("@/components/files/local-file", () => ({
  createLocalDownload: jest.fn(),
  shareLocalFile: jest.fn(),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** A host channel that can stream files; a read starts and never finishes, which is all this needs. */
function streamingTransport(connectionInfo: ConnectionInfo | null) {
  const readFile = jest.fn(() => new Promise<never>(() => undefined));
  const transport = {
    hostId: "dream",
    state: "ready",
    connectionInfo,
    open: async () => undefined,
    close: () => undefined,
    request: async () => undefined,
    cancel: () => undefined,
    on: () => () => undefined,
    readFile,
    readHead: jest.fn(),
    previewImage: jest.fn(),
  } as unknown as HostTransport;
  return { transport, readFile };
}

async function renderViewer(size: number, connectionInfo: ConnectionInfo | null) {
  const { transport, readFile } = streamingTransport(connectionInfo);
  await render(
    <Providers>
      <FileViewer
        entry={fileEntry("/home/me", "disk.img", { size })}
        hostName="dream"
        onDismiss={jest.fn()}
        transport={transport}
      />
    </Providers>,
  );
  return { readFile };
}

beforeEach(() => {
  useTransfersStore.getState().reset();
});

describe("downloading through the relay (OD3)", () => {
  test("a big relayed download says so first, with about how long, and goes on Download anyway", async () => {
    const { readFile } = await renderViewer(200 * 1024 * 1024, { kind: "relay", rttMs: 100 });
    await fireEvent.press(screen.getByText("Download & Share…"));
    // 200 MB at 64 KiB per 100 ms round trip: 320 seconds.
    expect(
      screen.getByText(
        "This transfer goes through the SPAWN D relay because dream and this device can't reach each other directly. 200 MB may take a while. It will take about 5 minutes.",
      ),
    ).toBeOnTheScreen();
    expect(readFile).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText("Download anyway"));
    expect(readFile).toHaveBeenCalledWith("/home/me/disk.img", expect.anything());
    expect(screen.queryByTestId("file-viewer-relay-warning")).toBeNull();
  });

  test("Cancel downloads nothing", async () => {
    const { readFile } = await renderViewer(200 * 1024 * 1024, { kind: "relay", rttMs: 100 });
    await fireEvent.press(screen.getByText("Download & Share…"));
    await fireEvent.press(screen.getByText("Cancel"));
    expect(screen.queryByTestId("file-viewer-relay-warning")).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  test.each([
    ["a direct connection", 200 * 1024 * 1024, { kind: "direct" as const, rttMs: 4 }],
    ["a small file", 50 * 1024 * 1024, { kind: "relay" as const, rttMs: 100 }],
  ])("%s downloads at once", async (_label, size, info) => {
    const { readFile } = await renderViewer(size, info);
    await fireEvent.press(screen.getByText("Download & Share…"));
    expect(screen.queryByTestId("file-viewer-relay-warning")).toBeNull();
    expect(readFile).toHaveBeenCalled();
  });
});
