import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { FileExplorer } from "@/components/files/file-explorer";
import type { HostDirEntry } from "@/components/files/types";
import { ThemeProvider } from "@/theme";

const mockTransport = {
  hostId: "host-1",
  state: "ready",
  open: jest.fn(async () => undefined),
  close: jest.fn(),
  request: jest.fn(),
  stream: jest.fn(),
  on: jest.fn(() => () => undefined),
};

const mockEntries: HostDirEntry[] = [
  { is_dir: true, kind: "directory", name: "dev", path: "/Users/charlie/dev" },
  { is_dir: false, kind: "file", name: ".zshrc", path: "/Users/charlie/.zshrc", size: 23 },
  { is_dir: false, kind: "file", name: "notes.md", path: "/Users/charlie/notes.md", size: 40 },
];

jest.mock("@/terminal/HostTransportSurface", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  return {
    HostTransportSurface: ({
      onStateChange,
      onTransport,
    }: {
      onStateChange(state: string): void;
      onTransport(transport: unknown): void;
    }) => {
      ReactModule.useEffect(() => {
        onTransport(mockTransport);
        onStateChange("ready");
      }, [onStateChange, onTransport]);
      return null;
    },
  };
});

jest.mock("@/data/queries/files", () => ({
  createHostFolder: jest.fn(),
  removeHostEntry: jest.fn(),
  renameHostEntry: jest.fn(),
  useHostDirectory: () => ({
    data: { pages: [{ entries: mockEntries, home_dir: "/Users/charlie", path: "/Users/charlie" }] },
    error: null,
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isLoading: false,
    isRefetching: false,
    refetch: jest.fn(),
  }),
  useHostHome: () => ({ data: { home_dir: "/Users/charlie" }, isLoading: false }),
}));

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

// The viewer's web view has no native module here, and nothing below opens it.
jest.mock("react-native-webview", () => ({ __esModule: true, default: () => null }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function renderExplorer(onBack = jest.fn()) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={new QueryClient()}>
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

describe("FileExplorer", () => {
  test("wears one header, naming the machine under the screen's name", async () => {
    const onBack = jest.fn();
    await renderExplorer(onBack);

    expect(screen.getByRole("header", { name: "Files" })).toBeOnTheScreen();
    expect(screen.getByText("Charlies-MacBook-Pro.local")).toBeOnTheScreen();
    // No second bar with a second arrow: the breadcrumbs are the way up.
    expect(screen.queryByRole("button", { name: "Go to parent folder" })).toBeNull();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Go back" })).toHaveLength(1);
    expect(screen.getByTestId("file-breadcrumbs")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Go back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("keeps the folder's controls behind the header's overflow", async () => {
    await renderExplorer();
    expect(screen.getByText(".zshrc")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Folder actions" }));
    expect(screen.getByText("New folder")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Hide dotfiles"));

    expect(screen.queryByText(".zshrc")).toBeNull();
    expect(screen.getByText("notes.md")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Folder actions" }));
    expect(screen.getByText("Show dotfiles")).toBeOnTheScreen();
  });
});
