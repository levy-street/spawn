import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fakeHost, fileEntry, folderEntry } from "@/components/files/__tests__/fixtures";
import { FileBrowserBody } from "@/components/files/file-browser-body";
import { releaseLocalCopy } from "@/components/files/upload-source";
import { type PickedOriginal, pickOriginalFiles } from "@/components/media/image-source";
import { resetExplorerPrefs } from "@/data/stores/explorer-prefs";
import { useTransfersStore } from "@/data/stores/transfers";
import type { HostTransport } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";

let mockTransport: HostTransport | null = null;

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

jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
jest.mock("expo-router", () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => undefined) }));

jest.mock("@shopify/flash-list", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const Native = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    FlashList: <T,>({
      data,
      keyExtractor,
      renderItem,
    }: {
      data: readonly T[];
      keyExtractor(item: T): string;
      renderItem(info: { item: T; index: number }): ReactNode;
    }) =>
      ReactModule.createElement(
        Native.View,
        { testID: "file-list" },
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

jest.mock("@/components/media/image-source", () => ({ pickOriginalFiles: jest.fn() }));
jest.mock("@/components/files/upload-source", () => ({ releaseLocalCopy: jest.fn() }));

// The sheets have tests of their own; here only what the browser hands them matters.
jest.mock("@/components/files/send-to-host-sheet", () => ({
  SendToHostSheet: ({ visible, entries }: { visible: boolean; entries: { name: string }[] }) => {
    const { Text: NativeText } = jest.requireActual<typeof import("react-native")>("react-native");
    return visible ? (
      <NativeText>{`send:${entries.map((entry) => entry.name).join(",")}`}</NativeText>
    ) : null;
  },
}));
jest.mock("@/components/files/files-open-here", () => ({
  FilesOpenHere: ({ request }: { request: { cwd: string; run: string } | null }) => {
    const { Text: NativeText } = jest.requireActual<typeof import("react-native")>("react-native");
    return request ? <NativeText>{`open-here:${request.run}:${request.cwd}`}</NativeText> : null;
  },
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};
const HOME = "/home/me";
const CAPABILITIES = ["fs.list", "fs.mkdir", "fs.rename", "fs.remove", "fs.write.begin", "fs.read"];
const clients: QueryClient[] = [];
const pick = jest.mocked(pickOriginalFiles);

function picked(name: string, size = 10): PickedOriginal {
  return { uri: `file:///cache/${name}`, name, mimeType: null, size };
}

function sendingTransport(connection: HostTransport["connectionInfo"] = null): HostTransport {
  const host = fakeHost({
    folders: {
      [HOME]: [
        folderEntry(HOME, "src"),
        fileEntry(HOME, "notes2.md", { size: 4 }),
        fileEntry(HOME, "notes10.md", { size: 4 }),
      ],
    },
    capabilities: CAPABILITIES,
  });
  return Object.assign(host.transport, {
    transferFileTo: jest.fn(),
    connectionInfo: connection,
  });
}

async function renderBody(extra: Partial<React.ComponentProps<typeof FileBrowserBody>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  clients.push(queryClient);
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <FileBrowserBody
            hostId="host-1"
            hostIdentityPublicKey="pk"
            hostName="dream"
            onOpenFolder={jest.fn()}
            {...extra}
          />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await screen.findByText("notes2.md");
  return view;
}

async function folderMenu(): Promise<void> {
  await fireEvent.press(screen.getByRole("button", { name: "Folder actions" }));
}

function queued(): { name: string; policy: string }[] {
  return useTransfersStore
    .getState()
    .batches.flatMap((batch) => batch.items.map(({ name, policy }) => ({ name, policy })));
}

beforeEach(() => {
  resetExplorerPrefs();
  useTransfersStore.getState().reset();
  pick.mockReset();
  jest.mocked(releaseLocalCopy).mockClear();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe("uploading into the folder on screen", () => {
  test("Files and Photos each queue what was picked into this folder, and the banner shows it", async () => {
    mockTransport = sendingTransport();
    await renderBody();
    pick.mockResolvedValueOnce([picked("a.txt"), picked("b.txt")]);
    await folderMenu();
    await fireEvent.press(screen.getByText("Upload from Files…"));
    expect(pick).toHaveBeenLastCalledWith("files");
    expect(queued()).toEqual([
      { name: "a.txt", policy: "ask" },
      { name: "b.txt", policy: "ask" },
    ]);
    const batch = useTransfersStore.getState().batches[0];
    expect(batch).toMatchObject({
      kind: "upload",
      destDir: HOME,
      destLabel: "Home",
      destination: { id: "host-1", name: "dream", publicKey: "pk" },
    });
    // One upload of two files is one transfer.
    expect(await screen.findByText("1 transfer · 0%")).toBeOnTheScreen();

    pick.mockResolvedValueOnce([picked("IMG_1.HEIC")]);
    await folderMenu();
    await fireEvent.press(screen.getByText("Upload from Photos…"));
    expect(pick).toHaveBeenLastCalledWith("photos");
    expect(queued().map((item) => item.name)).toEqual(["a.txt", "b.txt", "IMG_1.HEIC"]);
    expect(await screen.findByText("2 transfers · 0%")).toBeOnTheScreen();
  });

  test("a picked name the folder already holds is asked about first, and can answer for the rest", async () => {
    mockTransport = sendingTransport();
    await renderBody();
    pick.mockResolvedValueOnce([picked("notes2.md"), picked("notes10.md"), picked("new.txt")]);
    await folderMenu();
    await fireEvent.press(screen.getByText("Upload from Files…"));

    const sheet = await screen.findByTestId("upload-conflict-sheet");
    expect(
      within(sheet).getByText("“notes2.md” already exists in Home on dream."),
    ).toBeOnTheScreen();
    await fireEvent.press(within(sheet).getByRole("switch", { name: "Do this for the other 1" }));
    await fireEvent.press(within(sheet).getByText("Keep both"));
    expect(queued()).toEqual([
      { name: "notes2.md", policy: "keep_both" },
      { name: "notes10.md", policy: "keep_both" },
      { name: "new.txt", policy: "ask" },
    ]);
  });

  test("answering one at a time asks about each; cancelling uploads nothing and lets the copies go", async () => {
    mockTransport = sendingTransport();
    await renderBody();
    pick.mockResolvedValueOnce([picked("notes2.md"), picked("notes10.md")]);
    await folderMenu();
    await fireEvent.press(screen.getByText("Upload from Files…"));
    await fireEvent.press(await screen.findByTestId("upload-conflict-replace"));
    expect(
      await screen.findByText("“notes10.md” already exists in Home on dream."),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("upload-conflict-cancel"));
    expect(queued()).toEqual([]);
    expect(jest.mocked(releaseLocalCopy).mock.calls.map(([uri]) => uri)).toEqual([
      "file:///cache/notes2.md",
      "file:///cache/notes10.md",
    ]);
  });

  test("a big upload through the relay says so before it starts, and about how long (OD3)", async () => {
    mockTransport = sendingTransport({ kind: "relay", rttMs: 90 });
    await renderBody();
    pick.mockResolvedValueOnce([picked("disk.img", 200 * 1024 * 1024)]);
    await folderMenu();
    await fireEvent.press(screen.getByText("Upload from Files…"));
    // 200 MB at 64 KiB per 90 ms round trip: 288 seconds.
    expect(
      await screen.findByText(
        "This transfer goes through the SPAWN D relay because dream and this device can't reach each other directly. 200 MB may take a while. It will take about 5 minutes.",
      ),
    ).toBeOnTheScreen();
    expect(queued()).toEqual([]);
    await fireEvent.press(screen.getByText("Upload anyway"));
    expect(queued()).toEqual([{ name: "disk.img", policy: "ask" }]);
  });

  test("exactly 100 MB through the relay is not warned about: only above it (OD3)", async () => {
    mockTransport = sendingTransport({ kind: "relay", rttMs: 90 });
    await renderBody();
    pick.mockResolvedValueOnce([picked("exact.img", 100 * 1024 * 1024)]);
    await folderMenu();
    await fireEvent.press(screen.getByText("Upload from Files…"));
    expect(queued()).toEqual([{ name: "exact.img", policy: "ask" }]);
  });

  test("a picked file whose name a folder holds is offered only Keep both and Skip", async () => {
    mockTransport = sendingTransport();
    await renderBody();
    pick.mockResolvedValueOnce([picked("src")]);
    await folderMenu();
    await fireEvent.press(screen.getByText("Upload from Files…"));
    const sheet = await screen.findByTestId("upload-conflict-sheet");
    expect(within(sheet).getByText("“src” already exists in Home on dream.")).toBeOnTheScreen();
    expect(within(sheet).queryByText("Replace")).toBeNull();
    await fireEvent.press(within(sheet).getByText("Keep both"));
    expect(queued()).toEqual([{ name: "src", policy: "keep_both" }]);
  });

  test("a file over 512 MiB is refused at once, with the reason, and the rest go", async () => {
    mockTransport = sendingTransport();
    await renderBody();
    pick.mockResolvedValueOnce([picked("small.txt"), picked("huge.iso", 600 * 1024 * 1024)]);
    await folderMenu();
    await fireEvent.press(screen.getByText("Upload from Files…"));
    const items = useTransfersStore.getState().batches[0]?.items ?? [];
    expect(items.map((item) => [item.name, item.state, item.error])).toEqual([
      ["small.txt", "queued", null],
      [
        "huge.iso",
        "failed",
        "“huge.iso” is larger than 512 MB, the most SPAWN D can move in one file.",
      ],
    ]);
  });
});

describe("sending to another host and opening here", () => {
  test("a folder can't be downloaded on the phone yet, but can be sent", async () => {
    mockTransport = sendingTransport();
    await renderBody();
    await fireEvent.press(screen.getByRole("button", { name: "Actions for src" }));
    expect(screen.getByText("Folders can't be downloaded on the phone yet.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Send to another host…"));
    expect(await screen.findByText("send:src")).toBeOnTheScreen();
  });

  test("selection sends what is picked", async () => {
    mockTransport = sendingTransport();
    await renderBody();
    await fireEvent(screen.getByTestId("file-row-notes2.md"), "longPress");
    await fireEvent.press(screen.getByTestId("file-row-notes10.md"));
    // A short label on the bar, named as the menu names it.
    await fireEvent.press(screen.getByRole("button", { name: "Send to another host…" }));
    expect(await screen.findByText(/^send:/u)).toHaveTextContent("send:notes2.md,notes10.md");
  });

  test("open here is not offered where the new window could not be shown", async () => {
    mockTransport = sendingTransport();
    await renderBody();
    await folderMenu();
    expect(screen.getByText("Upload from Files…")).toBeOnTheScreen();
    expect(screen.queryByText("Open terminal here")).toBeNull();
  });

  test("open here starts from the folder on screen, or the folder a row names", async () => {
    mockTransport = sendingTransport();
    await renderBody({ onWindowOpened: jest.fn() });
    await folderMenu();
    await fireEvent.press(screen.getByText("Open terminal here"));
    expect(await screen.findByText(`open-here:shell:${HOME}`)).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Actions for src" }));
    // The folder's own menu may still be on its way out; the row's is the newest.
    const rowAction = screen.getAllByText("Start agent here…").at(-1);
    if (!rowAction) throw new Error("No row action");
    await fireEvent.press(rowAction);
    expect(await screen.findByText(`open-here:agent:${HOME}/src`)).toBeOnTheScreen();
  });
});
