import { fireEvent, render, screen } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fakeHost, fileEntry, folderEntry } from "@/components/files/__tests__/fixtures";
import { SendToHostSheet, samePlaceOn } from "@/components/files/send-to-host-sheet";
import { makeHost } from "@/components/launcher/__tests__/fixtures";
import { useTransfersStore } from "@/data/stores/transfers";
import type { HostTransport } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";

const HOME = "/home/me";
const THERE = "/Users/you";
let mockDest: HostTransport | null = null;
const mockHosts = [
  makeHost({ id: "src", name: "dream", os: "linux" }),
  makeHost({ id: "mini", name: "mac-mini", os: "darwin" }),
  makeHost({ id: "box", name: "box", status: "offline" }),
];

jest.mock("@/data/queries/hosts", () => ({
  useHostsQuery: () => ({ data: mockHosts, isPending: false }),
}));
jest.mock("@/components/trust/device-approval-gate", () => ({
  useDeviceApprovalGate: () => ({ guard: (_id: string, run: () => void) => run(), overlay: null }),
}));
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
        onTransport(mockDest);
        onStateChange("ready");
      }, [onStateChange, onTransport]);
      return null;
    },
  };
});
// The folder picker has tests of its own; here it only says where it starts and picks that.
jest.mock("@/components/launcher/folder-picker", () => ({
  FolderPicker: ({
    initialPath,
    onSelect,
  }: {
    initialPath: string;
    onSelect(path: string): void;
  }) => {
    const Native = jest.requireActual<typeof import("react-native")>("react-native");
    return (
      <Native.Pressable accessibilityRole="button" onPress={() => onSelect(initialPath)}>
        <Native.Text>{`Choose ${initialPath}`}</Native.Text>
      </Native.Pressable>
    );
  },
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

const CODE = `${HOME}/code`;

function source(): HostTransport {
  return fakeHost({
    home: HOME,
    folders: {
      [CODE]: [folderEntry(CODE, "proj"), fileEntry(CODE, "a.txt", { size: 10 })],
      [`${CODE}/proj`]: [
        fileEntry(`${CODE}/proj`, "b.txt", { size: 5 }),
        { name: "link", path: `${CODE}/proj/link`, kind: "symlink", is_dir: false },
      ],
    },
    capabilities: ["fs.list", "fs.read"],
  }).transport;
}

async function renderSheet(sourceTransport: HostTransport, size = 10) {
  const onDismiss = jest.fn();
  await render(
    <Providers>
      <SendToHostSheet
        entries={[folderEntry(CODE, "proj"), fileEntry(CODE, "a.txt", { size })]}
        onDismiss={onDismiss}
        source={{ id: "src", name: "dream", publicKey: "k", os: "linux" }}
        sourceFolder={CODE}
        sourceHomeDir={HOME}
        sourceTransport={sourceTransport}
        visible
      />
    </Providers>,
  );
  return { onDismiss };
}

beforeEach(() => {
  useTransfersStore.getState().reset();
  mockDest = fakeHost({
    home: THERE,
    folders: { [THERE]: [folderEntry(THERE, "code")], [`${THERE}/code`]: [] },
    capabilities: ["fs.list", "fs.write.begin"],
  }).transport;
});

describe("sending to another host", () => {
  test("the same place below home is offered on the other host", () => {
    expect(samePlaceOn(`${HOME}/code/spawn`, HOME, "posix", "C:\\Users\\you", "windows")).toBe(
      "C:\\Users\\you\\code\\spawn",
    );
  });

  test("picks a host, a folder and an answer for taken names, then queues each item", async () => {
    const { onDismiss } = await renderSheet(source());
    expect(screen.getByText("Send to which host?")).toBeOnTheScreen();
    expect(screen.queryByText("dream")).toBeNull();
    // Only an offline host says so; an online one needs no word.
    expect(screen.getByText("Offline")).toBeOnTheScreen();
    expect(screen.queryByText("Online")).toBeNull();

    await fireEvent.press(screen.getByText("mac-mini"));
    // The same place exists there, so the picker starts in it.
    await fireEvent.press(await screen.findByText(`Choose ${THERE}/code`));

    expect(await screen.findByText("2 items · 15 B")).toBeOnTheScreen();
    expect(screen.getByText("Into code on mac-mini")).toBeOnTheScreen();
    expect(screen.getByText("1 link was skipped.")).toBeOnTheScreen();
    expect(screen.getByText("Permissions aren't copied between hosts.")).toBeOnTheScreen();
    expect(screen.getByText("If an item is already there")).toBeOnTheScreen();
    // Asking is the default, as on the web, and each choice says what it does.
    expect(screen.getByRole("radio", { name: "Ask each time" })).toBeChecked();
    expect(screen.getByText("Nothing already there changes without your say")).toBeOnTheScreen();
    expect(
      screen.getByText("Files with the same name are replaced, and folders merged"),
    ).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("radio", { name: "Replace" }));
    await fireEvent.press(screen.getByTestId("send-confirm"));
    const [batch] = useTransfersStore.getState().batches;
    expect(batch).toMatchObject({
      kind: "send",
      source: { id: "src" },
      destination: { id: "mini", name: "mac-mini", publicKey: "host-key", os: "darwin" },
      destDir: `${THERE}/code`,
      destLabel: "code",
      names: ["proj", "a.txt"],
    });
    // Each picked item carries the answer; what is inside a folder follows its folder.
    expect(batch?.items.map((item) => [item.kind, item.relative.join("/"), item.policy])).toEqual([
      ["folder", "proj", "replace"],
      ["file", "a.txt", "replace"],
      ["file", "proj/b.txt", "ask"],
    ]);
    expect(onDismiss).toHaveBeenCalled();
  });

  test("asks about each picked item already there before anything is queued", async () => {
    mockDest = fakeHost({
      home: THERE,
      folders: {
        [THERE]: [folderEntry(THERE, "code")],
        [`${THERE}/code`]: [
          folderEntry(`${THERE}/code`, "proj"),
          fileEntry(`${THERE}/code`, "a.txt"),
        ],
      },
      capabilities: ["fs.list", "fs.write.begin"],
    }).transport;
    await renderSheet(source());
    await fireEvent.press(screen.getByText("mac-mini"));
    await fireEvent.press(await screen.findByText(`Choose ${THERE}/code`));
    await screen.findByText("2 items · 15 B");
    await fireEvent.press(screen.getByTestId("send-confirm"));

    expect(
      await screen.findByText("A folder named “proj” already exists in code on mac-mini."),
    ).toBeOnTheScreen();
    expect(useTransfersStore.getState().batches).toEqual([]);
    // Between two folders, Replace merges, and says so.
    await fireEvent.press(screen.getByText("Merge"));
    expect(
      await screen.findByText("“a.txt” already exists in code on mac-mini."),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("send-conflict-keep_both"));

    const [batch] = useTransfersStore.getState().batches;
    expect(batch?.items.map((item) => [item.relative.join("/"), item.policy])).toEqual([
      ["proj", "replace"],
      ["a.txt", "keep_both"],
      ["proj/b.txt", "ask"],
    ]);
  });

  test("a pick of an empty folder is sent as that folder", async () => {
    await render(
      <Providers>
        <SendToHostSheet
          entries={[folderEntry(`${CODE}`, "empty")]}
          onDismiss={jest.fn()}
          source={{ id: "src", name: "dream", publicKey: "k", os: "linux" }}
          sourceFolder={CODE}
          sourceHomeDir={HOME}
          sourceTransport={
            fakeHost({
              home: HOME,
              folders: { [CODE]: [folderEntry(CODE, "empty")], [`${CODE}/empty`]: [] },
              capabilities: ["fs.list", "fs.read"],
            }).transport
          }
          visible
        />
      </Providers>,
    );
    await fireEvent.press(screen.getByText("mac-mini"));
    await fireEvent.press(await screen.findByText(`Choose ${THERE}/code`));
    expect(await screen.findByText("1 empty folder")).toBeOnTheScreen();
    expect(screen.getByTestId("send-confirm")).toBeEnabled();
    await fireEvent.press(screen.getByTestId("send-confirm"));
    expect(
      useTransfersStore.getState().batches[0]?.items.map((item) => [item.kind, item.name]),
    ).toEqual([["folder", "empty"]]);
  });

  test("a big send through the relay says so before it starts, and about how long (OD3)", async () => {
    mockDest = Object.assign(
      fakeHost({ home: THERE, folders: { [THERE]: [] }, capabilities: ["fs.list"] }).transport,
      { connectionInfo: { kind: "relay" as const, rttMs: 120 } },
    );
    await renderSheet(source(), 200 * 1024 * 1024);
    await fireEvent.press(screen.getByText("mac-mini"));
    // No same place there: home it is.
    await fireEvent.press(await screen.findByText(`Choose ${THERE}`));
    // 200 MB at 64 KiB per 120 ms round trip, the slower leg: 384 seconds.
    expect(
      await screen.findByText(
        "This transfer goes through the SPAWN D relay because mac-mini and this device can't reach each other directly. 200 MB may take a while. It will take about 6 minutes.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("Into Home on mac-mini")).toBeOnTheScreen();
    expect(screen.getByTestId("send-confirm")).toHaveTextContent("Send anyway");
  });
});
