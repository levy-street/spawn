import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import type { ReactElement, ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  fakeHost,
  fileEntry,
  folderEntry,
  fsError,
  requestLog,
} from "@/components/files/__tests__/fixtures";
import { FileBrowserBody, type FolderNavigation } from "@/components/files/file-browser-body";
import { HOST_LISTING_POLL_MS } from "@/data/queries/files";
import {
  FILE_VIEW_OPTIONS_KEY,
  resetExplorerPrefs,
  SHOW_HIDDEN_KEY,
} from "@/data/stores/explorer-prefs";
import type { HostTransport } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";

let mockTransport: HostTransport | null = null;
let mockFocused = true;
const mockSurfaceMounts = jest.fn();

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
        mockSurfaceMounts();
        onTransport(mockTransport);
        onStateChange("ready");
      }, [onStateChange, onTransport]);
      return null;
    },
  };
});

jest.mock("@react-navigation/native", () => ({ useIsFocused: () => mockFocused }));
// The send and open-here sheets reach the device-approval overlay, which routes.
jest.mock("expo-router", () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));

interface MockListProps<T> {
  data: readonly T[];
  keyExtractor(item: T): string;
  renderItem(info: { item: T; index: number }): ReactNode;
  ListHeaderComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
}

jest.mock("@shopify/flash-list", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const Native = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    FlashList: <T,>({
      data,
      keyExtractor,
      renderItem,
      ListHeaderComponent,
      ListFooterComponent,
    }: MockListProps<T>) =>
      ReactModule.createElement(
        Native.View,
        { testID: "file-list" },
        ListHeaderComponent ?? null,
        data.map((item, index) =>
          ReactModule.createElement(
            Native.View,
            { key: keyExtractor(item) },
            renderItem({ index, item }),
          ),
        ),
        ListFooterComponent ?? null,
      ),
  };
});

jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => undefined) }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};
const HOME = "/home/me";

function homeFolder() {
  return [
    fileEntry(HOME, "notes10.md", { size: 40, modified_at: 100 }),
    folderEntry(HOME, "src", { modified_at: 50 }),
    fileEntry(HOME, ".zshrc", { size: 23, modified_at: 10 }),
    fileEntry(HOME, "notes2.md", { size: 4000, modified_at: 300 }),
    folderEntry(HOME, "Docs", { modified_at: 400 }),
  ];
}

const clients: QueryClient[] = [];

async function renderBody(props: Partial<React.ComponentProps<typeof FileBrowserBody>> = {}) {
  // No garbage-collection timers: they would keep the test process alive.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  clients.push(queryClient);
  const onOpenFolder = jest.fn<void, [FolderNavigation]>();
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <FileBrowserBody
            hostId="host-1"
            hostIdentityPublicKey="pk"
            hostName="dream"
            onOpenFolder={onOpenFolder}
            {...props}
          />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  return { ...view, onOpenFolder, queryClient };
}

function rowNames(): string[] {
  return screen
    .getAllByTestId(/^file-row-/u)
    .map((row) => String(row.props["testID"]).replace(/^file-row-/u, ""));
}

/**
 * Long enough for a 200 ms drawer exit and a 150 ms dialog exit to finish on a
 * runner that is ten times slower than a desk, and short of the 5 s a test has.
 */
const OVERLAY_SETTLE_MS = 3000;

/**
 * Opens the folder's ⋯ menu once whatever the last step raised has finished
 * leaving. A drawer raised again while its own exit still plays is taken down
 * when that exit ends, and a dialog's exit is what releases the drawer it was
 * raised from (overlay-stack.ts). Pressed in the middle of either, the menu can
 * close again before its rows are read.
 */
async function openFolderActions() {
  await waitFor(
    () => {
      expect(screen.queryByTestId("sheet-overlay")).toBeNull();
      expect(screen.queryByTestId("dialog-window")).toBeNull();
    },
    { timeout: OVERLAY_SETTLE_MS },
  );
  await fireEvent.press(screen.getByRole("button", { name: "Folder actions" }));
  await screen.findByTestId("sheet-content");
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

beforeEach(() => {
  resetExplorerPrefs();
  mockFocused = true;
  mockSurfaceMounts.mockClear();
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  jest.mocked(AsyncStorage.setItem).mockClear();
});

describe("FileBrowserBody", () => {
  test("lists folders first in natural order, with hidden files kept back and counted", async () => {
    mockTransport = fakeHost({ folders: { [HOME]: homeFolder() } }).transport;
    await renderBody();

    expect(await screen.findByText("notes2.md")).toBeOnTheScreen();
    expect(rowNames()).toEqual(["Docs", "src", "notes2.md", "notes10.md"]);
    expect(screen.getByText("4 items · 1 hidden")).toBeOnTheScreen();
    expect(screen.queryByText(".zshrc")).toBeNull();
  });

  test("filters as you type, and says when nothing matches", async () => {
    mockTransport = fakeHost({ folders: { [HOME]: homeFolder() } }).transport;
    await renderBody();
    await screen.findByText("notes2.md");

    await fireEvent.changeText(screen.getByLabelText("Filter this folder"), "NOTES");
    expect(rowNames()).toEqual(["notes2.md", "notes10.md"]);

    await fireEvent.changeText(screen.getByLabelText("Filter this folder"), "zsh");
    expect(screen.getByText("No matches")).toBeOnTheScreen();
    expect(
      screen.getByText("Nothing in this folder matches “zsh”. 1 hidden file matches."),
    ).toBeOnTheScreen();
  });

  test("view options sort and show hidden files, and remember it on this device", async () => {
    mockTransport = fakeHost({ folders: { [HOME]: homeFolder() } }).transport;
    await renderBody();
    await screen.findByText("notes2.md");

    await openFolderActions();
    await fireEvent.press(screen.getByText("View options…"));
    const sheet = await screen.findByTestId("file-view-options");

    await fireEvent.press(within(sheet).getByRole("radio", { name: "Sort by size" }));
    expect(rowNames()).toEqual(["Docs", "src", "notes2.md", "notes10.md"]);
    expect(within(sheet).getByText("Largest first")).toBeOnTheScreen();
    await fireEvent.press(within(sheet).getByText("Smallest first"));
    expect(rowNames()).toEqual(["Docs", "src", "notes10.md", "notes2.md"]);

    await fireEvent.press(within(sheet).getByRole("switch", { name: "Show hidden files" }));
    expect(screen.getByText(".zshrc")).toBeOnTheScreen();

    const writes = jest.mocked(AsyncStorage.setItem).mock.calls;
    const view = writes.filter(([key]) => key === FILE_VIEW_OPTIONS_KEY).at(-1);
    expect(JSON.parse(String(view?.[1]))).toEqual({
      sort: { key: "size", direction: "asc" },
      foldersFirst: true,
    });
    // One switch on the device: the folder picker's hidden-files key is this one.
    expect(writes.filter(([key]) => key === SHOW_HIDDEN_KEY).at(-1)?.[1]).toBe("true");
    // Never a path: the view options are all that is kept.
    for (const [, value] of writes) expect(String(value)).not.toContain(HOME);
  });

  test("Folders on top is a view option, on until turned off, and kept on this device", async () => {
    mockTransport = fakeHost({ folders: { [HOME]: homeFolder() } }).transport;
    await renderBody();
    await screen.findByText("notes2.md");
    expect(rowNames()).toEqual(["Docs", "src", "notes2.md", "notes10.md"]);

    await openFolderActions();
    await fireEvent.press(screen.getByText("View options…"));
    const sheet = await screen.findByTestId("file-view-options");
    const toggle = within(sheet).getByRole("switch", { name: "Folders on top" });
    expect(toggle).toBeChecked();
    await fireEvent.press(toggle);

    expect(rowNames()).toEqual(["Docs", "notes2.md", "notes10.md", "src"]);
    const view = jest
      .mocked(AsyncStorage.setItem)
      .mock.calls.filter(([key]) => key === FILE_VIEW_OPTIONS_KEY)
      .at(-1);
    expect(JSON.parse(String(view?.[1]))).toMatchObject({ foldersFirst: false });
  });

  test("the folder menu shows and hides hidden files with the same switch", async () => {
    mockTransport = fakeHost({ folders: { [HOME]: homeFolder() } }).transport;
    await renderBody();
    await screen.findByText("notes2.md");
    await openFolderActions();
    await fireEvent.press(screen.getByText("Show hidden files"));
    expect(await screen.findByText(".zshrc")).toBeOnTheScreen();
    await openFolderActions();
    await fireEvent.press(screen.getByText("Hide hidden files"));
    await waitFor(() => expect(screen.queryByText(".zshrc")).toBeNull());
  });

  test("the count is what is shown, and the hidden files the filter would match", async () => {
    mockTransport = fakeHost({ folders: { [HOME]: homeFolder() } }).transport;
    await renderBody();
    await screen.findByText("notes2.md");
    await fireEvent.changeText(screen.getByLabelText("Filter this folder"), "s");
    // Docs, src and both notes match; so does the hidden .zshrc.
    expect(screen.getByText("4 items · 1 hidden")).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText("Filter this folder"), "notes");
    expect(screen.getByText("2 items")).toBeOnTheScreen();
  });

  test("a folder tap asks to open it; a breadcrumb asks to go up to it", async () => {
    mockTransport = fakeHost({
      folders: { [HOME]: homeFolder(), [`${HOME}/src`]: [fileEntry(`${HOME}/src`, "main.rs")] },
    }).transport;
    const first = await renderBody();
    await fireEvent.press(await screen.findByTestId("file-row-src"));
    expect(first.onOpenFolder).toHaveBeenCalledWith({ path: `${HOME}/src`, ancestor: false });
    await first.unmount();

    const nested = await renderBody({ path: "~/src" });
    await screen.findByText("main.rs");
    await fireEvent.press(screen.getByRole("button", { name: "Open Home" }));
    expect(nested.onOpenFolder).toHaveBeenCalledWith({ path: HOME, ancestor: true });
  });

  test("long-press selects; Select all and a delete that names the count", async () => {
    const host = fakeHost({ folders: { [HOME]: homeFolder() } });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");

    await fireEvent(screen.getByTestId("file-row-notes2.md"), "longPress");
    expect(screen.getByText("1 selected")).toBeOnTheScreen();
    expect(screen.getByRole("checkbox", { name: /notes2\.md/u })).toBeChecked();

    await fireEvent.press(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("4 selected")).toBeOnTheScreen();
    // A tap in selection mode picks, it does not open.
    await fireEvent.press(screen.getByTestId("file-row-src"));
    expect(screen.getByText("3 selected")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Delete 3 items" }));
    expect(screen.getByText("Delete 3 items permanently?")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "They won't go to the Trash on dream. Folders go with everything inside them. This can't be undone.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Delete permanently"));

    await waitFor(() => expect(screen.queryByText("3 selected")).toBeNull());
    expect(await screen.findByText("Deleted 3 items on dream")).toBeOnTheScreen();
    expect(requestLog(host.request).filter((line) => line.startsWith("fs.remove"))).toEqual([
      `fs.remove ${HOME}/Docs`,
      `fs.remove ${HOME}/notes2.md`,
      `fs.remove ${HOME}/notes10.md`,
    ]);
    expect(host.request).toHaveBeenCalledWith("fs.remove", {
      path: `${HOME}/Docs`,
      recursive: true,
    });
    expect(await screen.findByText("src")).toBeOnTheScreen();
    expect(rowNames()).toEqual(["src"]);
    expect(screen.queryByTestId("file-selection-bar")).toBeNull();
  });

  test("a delete the host partly refuses says so, and keeps what is left selected", async () => {
    const host = fakeHost({
      folders: { [HOME]: homeFolder() },
      refuseRemove: new Set([`${HOME}/notes10.md`]),
    });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");

    await fireEvent(screen.getByTestId("file-row-notes2.md"), "longPress");
    await fireEvent.press(screen.getByTestId("file-row-notes10.md"));
    await fireEvent.press(screen.getByRole("button", { name: "Delete 2 items" }));
    await fireEvent.press(screen.getByText("Delete permanently"));

    expect(
      await screen.findByText(
        "Deleted 1 of 2 items on dream. “notes10.md” wasn't deleted: SPAWN D on dream isn't allowed to change “notes10.md”.",
      ),
    ).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByText("notes2.md")).toBeNull());
    expect(screen.getByText("1 selected")).toBeOnTheScreen();
  });

  test("Delete permanently closes the confirm at once, and the run cannot be started twice", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = fakeHost({
      folders: { [HOME]: homeFolder() },
      before: async (operation) => {
        if (operation === "fs.remove") await held;
      },
    });
    const removes = () =>
      requestLog(host.request).filter((line) => line.startsWith("fs.remove")).length;
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");

    await fireEvent(screen.getByTestId("file-row-notes2.md"), "longPress");
    await fireEvent.press(screen.getByTestId("file-row-notes10.md"));
    await fireEvent.press(screen.getByTestId("file-row-src"));
    await fireEvent.press(screen.getByRole("button", { name: "Delete 3 items" }));
    const confirm = screen.getByText("Delete permanently");
    await fireEvent.press(confirm);

    // The run is said in the folder's notice line; the confirm, and its Cancel, are gone.
    expect(await screen.findByText("Deleting 3 items on dream…")).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByTestId("confirm-sheet")).toBeNull());
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // Nothing can ask for the same delete again while it runs.
    expect(screen.getByRole("button", { name: "Delete 3 items" })).toBeDisabled();
    await fireEvent.press(confirm);
    expect(removes()).toBe(1);

    await act(async () => release());
    expect(await screen.findByText("Deleted 3 items on dream")).toBeOnTheScreen();
    expect(removes()).toBe(3);
  });

  test("a delete of one item names it and the host", async () => {
    const host = fakeHost({ folders: { [HOME]: homeFolder() } });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");
    await fireEvent.press(screen.getByRole("button", { name: "Actions for notes2.md" }));
    await fireEvent.press(screen.getByText("Delete permanently…"));
    expect(screen.getByText("Delete “notes2.md” permanently?")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Delete permanently"));
    expect(await screen.findByText("Deleted “notes2.md” on dream")).toBeOnTheScreen();
  });

  test("New file writes an empty file that may not replace anything", async () => {
    const host = fakeHost({ folders: { [HOME]: homeFolder() } });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");

    await openFolderActions();
    await fireEvent.press(screen.getByText("New file"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "todo.txt");
    await fireEvent.press(screen.getByText("Create file"));

    expect(await screen.findByText("todo.txt")).toBeOnTheScreen();
    expect(host.writeFile).toHaveBeenCalledWith(expect.objectContaining({ size: 0 }), {
      dir: HOME,
      name: "todo.txt",
      overwrite: false,
    });

    await openFolderActions();
    await fireEvent.press(screen.getByText("New file"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "todo.txt");
    await fireEvent.press(screen.getByText("Create file"));
    // Said where the name was typed: the dialog stays open, with the reason in it.
    const dialog = await screen.findByTestId("dialog-content");
    expect(
      await within(dialog).findByText("There's already an item named “todo.txt” here."),
    ).toBeOnTheScreen();
    expect(screen.getAllByText("There's already an item named “todo.txt” here.")).toHaveLength(1);
    // A different name is a new question; the old answer goes.
    await fireEvent.changeText(screen.getByLabelText("Name"), "todo2.txt");
    expect(screen.queryByText("There's already an item named “todo.txt” here.")).toBeNull();
  });

  test("a rename the host refuses names the clashing name, inside the dialog", async () => {
    const host = fakeHost({
      folders: { [HOME]: homeFolder() },
      before: (operation) => {
        if (operation === "fs.rename") throw fsError("already_exists");
      },
    });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");
    await fireEvent.press(screen.getByRole("button", { name: "Actions for notes2.md" }));
    await fireEvent.press(screen.getByText("Rename"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "notes10.md");
    const dialog = await screen.findByTestId("dialog-content");
    await fireEvent.press(within(dialog).getByRole("button", { name: "Rename" }));
    expect(
      await within(dialog).findByText("There's already an item named “notes10.md” here."),
    ).toBeOnTheScreen();
  });

  test("a name already taken is said as that, though the host's own answer is only 'unknown'", async () => {
    // As SPAWN D's file service answers: mkdir is mkdir -p, and a rename onto
    // a name already there fails inside its effect, which it reports as
    // outcome_unknown.
    const host = fakeHost({
      folders: { [HOME]: homeFolder() },
      capabilities: ["fs.list", "fs.stat", "fs.mkdir", "fs.rename", "fs.remove"],
      daemonEffects: true,
    });
    const asked = (operation: string) =>
      requestLog(host.request).filter((line) => line.startsWith(operation));
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");

    // A folder already there is not "made" again.
    await openFolderActions();
    await fireEvent.press(screen.getByText("New folder"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "src");
    await fireEvent.press(screen.getByText("Create folder"));
    const dialog = await screen.findByTestId("dialog-content");
    expect(
      await within(dialog).findByText("There's already an item named “src” here."),
    ).toBeOnTheScreen();
    expect(asked("fs.mkdir")).toEqual([]);

    // Nor is a folder made over a file.
    await fireEvent.changeText(screen.getByLabelText("Name"), "notes2.md");
    await fireEvent.press(screen.getByText("Create folder"));
    expect(
      await within(dialog).findByText("There's already an item named “notes2.md” here."),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/lost touch/u)).toBeNull();
    await fireEvent.press(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("dialog-content")).toBeNull());

    // A rename onto a name the listing shows.
    await fireEvent.press(screen.getByRole("button", { name: "Actions for notes2.md" }));
    await fireEvent.press(screen.getByText("Rename"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "notes10.md");
    const renameDialog = await screen.findByTestId("dialog-content");
    await fireEvent.press(within(renameDialog).getByRole("button", { name: "Rename" }));
    expect(
      await within(renameDialog).findByText("There's already an item named “notes10.md” here."),
    ).toBeOnTheScreen();
    expect(asked("fs.rename")).toEqual([]);

    // And onto one made on the host after the folder was read: the host's
    // "unknown" is looked into, and both names are there.
    host.tree.get(HOME)?.push(fileEntry(HOME, "late.md"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "late.md");
    await fireEvent.press(within(renameDialog).getByRole("button", { name: "Rename" }));
    expect(
      await within(renameDialog).findByText("There's already an item named “late.md” here."),
    ).toBeOnTheScreen();
    expect(asked("fs.rename")).toEqual([`fs.rename ${HOME}/notes2.md`]);
    expect(asked("fs.stat")).toEqual([`fs.stat ${HOME}/notes2.md`, `fs.stat ${HOME}/late.md`]);
    expect(screen.queryByText(/lost touch/u)).toBeNull();
  });

  test("a change whose answer never came says so, not the transport's words", async () => {
    const host = fakeHost({
      folders: { [HOME]: homeFolder() },
      before: (operation) => {
        if (operation === "fs.mkdir") {
          throw Object.assign(
            new Error("The host mutation may have completed; reconcile before retrying."),
            { code: "outcome_unknown" },
          );
        }
      },
    });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");
    await openFolderActions();
    await fireEvent.press(screen.getByText("New folder"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "build");
    await fireEvent.press(screen.getByText("Create folder"));
    expect(
      await screen.findByText(
        "SPAWN D lost touch with dream before it answered, so this may or may not have happened. Check the folder before trying again.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/reconcile/u)).toBeNull();
  });

  test("New file is offered only by a host that can write files", async () => {
    mockTransport = fakeHost({
      folders: { [HOME]: homeFolder() },
      capabilities: ["fs.list", "fs.mkdir"],
    }).transport;
    await renderBody();
    await screen.findByText("notes2.md");
    await openFolderActions();
    expect(screen.getByRole("button", { name: "New file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New folder" })).toBeEnabled();
  });

  test("New folder lands in the folder on screen", async () => {
    const host = fakeHost({ folders: { [HOME]: homeFolder() } });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");
    await openFolderActions();
    await fireEvent.press(screen.getByText("New folder"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "build");
    await fireEvent.press(screen.getByText("Create folder"));
    expect(await screen.findByText("build")).toBeOnTheScreen();
    expect(host.request).toHaveBeenCalledWith("fs.mkdir", { path: `${HOME}/build` });
  });

  test("Go to folder asks the host first and answers a typo in the dialog", async () => {
    mockTransport = fakeHost({
      folders: { [HOME]: homeFolder(), [`${HOME}/src`]: [] },
    }).transport;
    const { onOpenFolder } = await renderBody();
    await screen.findByText("notes2.md");

    await openFolderActions();
    await fireEvent.press(screen.getByText("Go to folder…"));
    await fireEvent.changeText(screen.getByLabelText("Folder"), "~/missing");
    await fireEvent.press(screen.getByText("Go"));
    expect(await screen.findByText("There's no folder at that path on dream.")).toBeOnTheScreen();
    expect(onOpenFolder).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText("Folder"), "/etc");
    expect(
      screen.getByText("SPAWN D only opens folders inside your home folder on dream."),
    ).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByLabelText("Folder"), "~/src/");
    await fireEvent.press(screen.getByText("Go"));
    await waitFor(() =>
      expect(onOpenFolder).toHaveBeenCalledWith({ path: `${HOME}/src`, ancestor: false }),
    );
  });

  test("Go to folder reads a relative path from the folder on screen", async () => {
    mockTransport = fakeHost({
      folders: {
        [HOME]: homeFolder(),
        [`${HOME}/src`]: [folderEntry(`${HOME}/src`, "lib")],
        [`${HOME}/src/lib`]: [],
      },
    }).transport;
    const { onOpenFolder } = await renderBody({ path: "~/src" });
    await screen.findByText("lib");
    await openFolderActions();
    await fireEvent.press(screen.getByText("Go to folder…"));
    await fireEvent.changeText(screen.getByLabelText("Folder"), "lib");
    await fireEvent.press(screen.getByText("Go"));
    await waitFor(() =>
      expect(onOpenFolder).toHaveBeenCalledWith({ path: `${HOME}/src/lib`, ancestor: false }),
    );
  });

  test("a link to a file opens the folder it is in, with the file open", async () => {
    mockTransport = fakeHost({
      folders: {
        [HOME]: homeFolder(),
        [`${HOME}/src`]: [fileEntry(`${HOME}/src`, "main.rs", { size: 10 })],
      },
    }).transport;
    const onShowFolder = jest.fn();
    await renderBody({ path: "~/src/main.rs", onShowFolder });
    expect(await screen.findByLabelText("Close file viewer")).toBeOnTheScreen();
    expect(screen.getByText(`${HOME}/src/main.rs`)).toBeOnTheScreen();
    expect(screen.getByTestId("file-row-main.rs")).toBeOnTheScreen();
    expect(onShowFolder).toHaveBeenLastCalledWith(`${HOME}/src`);
    expect(screen.queryByText("That's a file on dream, not a folder.")).toBeNull();
  });

  test("a link outside home opens home and says why", async () => {
    mockTransport = fakeHost({ folders: { [HOME]: homeFolder() } }).transport;
    await renderBody({ path: "/etc" });
    expect(await screen.findByText("notes2.md")).toBeOnTheScreen();
    expect(
      screen.getByText("SPAWN D only opens folders inside your home folder on dream."),
    ).toBeOnTheScreen();
  });

  // A thousand rows, rendered twice: slow under coverage on a loaded machine.
  test("a folder past the host's 1,024 says sorting covers only what was listed", async () => {
    const many = Array.from({ length: 1100 }, (_, index) => fileEntry(HOME, `f${index}`));
    mockTransport = fakeHost({ folders: { [HOME]: many } }).transport;
    await renderBody();
    expect(
      await screen.findByText(
        "This folder has more than 1,024 items. SPAWN D on dream can only list the first 1,024 it finds, so sorting and filtering cover just those.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("1,024 items")).toBeOnTheScreen();

    // Still said when a filter finds nothing: the search covered only those.
    await fireEvent.changeText(screen.getByLabelText("Filter this folder"), "zzz");
    expect(screen.getByText("No matches")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "This folder has more than 1,024 items. SPAWN D on dream can only list the first 1,024 it finds, so sorting and filtering cover just those.",
      ),
    ).toBeOnTheScreen();
  }, 20_000);

  test("a folder under another screen holds no channel and asks nothing", async () => {
    const host = fakeHost({ folders: { [HOME]: homeFolder() } });
    mockTransport = host.transport;
    mockFocused = false;
    await renderBody();
    await act(async () => undefined);
    expect(mockSurfaceMounts).not.toHaveBeenCalled();
    expect(host.request).not.toHaveBeenCalled();
  });

  test("looks at page 1 every ten seconds while on screen, and shows what changed", async () => {
    jest.useFakeTimers();
    const host = fakeHost({ folders: { [HOME]: homeFolder() } });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");
    host.tree.get(HOME)?.push(fileEntry(HOME, "fresh.log", { size: 1 }));

    await act(async () => {
      jest.advanceTimersByTime(HOST_LISTING_POLL_MS);
    });
    expect(await screen.findByText("fresh.log")).toBeOnTheScreen();
    const lists = requestLog(host.request).filter((line) => line.startsWith("fs.list"));
    expect(lists).toEqual([`fs.list ${HOME} 0`, `fs.list ${HOME} 0`]);
  });

  test("a one-page folder that grows past its page is read again in full", async () => {
    jest.useFakeTimers();
    const host = fakeHost({ folders: { [HOME]: homeFolder() } });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("notes2.md");
    for (let index = 0; index < 150; index += 1) {
      host.tree.get(HOME)?.push(fileEntry(HOME, `g${index}`));
    }

    await act(async () => {
      jest.advanceTimersByTime(HOST_LISTING_POLL_MS);
    });
    expect(await screen.findByText("154 items · 1 hidden")).toBeOnTheScreen();
    expect(screen.queryByText("This folder changed on dream.")).toBeNull();
    const lists = requestLog(host.request).filter((line) => line.startsWith("fs.list"));
    expect(lists).toEqual([
      `fs.list ${HOME} 0`,
      `fs.list ${HOME} 0`,
      `fs.list ${HOME} 0`,
      `fs.list ${HOME} 96`,
    ]);
  });

  test("a folder that vanished on the host says so instead of keeping its rows", async () => {
    jest.useFakeTimers();
    const host = fakeHost({
      folders: { [HOME]: homeFolder(), [`${HOME}/src`]: [fileEntry(`${HOME}/src`, "main.rs")] },
    });
    mockTransport = host.transport;
    await renderBody({ path: "~/src" });
    await screen.findByText("main.rs");
    host.tree.delete(`${HOME}/src`);

    await act(async () => {
      jest.advanceTimersByTime(HOST_LISTING_POLL_MS);
    });
    expect(await screen.findByText("There's no folder at that path on dream.")).toBeOnTheScreen();
    expect(screen.queryByText("main.rs")).toBeNull();
  });

  test("a large folder that changed is flagged, and read again only on Refresh", async () => {
    jest.useFakeTimers();
    const many = Array.from({ length: 200 }, (_, index) => fileEntry(HOME, `f${index}`));
    const host = fakeHost({ folders: { [HOME]: many } });
    mockTransport = host.transport;
    await renderBody();
    await screen.findByText("200 items");
    host.tree.get(HOME)?.unshift(fileEntry(HOME, "aaa-new"));

    await act(async () => {
      jest.advanceTimersByTime(HOST_LISTING_POLL_MS);
    });
    expect(await screen.findByText("This folder changed on dream.")).toBeOnTheScreen();
    expect(screen.queryByText("aaa-new")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("aaa-new")).toBeOnTheScreen();
    expect(screen.queryByText("This folder changed on dream.")).toBeNull();
  });
});
