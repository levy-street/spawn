import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fakeHost, fileEntry, folderEntry } from "@/components/files/__tests__/fixtures";
import { FileExplorer } from "@/components/files/file-explorer";
import { resetExplorerPrefs } from "@/data/stores/explorer-prefs";
import {
  HOST_CONSUMER_LIMIT_CODE,
  HOST_CONSUMER_LIMIT_MESSAGE,
} from "@/terminal/transport/host-ctl-codec";
import type { HostTransport } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";

const HOME = "/Users/charlie";
let mockTransport: HostTransport | null = null;
let mockSurfaceFailure: { code: string; message: string } | null = null;

jest.mock("@/terminal/HostTransportSurface", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  return {
    HostTransportSurface: ({
      onError,
      onStateChange,
      onTransport,
    }: {
      onError?(error: { code: string; message: string; retryable: boolean }): void;
      onStateChange(state: string): void;
      onTransport(transport: unknown): void;
    }) => {
      ReactModule.useEffect(() => {
        onTransport(mockTransport);
        if (mockSurfaceFailure) {
          onError?.({ ...mockSurfaceFailure, retryable: false });
          onStateChange("failed");
        } else {
          onStateChange("ready");
        }
      }, [onError, onStateChange, onTransport]);
      return null;
    },
  };
});

jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));

interface MockListProps<T> {
  data: readonly T[];
  keyExtractor(item: T): string;
  renderItem(info: { item: T; index: number }): ReactNode;
}

jest.mock("@shopify/flash-list", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const Native = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    FlashList: <T,>({ data, keyExtractor, renderItem }: MockListProps<T>) =>
      ReactModule.createElement(
        Native.View,
        null,
        data.map((item, index) =>
          ReactModule.createElement(
            Native.View,
            { key: keyExtractor(item) },
            renderItem({ index, item }),
          ),
        ),
      ),
  };
});

jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => undefined) }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

const clients: QueryClient[] = [];

function renderExplorer(onBack = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  clients.push(client);
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <FileExplorer
            hostId="host-1"
            hostIdentityPublicKey="pk"
            hostName="Charlies-MacBook-Pro.local"
            onBack={onBack}
          />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  resetExplorerPrefs();
  mockTransport = fakeHost({
    home: HOME,
    folders: {
      [HOME]: [
        folderEntry(HOME, "dev"),
        fileEntry(HOME, ".zshrc", { size: 23 }),
        fileEntry(HOME, "notes.md", { size: 40 }),
      ],
      [`${HOME}/dev`]: [fileEntry(`${HOME}/dev`, "main.rs")],
    },
  }).transport;
});

afterEach(() => {
  mockSurfaceFailure = null;
  for (const client of clients.splice(0)) client.clear();
});

describe("FileExplorer", () => {
  test("wears one header, naming the machine and the folder under the screen's name", async () => {
    const onBack = jest.fn();
    await renderExplorer(onBack);

    expect(screen.getByRole("header", { name: "Files" })).toBeOnTheScreen();
    expect(await screen.findByText("Charlies-MacBook-Pro.local · ~")).toBeOnTheScreen();
    // No second bar with a second arrow: the breadcrumbs are the way up.
    expect(screen.queryByRole("button", { name: "Go to parent folder" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Go back" })).toHaveLength(1);
    expect(screen.getByTestId("file-breadcrumbs")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Go back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("keeps the folder's controls behind one overflow, beside the filter", async () => {
    await renderExplorer();
    expect(await screen.findByText("notes.md")).toBeOnTheScreen();
    expect(screen.getByLabelText("Filter this folder")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Folder actions" }));
    expect(screen.getByText("New folder")).toBeOnTheScreen();
    expect(screen.getByText("New file")).toBeOnTheScreen();
    expect(screen.getByText("Go to folder…")).toBeOnTheScreen();
    expect(screen.getByText("Select")).toBeOnTheScreen();
    expect(screen.getByText("View options…")).toBeOnTheScreen();
  });

  test("without a route to push, a folder opens in place", async () => {
    await renderExplorer();
    await fireEvent.press(await screen.findByTestId("file-row-dev"));
    expect(await screen.findByText("main.rs")).toBeOnTheScreen();
    expect(screen.getByText("Charlies-MacBook-Pro.local · ~/dev")).toBeOnTheScreen();
  });

  test("a refused tool channel says too many views are open, and offers Retry", async () => {
    mockSurfaceFailure = { code: HOST_CONSUMER_LIMIT_CODE, message: HOST_CONSUMER_LIMIT_MESSAGE };
    await renderExplorer();
    expect(screen.getByText("Files unavailable")).toBeOnTheScreen();
    expect(screen.getByText(HOST_CONSUMER_LIMIT_MESSAGE)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Retry" })).toBeOnTheScreen();
  });

  test("any other failure keeps the plain connection copy", async () => {
    mockSurfaceFailure = { code: "connect_timeout", message: "Timed out." };
    await renderExplorer();
    expect(
      screen.getByText("The direct host connection could not be established."),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Timed out.")).toBeNull();
  });
});
