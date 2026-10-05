import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react-native";
import { activateKeepAwakeAsync } from "expo-keep-awake";

import { fakeHost, fsError } from "@/components/files/__tests__/fixtures";
import { clearFinishedTransfers, TransfersRunner } from "@/components/files/transfers-runner";
import { releaseLocalCopy } from "@/components/files/upload-source";
import { type NewTransferBatch, useTransfersStore } from "@/data/stores/transfers";
import type { HostTransport } from "@/terminal/transport/types";

const mockTransports: Record<string, HostTransport> = {};
const mockMounted = new Set<string>();
const mockToast = {
  success: jest.fn(),
  error: jest.fn(),
  show: jest.fn(() => "paused-toast"),
  dismiss: jest.fn(),
};
let mockIdentityChanged: (() => void) | null = null;

jest.mock("@/terminal/HostTransportSurface", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  return {
    HostTransportSurface: ({
      hostId,
      onStateChange,
      onTransport,
    }: {
      hostId: string;
      onStateChange(state: string): void;
      onTransport(transport: unknown): void;
    }) => {
      ReactModule.useEffect(() => {
        mockMounted.add(hostId);
        onTransport(mockTransports[hostId]);
        onStateChange("ready");
        return () => {
          mockMounted.delete(hostId);
        };
      }, [hostId, onStateChange, onTransport]);
      return null;
    },
  };
});
jest.mock("@/components/ui/toast", () => ({ useToast: () => mockToast }));
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));
jest.mock("@/components/files/upload-source", () => ({
  openLocalFileSource: () => ({
    size: 3,
    read: async (_offset: number, length: number) => new Uint8Array(length),
    close: () => undefined,
  }),
  releaseLocalCopy: jest.fn(),
}));
jest.mock("@/lib/crypto/identity", () => ({
  subscribeDeviceIdentityAccount: (listener: () => void) => {
    mockIdentityChanged = listener;
    return () => {
      mockIdentityChanged = null;
    };
  },
}));

const INBOX = "/home/me/Inbox";
const dream = { id: "dream", name: "dream", publicKey: "k", os: "linux" };

function upload(names: string[]): NewTransferBatch {
  return {
    kind: "upload",
    source: null,
    destination: dream,
    destDir: INBOX,
    destLabel: "Inbox",
    items: names.map((name) => ({
      name,
      size: 3,
      source: { kind: "local", uri: `file:///cache/${name}`, mimeType: null },
      policy: "ask",
    })),
  };
}

async function renderRunner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <TransfersRunner />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function states(): string[] {
  return useTransfersStore.getState().batches.flatMap((batch) => batch.items.map((i) => i.state));
}

beforeEach(() => {
  useTransfersStore.getState().reset();
  mockToast.success.mockClear();
  mockToast.error.mockClear();
  mockToast.show.mockClear();
  mockToast.dismiss.mockClear();
  jest.mocked(releaseLocalCopy).mockClear();
  jest.mocked(activateKeepAwakeAsync).mockClear();
  mockTransports["dream"] = fakeHost({
    home: "/home/me",
    folders: { [INBOX]: [] },
    capabilities: ["fs.list", "fs.write.begin", "fs.stat"],
  }).transport;
});

describe("the transfers runner", () => {
  test("runs the queue from above the screens, and says when a batch has arrived", async () => {
    useTransfersStore.getState().enqueue(upload(["a.txt"]));
    const view = await renderRunner();
    await waitFor(() => expect(states()).toEqual(["done"]));
    expect(mockToast.success).toHaveBeenCalledWith("Uploaded “a.txt” to Inbox on dream");
    expect(jest.mocked(releaseLocalCopy)).toHaveBeenCalledWith("file:///cache/a.txt");
    // Nothing left to move: the channel is given back.
    await waitFor(() => expect(mockMounted.has("dream")).toBe(false));
    view.unmount();
  });

  test("a batch with a failure says how many could not go, and the notice opens Transfers", async () => {
    const host = fakeHost({
      home: "/home/me",
      folders: { [INBOX]: [] },
      capabilities: ["fs.list", "fs.write.begin", "fs.stat"],
    });
    const write = host.writeFile.getMockImplementation();
    host.writeFile.mockImplementationOnce(async () => {
      throw fsError("permission_denied");
    });
    if (write) host.writeFile.mockImplementation(write);
    mockTransports["dream"] = host.transport;
    useTransfersStore.getState().enqueue(upload(["a.txt", "b.txt"]));
    const view = await renderRunner();
    await waitFor(() => expect(states()).toEqual(["failed", "done"]));
    expect(mockToast.error).toHaveBeenCalledWith("1 item couldn't be uploaded.", {
      actions: [{ label: "Transfers", onPress: expect.any(Function) }],
    });
    // The failed file keeps its copy for Retry.
    expect(jest.mocked(releaseLocalCopy).mock.calls.map(([uri]) => uri)).toEqual([
      "file:///cache/b.txt",
    ]);
    const [, options] = mockToast.error.mock.calls[0] as [
      string,
      { actions: { onPress(): void }[] },
    ];
    await act(async () => options.actions[0]?.onPress());
    expect(useTransfersStore.getState().sheetVisible).toBe(true);
    view.unmount();
  });

  test("another account forgets the queue and the phone's copies", async () => {
    mockTransports["dream"] = {
      ...fakeHost({ capabilities: ["fs.list", "fs.write.begin"] }).transport,
      state: "connecting",
    };
    const view = await renderRunner();
    await act(async () => {
      useTransfersStore.getState().enqueue(upload(["a.txt"]));
    });
    await act(async () => mockIdentityChanged?.());
    expect(useTransfersStore.getState().batches).toEqual([]);
    expect(jest.mocked(releaseLocalCopy)).toHaveBeenCalledWith("file:///cache/a.txt");
    view.unmount();
  });

  test("a pause is said wherever the person is, with Resume, and goes when the queue moves", async () => {
    const view = await renderRunner();
    await act(async () => {
      useTransfersStore.getState().pause({ cause: "background" });
    });
    expect(mockToast.show).toHaveBeenCalledWith(
      "Paused when SPAWN D went to the background",
      expect.objectContaining({
        persistent: true,
        actions: [
          expect.objectContaining({ label: "Resume" }),
          expect.objectContaining({ label: "Transfers" }),
        ],
      }),
    );
    const [, options] = mockToast.show.mock.calls[0] as unknown as [
      string,
      { actions: { onPress(): void }[] },
    ];
    await act(async () => options.actions[0]?.onPress());
    expect(useTransfersStore.getState().paused).toBe(false);
    expect(mockToast.dismiss).toHaveBeenCalledWith("paused-toast");
    view.unmount();
  });

  test("a connection lost on screen pauses with the host named, and Resume goes on", async () => {
    const host = fakeHost({
      home: "/home/me",
      folders: { [INBOX]: [] },
      capabilities: ["fs.list", "fs.write.begin", "fs.stat"],
    });
    const write = host.writeFile.getMockImplementation();
    host.writeFile.mockImplementationOnce(async () => {
      throw fsError("connection_closed");
    });
    if (write) host.writeFile.mockImplementation(write);
    mockTransports["dream"] = host.transport;
    useTransfersStore.getState().enqueue(upload(["a.txt", "b.txt"]));
    const view = await renderRunner();
    await waitFor(() => expect(states()).toEqual(["interrupted", "queued"]));
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockToast.show).toHaveBeenCalledWith(
      "Interrupted because SPAWN D lost touch with dream.",
      expect.objectContaining({
        detail:
          "Resume sends what's left; a file that was cut off starts again from the beginning.",
        persistent: true,
      }),
    );
    // Paused, the queue lets its channel go; Resume opens a fresh one.
    await waitFor(() => expect(mockMounted.has("dream")).toBe(false));
    const [, options] = mockToast.show.mock.calls[0] as unknown as [
      string,
      { actions: { onPress(): void }[] },
    ];
    await act(async () => options.actions[0]?.onPress());
    await waitFor(() => expect(states()).toEqual(["done", "done"]));
    expect(mockToast.success).toHaveBeenCalledWith("Uploaded 2 items to Inbox on dream");
    view.unmount();
  });

  test("a cancelled upload keeps the phone's copy for Retry until it is cleared", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockTransports["dream"] = fakeHost({
      home: "/home/me",
      folders: { [INBOX]: [] },
      capabilities: ["fs.list", "fs.write.begin", "fs.stat"],
      before: (operation) => (operation === "fs.stat" ? held : undefined),
    }).transport;
    const id = useTransfersStore.getState().enqueue(upload(["a.txt"]));
    const view = await renderRunner();
    await waitFor(() => expect(states()).toEqual(["running"]));
    await act(async () => useTransfersStore.getState().cancelBatch(id));
    await act(async () => release());
    await waitFor(() => expect(states()).toEqual(["cancelled"]));
    expect(jest.mocked(releaseLocalCopy)).not.toHaveBeenCalled();
    await act(async () => clearFinishedTransfers());
    expect(jest.mocked(releaseLocalCopy)).toHaveBeenCalledWith("file:///cache/a.txt");
    view.unmount();
  });

  test("keeps the screen awake while a file moves", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = fakeHost({
      home: "/home/me",
      folders: { [INBOX]: [] },
      capabilities: ["fs.list", "fs.write.begin", "fs.stat"],
      before: (operation) => (operation === "fs.stat" ? held : undefined),
    });
    mockTransports["dream"] = host.transport;
    useTransfersStore.getState().enqueue(upload(["a.txt"]));
    const view = await renderRunner();
    await waitFor(() => expect(jest.mocked(activateKeepAwakeAsync)).toHaveBeenCalled());
    await act(async () => release());
    await waitFor(() => expect(states()).toEqual(["done"]));
    view.unmount();
  });
});
