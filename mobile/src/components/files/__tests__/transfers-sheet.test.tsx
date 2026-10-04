import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { TransfersBanner } from "@/components/files/transfers-banner";
import { TransfersSheet } from "@/components/files/transfers-sheet";
import { type NewTransferBatch, useTransfersStore } from "@/data/stores/transfers";
import { ThemeProvider } from "@/theme";

jest.mock("@/components/files/upload-source", () => ({ releaseLocalCopy: jest.fn() }));
// The runner's module brings the host channel surface; the sheet only needs its clear.
jest.mock("@/terminal/HostTransportSurface", () => ({ HostTransportSurface: () => null }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};
const dream = { id: "dream", name: "dream", publicKey: "k", os: "linux" };

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function upload(names: string[]): NewTransferBatch {
  return {
    kind: "upload",
    source: null,
    destination: dream,
    destDir: "/home/me/Inbox",
    destLabel: "Inbox",
    items: names.map((name) => ({
      name,
      size: 100,
      source: { kind: "local", uri: `file:///cache/${name}`, mimeType: null },
      policy: "ask",
    })),
  };
}

function itemIds(batchId: string): string[] {
  return (
    useTransfersStore
      .getState()
      .batches.find((batch) => batch.id === batchId)
      ?.items.map((item) => item.id) ?? []
  );
}

beforeEach(() => {
  useTransfersStore.getState().reset();
});

describe("the Transfers sheet", () => {
  test("opens from the banner and shows each file's progress", async () => {
    let id = "";
    await act(async () => {
      id = useTransfersStore.getState().enqueue(upload(["a.txt", "b.txt"]));
    });
    const [a] = itemIds(id);
    await act(async () => {
      useTransfersStore.getState().patchItem(id, a ?? "", {
        state: "running",
        phase: "streaming",
        transferred: 50,
        total: 100,
        startedAt: Date.now(),
      });
    });
    await render(
      <Providers>
        <TransfersBanner />
        <TransfersSheet />
      </Providers>,
    );
    await fireEvent.press(screen.getByTestId("transfers-banner"));
    expect(await screen.findByTestId("transfers-sheet")).toBeOnTheScreen();
    expect(screen.getByText("Uploading 2 items to Inbox on dream")).toBeOnTheScreen();
    // The transfer's own line counts the whole transfer; each file has its own.
    expect(screen.getByText("50 B of 200 B · 0 of 2 items")).toBeOnTheScreen();
    expect(screen.getByText("50% · 50 B of 100 B")).toBeOnTheScreen();
    expect(screen.getByText("Waiting")).toBeOnTheScreen();
    expect(screen.getByText("Keep SPAWN D open until transfer finishes.")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("Cancel"));
    expect(useTransfersStore.getState().batches[0]?.cancelled).toBe(true);
  });

  test("a long transfer says about how long it has left, over the whole transfer", async () => {
    let id = "";
    await act(async () => {
      const store = useTransfersStore.getState();
      // Many small files: none alone is worth an estimate, all of them together are.
      id = store.enqueue(upload(Array.from({ length: 30 }, (_, index) => `f${index}.txt`)));
      const ids = itemIds(id);
      for (const done of ids.slice(0, 10)) store.patchItem(id, done, { state: "done" });
      store.patchItem(id, ids[10] ?? "", {
        state: "running",
        phase: "streaming",
        transferred: 50,
        total: 100,
        streamStartedAt: Date.now() - 1_000,
      });
      // 1,950 bytes left at a measured 10 bytes a second: about 3 minutes.
      store.patchBatch(id, { rate: 10 });
      const other = store.enqueue(upload(["next.iso"]));
      store.patchItem(other, itemIds(other)[0] ?? "", {
        state: "running",
        phase: "hashing",
        transferred: 40,
      });
      store.showSheet();
    });
    await render(
      <Providers>
        <TransfersSheet />
      </Providers>,
    );
    expect(
      screen.getByText("1.0 KB of 2.9 KB · 10 of 30 items · about 3 minutes left"),
    ).toBeOnTheScreen();
    expect(screen.getByText("Preparing… 40%")).toBeOnTheScreen();
  });

  test("a transfer behind another says what it waits for, and a finished one what it did", async () => {
    await act(async () => {
      const store = useTransfersStore.getState();
      const first = store.enqueue(upload(["a.txt"]));
      store.patchItem(first, itemIds(first)[0] ?? "", { state: "running", phase: "streaming" });
      store.enqueue({
        ...upload(["b.txt"]),
        destination: { id: "mini", name: "mac-mini", publicKey: "k", os: "macos" },
      });
      const done = store.enqueue(upload(["c.txt", "d.txt"]));
      const [c, d] = itemIds(done);
      store.patchItem(done, c ?? "", { state: "done" });
      store.patchItem(done, d ?? "", { state: "skipped" });
      store.showSheet();
    });
    await render(
      <Providers>
        <TransfersSheet />
      </Providers>,
    );
    expect(screen.getByText("Waiting for another transfer with dream to finish")).toBeOnTheScreen();
    expect(screen.getByText("Uploaded 2 items to Inbox on dream")).toBeOnTheScreen();
    expect(screen.getByText("1 item · 100 B · 1 skipped")).toBeOnTheScreen();
  });

  test("after the background, says why it stopped and resumes on request", async () => {
    let id = "";
    await act(async () => {
      const store = useTransfersStore.getState();
      id = store.enqueue(upload(["a.txt"]));
      store.patchItem(id, itemIds(id)[0] ?? "", {
        state: "interrupted",
        interruption: { cause: "background" },
      });
      store.pause({ cause: "background" });
      store.showSheet();
    });
    await render(
      <Providers>
        <TransfersSheet />
      </Providers>,
    );
    expect(screen.getByText("Paused when SPAWN D went to the background")).toBeOnTheScreen();
    expect(screen.getAllByText("Stopped when SPAWN D went to the background")).not.toHaveLength(0);
    await fireEvent.press(screen.getByTestId("transfers-resume"));
    expect(useTransfersStore.getState().paused).toBe(false);
    expect(useTransfersStore.getState().batches[0]?.items[0]?.state).toBe("queued");
  });

  test("a connection lost on screen says which host, and resumes on request", async () => {
    await act(async () => {
      const store = useTransfersStore.getState();
      const id = store.enqueue(upload(["a.txt"]));
      store.patchItem(id, itemIds(id)[0] ?? "", {
        state: "interrupted",
        interruption: { cause: "lost-touch", host: "dream" },
      });
      store.pause({ cause: "lost-touch", host: "dream" });
      store.showSheet();
    });
    await render(
      <Providers>
        <TransfersBanner />
        <TransfersSheet />
      </Providers>,
    );
    expect(screen.getByTestId("transfers-banner")).toHaveTextContent("Transfers paused");
    expect(
      screen.getAllByText("Interrupted because SPAWN D lost touch with dream.").length,
    ).toBeGreaterThan(0);
    await fireEvent.press(screen.getByTestId("transfers-resume"));
    expect(useTransfersStore.getState().batches[0]?.items[0]?.state).toBe("queued");
  });

  test("a folder whose name is taken is asked about as a folder, with Merge", async () => {
    await act(async () => {
      const store = useTransfersStore.getState();
      const id = store.enqueue({
        kind: "send",
        source: { id: "mini", name: "mac-mini", publicKey: "k", os: "macos" },
        destination: dream,
        destDir: "/home/me/Inbox",
        destLabel: "Inbox",
        items: [
          {
            kind: "folder",
            name: "photos",
            size: null,
            source: { kind: "host", path: "/Users/me/photos" },
            policy: "ask",
          },
          {
            name: "notes",
            size: 1,
            source: { kind: "host", path: "/Users/me/notes" },
            policy: "ask",
          },
        ],
      });
      const [photos, notes] = itemIds(id);
      store.patchItem(id, photos ?? "", { state: "conflict", clash: { isDir: true } });
      store.patchItem(id, notes ?? "", { state: "conflict", clash: { isDir: true } });
      store.showSheet();
    });
    await render(
      <Providers>
        <TransfersSheet />
      </Providers>,
    );
    expect(
      screen.getByText("A folder named “photos” already exists in Inbox on dream."),
    ).toBeOnTheScreen();
    expect(screen.getByText("Merge")).toBeOnTheScreen();
    // A file meeting a folder is offered only Keep both and Skip.
    expect(screen.getByText("“notes” already exists in Inbox on dream.")).toBeOnTheScreen();
    expect(screen.queryByText("Replace")).toBeNull();
    expect(screen.getAllByText("Keep both")).toHaveLength(2);
    expect(screen.getByText("Sending 2 items from mac-mini to Inbox on dream")).toBeOnTheScreen();
  });

  test("a taken name is answered from the sheet, for the rest too if asked", async () => {
    let id = "";
    await act(async () => {
      const store = useTransfersStore.getState();
      id = store.enqueue(upload(["a.txt", "b.txt"]));
      for (const itemId of itemIds(id)) {
        store.patchItem(id, itemId, { state: "conflict", clash: { isDir: false } });
      }
      store.showSheet();
    });
    await render(
      <Providers>
        <TransfersSheet />
      </Providers>,
    );
    expect(screen.getByText("“a.txt” already exists in Inbox on dream.")).toBeOnTheScreen();
    const [rest] = screen.getAllByRole("switch", { name: "Do this for the other 1" });
    const [replace] = screen.getAllByText("Replace");
    if (!rest || !replace) throw new Error("No answer offered");
    await fireEvent.press(rest);
    await fireEvent.press(replace);
    expect(
      useTransfersStore.getState().batches[0]?.items.map((item) => [item.state, item.policy]),
    ).toEqual([
      ["queued", "replace"],
      ["queued", "replace"],
    ]);
  });

  test("a failed file says why and can be retried; finished batches can be cleared", async () => {
    let failed = "";
    await act(async () => {
      const store = useTransfersStore.getState();
      failed = store.enqueue(upload(["a.txt"]));
      store.patchItem(failed, itemIds(failed)[0] ?? "", {
        state: "failed",
        error: "SPAWN D on dream isn't allowed to write to Inbox.",
      });
      const done = store.enqueue(upload(["b.txt"]));
      store.patchItem(done, itemIds(done)[0] ?? "", { state: "done" });
      store.showSheet();
    });
    await render(
      <Providers>
        <TransfersSheet />
      </Providers>,
    );
    expect(screen.getByText("SPAWN D on dream isn't allowed to write to Inbox.")).toBeOnTheScreen();
    expect(screen.getByText("1 item couldn't be uploaded.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Clear finished"));
    expect(useTransfersStore.getState().batches.map((batch) => batch.id)).toEqual([]);
    await act(async () => {
      failed = useTransfersStore.getState().enqueue(upload(["c.txt"]));
      useTransfersStore.getState().patchItem(failed, itemIds(failed)[0] ?? "", {
        state: "failed",
        error: "nope",
      });
    });
    const [retry] = screen.getAllByText("Retry");
    if (!retry) throw new Error("No Retry offered");
    await fireEvent.press(retry);
    expect(useTransfersStore.getState().batches[0]?.items[0]?.state).toBe("queued");
  });
});
