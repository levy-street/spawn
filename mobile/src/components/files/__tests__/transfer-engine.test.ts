import { fakeHost, fileEntry, folderEntry, fsError } from "@/components/files/__tests__/fixtures";
import { createTransferEngine, type TransferEngine } from "@/components/files/transfer-engine";
import type { LocalFileSource } from "@/components/files/upload-source";
import {
  type NewTransferBatch,
  nextQueuedItem,
  type TransferHost,
  type TransferItem,
  useTransfersStore,
} from "@/data/stores/transfers";
import { hashHostFileSource } from "@/terminal/transport/host-ctl-codec";
import type {
  HostFileSource,
  HostTransport,
  HostWriteOptions,
  HostWriteResult,
} from "@/terminal/transport/types";

const HOME = "/home/me";
const INBOX = `${HOME}/Inbox`;
const dreamHost: TransferHost = { id: "dream", name: "dream", publicKey: "k1", os: "linux" };
const miniHost: TransferHost = { id: "mini", name: "mac-mini", publicKey: "k2", os: "macos" };
const WITH_STAT = ["fs.list", "fs.mkdir", "fs.write.begin", "fs.stat", "fs.read"];

let epoch = 0;
let active = true;
const engines: TransferEngine[] = [];
const closes = jest.fn();

function localSource(size: number): LocalFileSource {
  return {
    size,
    read: async (offset, length) =>
      Uint8Array.from({ length: Math.max(0, Math.min(length, size - offset)) }, () => 7),
    close: closes,
  };
}

function start(transports: Record<string, HostTransport>, sizes: Record<string, number> = {}) {
  const engine = createTransferEngine({
    pool: { acquire: async (host) => transports[host.id] as HostTransport },
    openLocal: (uri) => localSource(sizes[uri] ?? 3),
    backgroundEpoch: () => epoch,
    appActive: () => active,
    progressIntervalMs: 0,
  });
  engines.push(engine);
  engine.kick();
  return engine;
}

function upload(names: string[], policy: TransferItem["policy"] = "ask"): NewTransferBatch {
  return {
    kind: "upload",
    source: null,
    destination: dreamHost,
    destDir: INBOX,
    destLabel: "Inbox",
    items: names.map((name) => ({
      name,
      size: 3,
      source: { kind: "local", uri: `file:///cache/${name}`, mimeType: null },
      policy,
    })),
  };
}

function items(): TransferItem[] {
  return useTransfersStore.getState().batches.flatMap((batch) => batch.items);
}

async function idle(): Promise<void> {
  for (let turn = 0; turn < 400; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const state = useTransfersStore.getState();
    const running = state.batches.some((batch) =>
      batch.items.some((item) => item.state === "running"),
    );
    if (!running && nextQueuedItem(state) === null) return;
  }
  throw new Error("The queue never settled.");
}

/** A host's file service that can also read files out and send them on, as host-transport does. */
function sendingHost(folders: Record<string, ReturnType<typeof fileEntry>[]>) {
  const host = fakeHost({ home: HOME, folders, capabilities: WITH_STAT });
  const transferFileTo = jest.fn(
    async (
      destination: HostTransport,
      path: string,
      dir: string,
      options: HostWriteOptions & { overwrite?: boolean; name?: string } = {},
    ): Promise<HostWriteResult> => {
      const parent = path.slice(0, path.lastIndexOf("/"));
      const entry = host.tree.get(parent)?.find((candidate) => candidate.path === path);
      if (!entry) throw fsError("not_found");
      const size = entry.size ?? 0;
      options.onProgress?.({ phase: "declaring", transferred: 0, total: size });
      const write = destination.writeFile;
      if (!write) throw fsError("unsupported_operation");
      return write(
        { size, read: async () => new Uint8Array(0) },
        { dir, name: options.name ?? entry.name, overwrite: options.overwrite ?? false },
      );
    },
  );
  host.transport.transferFileTo = transferFileTo;
  return { ...host, transferFileTo };
}

beforeEach(() => {
  epoch = 0;
  active = true;
  closes.mockClear();
  useTransfersStore.getState().reset();
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  useTransfersStore.getState().reset();
});

describe("uploading from the phone", () => {
  test("a file with a free name is written, never replacing anything, and closed after", async () => {
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    useTransfersStore.getState().enqueue(upload(["a.txt"]));
    start({ dream: dest.transport });
    await idle();
    expect(dest.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ size: 3 }),
      { dir: INBOX, name: "a.txt", overwrite: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(items()[0]).toMatchObject({ state: "done", outcome: "created", savedAs: null });
    expect(closes).toHaveBeenCalled();
  });

  test("a taken name asks before a byte is read, when nobody has answered yet", async () => {
    const dest = fakeHost({
      home: HOME,
      folders: { [INBOX]: [fileEntry(INBOX, "a.txt")] },
      capabilities: WITH_STAT,
    });
    useTransfersStore.getState().enqueue(upload(["a.txt"]));
    start({ dream: dest.transport });
    await idle();
    expect(dest.writeFile).not.toHaveBeenCalled();
    expect(items()[0]?.state).toBe("conflict");
  });

  test.each([
    ["with fs.stat", WITH_STAT],
    ["from the folder's listing", ["fs.list", "fs.write.begin"]],
  ])("keep both saves under the first free name (%s)", async (_label, capabilities) => {
    const dest = fakeHost({
      home: HOME,
      folders: { [INBOX]: [fileEntry(INBOX, "notes.md"), fileEntry(INBOX, "notes (2).md")] },
      capabilities,
    });
    useTransfersStore.getState().enqueue(upload(["notes.md"], "keep_both"));
    start({ dream: dest.transport });
    await idle();
    expect(dest.writeFile.mock.calls[0]?.[1]).toEqual({
      dir: INBOX,
      name: "notes (3).md",
      overwrite: false,
    });
    expect(items()[0]).toMatchObject({
      state: "done",
      outcome: "renamed",
      savedAs: "notes (3).md",
    });
  });

  test("skip leaves the one there; replace writes over it and says so", async () => {
    const dest = fakeHost({
      home: HOME,
      folders: { [INBOX]: [fileEntry(INBOX, "a.txt"), fileEntry(INBOX, "b.txt")] },
      capabilities: WITH_STAT,
    });
    const store = useTransfersStore.getState();
    store.enqueue(upload(["a.txt"], "skip"));
    store.enqueue(upload(["b.txt"], "replace"));
    start({ dream: dest.transport });
    await idle();
    expect(items().map((item) => [item.name, item.state, item.outcome])).toEqual([
      ["a.txt", "skipped", null],
      ["b.txt", "done", "replaced"],
    ]);
    expect(dest.writeFile).toHaveBeenCalledTimes(1);
    expect(dest.writeFile.mock.calls[0]?.[1]).toEqual({
      dir: INBOX,
      name: "b.txt",
      overwrite: true,
    });
  });

  test("replace never writes over a folder of the same name: it keeps both", async () => {
    const dest = fakeHost({
      home: HOME,
      folders: { [INBOX]: [folderEntry(INBOX, "build")] },
      capabilities: WITH_STAT,
    });
    useTransfersStore.getState().enqueue(upload(["build"], "replace"));
    start({ dream: dest.transport });
    await idle();
    expect(dest.writeFile.mock.calls.map((call) => call[1])).toEqual([
      { dir: INBOX, name: "build (2)", overwrite: false },
    ]);
    expect(items()[0]).toMatchObject({ state: "done", savedAs: "build (2)" });
  });

  test("a kept-both name keeps a compound extension and is free of every name without regard to case", async () => {
    const dest = fakeHost({
      home: HOME,
      folders: {
        [INBOX]: [fileEntry(INBOX, "logs.tar.gz"), fileEntry(INBOX, "LOGS (2).tar.gz")],
      },
      capabilities: WITH_STAT,
    });
    useTransfersStore.getState().enqueue(upload(["logs.tar.gz"], "keep_both"));
    start({ dream: dest.transport });
    await idle();
    expect(dest.writeFile.mock.calls.map((call) => call[1].name)).toEqual(["logs (3).tar.gz"]);
  });

  test("a name taken between the check and the write goes to the next free one", async () => {
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    const write = dest.writeFile.getMockImplementation();
    dest.writeFile.mockImplementationOnce(async () => {
      dest.tree.get(INBOX)?.push(fileEntry(INBOX, "a.txt"));
      throw fsError("already_exists");
    });
    if (write) dest.writeFile.mockImplementation(write);
    useTransfersStore.getState().enqueue(upload(["a.txt"], "keep_both"));
    start({ dream: dest.transport });
    await idle();
    expect(dest.writeFile.mock.calls.map((call) => call[1].name)).toEqual(["a.txt", "a (2).txt"]);
    expect(items()[0]).toMatchObject({ state: "done", savedAs: "a (2).txt" });
  });

  test("a file the host refuses fails with the host's reason, and the queue goes on", async () => {
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    const write = dest.writeFile.getMockImplementation();
    dest.writeFile.mockImplementationOnce(async () => {
      throw fsError("permission_denied");
    });
    if (write) dest.writeFile.mockImplementation(write);
    useTransfersStore.getState().enqueue(upload(["a.txt", "b.txt"]));
    start({ dream: dest.transport });
    await idle();
    expect(items().map((item) => [item.state, item.error])).toEqual([
      ["failed", "SPAWN D on dream isn't allowed to write to Inbox."],
      ["done", null],
    ]);
  });
});

describe("a picked file the system has cleared away", () => {
  test("says so, and asks for it to be picked again", async () => {
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    useTransfersStore.getState().enqueue(upload(["a.txt"]));
    const engine = createTransferEngine({
      pool: { acquire: async () => dest.transport },
      openLocal: () => {
        throw new Error("ENOENT");
      },
      backgroundEpoch: () => epoch,
      appActive: () => active,
    });
    engines.push(engine);
    engine.kick();
    await idle();
    expect(items()[0]).toMatchObject({
      state: "failed",
      error: "“a.txt” couldn't be read on this device. Pick it again to upload it.",
    });
  });
});

describe("when the app leaves the screen", () => {
  test("a file cut off is interrupted, the queue pauses, and Resume sends it again", async () => {
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    const write = dest.writeFile.getMockImplementation();
    dest.writeFile.mockImplementationOnce(async () => {
      // The phone retires its host connections a few seconds into the background.
      epoch += 1;
      throw fsError("connection_closed");
    });
    if (write) dest.writeFile.mockImplementation(write);
    useTransfersStore.getState().enqueue(upload(["a.txt", "b.txt"]));
    start({ dream: dest.transport });
    await idle();
    expect(useTransfersStore.getState()).toMatchObject({
      paused: true,
      pausedBy: { cause: "background" },
    });
    expect(items().map((item) => item.state)).toEqual(["interrupted", "queued"]);
    expect(items()[0]?.interruption).toEqual({ cause: "background" });

    useTransfersStore.getState().resume();
    await idle();
    expect(items().map((item) => item.state)).toEqual(["done", "done"]);
  });

  test("a file whose end was sent unanswered is checked before it is sent again", async () => {
    const bytes = 5;
    const expected = await hashHostFileSource(localSource(bytes));
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    dest.writeFile.mockImplementationOnce(
      async (
        _source: HostFileSource,
        destination: { dir: string; name: string },
        options?: HostWriteOptions,
      ) => {
        // The end goes out, the file lands, and the answer never comes back.
        options?.onProgress?.({
          phase: "outcome_unknown",
          transferred: bytes,
          total: bytes,
        });
        dest.tree.get(destination.dir)?.push(fileEntry(destination.dir, destination.name));
        epoch += 1;
        throw fsError("outcome_unknown");
      },
    );
    const readFile = jest.fn(async (path: string) => ({
      streamId: "s",
      path,
      name: "a.txt",
      length: bytes,
      sha256: expected,
      stream: new ReadableStream<Uint8Array>(),
    }));
    dest.transport.readFile = readFile;
    useTransfersStore.getState().enqueue({
      ...upload(["a.txt"], "keep_both"),
    });
    start({ dream: dest.transport }, { "file:///cache/a.txt": bytes });
    await idle();
    expect(items()[0]).toMatchObject({ state: "interrupted", unconfirmed: { name: "a.txt" } });

    useTransfersStore.getState().resume();
    await idle();
    expect(readFile).toHaveBeenCalledWith(`${INBOX}/a.txt`, expect.anything());
    // It was there all along: no second copy.
    expect(dest.writeFile).toHaveBeenCalledTimes(1);
    expect(items()[0]).toMatchObject({ state: "done", outcome: "verified", unconfirmed: null });
  });
});

describe("when the connection goes with the app on screen", () => {
  test("the file is interrupted, the queue pauses with the host named, and Resume goes on", async () => {
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    const write = dest.writeFile.getMockImplementation();
    dest.writeFile.mockImplementationOnce(async () => {
      throw fsError("connection_closed");
    });
    if (write) dest.writeFile.mockImplementation(write);
    useTransfersStore.getState().enqueue(upload(["a.txt", "b.txt"]));
    start({ dream: dest.transport });
    await idle();
    expect(useTransfersStore.getState()).toMatchObject({
      paused: true,
      pausedBy: { cause: "lost-touch", host: "dream" },
    });
    expect(items().map((item) => [item.state, item.error])).toEqual([
      ["interrupted", null],
      ["queued", null],
    ]);
    expect(items()[0]?.interruption).toEqual({ cause: "lost-touch", host: "dream" });

    useTransfersStore.getState().resume();
    await idle();
    expect(items().map((item) => item.state)).toEqual(["done", "done"]);
  });

  test("a host that cannot be reached stops the queue once, not once per file", async () => {
    const acquire = jest.fn(async () => {
      throw fsError("host_unreachable");
    });
    useTransfersStore.getState().enqueue(upload(["a", "b", "c"]));
    const engine = createTransferEngine({
      pool: { acquire },
      openLocal: () => localSource(3),
      backgroundEpoch: () => epoch,
      appActive: () => active,
    });
    engines.push(engine);
    engine.kick();
    await idle();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(items().map((item) => item.state)).toEqual(["interrupted", "queued", "queued"]);
    expect(useTransfersStore.getState().pausedBy).toEqual({ cause: "lost-touch", host: "dream" });
  });
});

describe("how long it will take", () => {
  test("a batch expects its route's model speed, and the route keeps what it measured", async () => {
    let clock = 0;
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    Object.assign(dest.transport, { connectionInfo: { kind: "relay", rttMs: 100 } });
    dest.writeFile.mockImplementation(
      async (
        source: HostFileSource,
        destination: { dir: string; name: string },
        options?: HostWriteOptions,
      ) => {
        // Two megabytes over four seconds.
        options?.onProgress?.({ phase: "streaming", transferred: 0, total: source.size });
        clock += 4_000;
        options?.onProgress?.({ phase: "streaming", transferred: source.size, total: source.size });
        return { path: `${destination.dir}/${destination.name}`, length: source.size, sha256: "x" };
      },
    );
    const id = useTransfersStore.getState().enqueue(upload(["big.bin"]));
    const engine = createTransferEngine({
      pool: { acquire: async () => dest.transport },
      openLocal: () => localSource(2 * 1024 * 1024),
      backgroundEpoch: () => epoch,
      appActive: () => active,
      progressIntervalMs: 0,
      now: () => clock,
    });
    engines.push(engine);
    engine.kick();
    await idle();
    const batch = useTransfersStore.getState().batches.find((candidate) => candidate.id === id);
    expect(batch?.rate).toBe((2 * 1024 * 1024) / 4);
    expect(useTransfersStore.getState().routeRates).toEqual({ dream: (2 * 1024 * 1024) / 4 });
  });
});

describe("cancelling", () => {
  test("stops the running file and everything after it in the batch", async () => {
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    dest.writeFile.mockImplementationOnce(
      (_source: HostFileSource, _destination: unknown, options?: HostWriteOptions) =>
        new Promise<HostWriteResult>((_resolve, reject) => {
          started();
          options?.signal?.addEventListener("abort", () => reject(fsError("cancelled")));
        }),
    );
    const id = useTransfersStore.getState().enqueue(upload(["a", "b"]));
    start({ dream: dest.transport });
    await running;
    useTransfersStore.getState().cancelBatch(id);
    await idle();
    expect(items().map((item) => item.state)).toEqual(["cancelled", "cancelled"]);
    expect(dest.writeFile).toHaveBeenCalledTimes(1);
  });
});

describe("sending between hosts", () => {
  const SRC = "/Users/me";

  /** A send of what is listed under SRC, item by item, as the send sheet queues it. */
  function send(
    paths: { relative: string[]; kind?: "file" | "folder"; size?: number }[],
    policy: TransferItem["policy"] = "ask",
  ): NewTransferBatch {
    return {
      kind: "send",
      source: miniHost,
      destination: dreamHost,
      destDir: INBOX,
      destLabel: "Inbox",
      items: paths.map(({ relative, kind = "file", size = 3 }) => ({
        kind,
        name: relative.at(-1) ?? "",
        relative,
        size: kind === "folder" ? null : size,
        source: { kind: "host", path: `${SRC}/${relative.join("/")}` },
        policy: relative.length === 1 ? policy : "ask",
      })),
    };
  }

  const photos = [
    { relative: ["photos"], kind: "folder" as const },
    { relative: ["photos", "a.jpg"] },
    { relative: ["photos", "b.jpg"] },
  ];

  function photoSource() {
    return sendingHost({
      [SRC]: [folderEntry(SRC, "photos")],
      [`${SRC}/photos`]: [
        fileEntry(`${SRC}/photos`, "a.jpg", { size: 3 }),
        fileEntry(`${SRC}/photos`, "b.jpg", { size: 3 }),
      ],
    });
  }

  function photosThere() {
    return fakeHost({
      home: HOME,
      folders: {
        [INBOX]: [folderEntry(INBOX, "photos")],
        [`${INBOX}/photos`]: [fileEntry(`${INBOX}/photos`, "a.jpg")],
      },
      capabilities: WITH_STAT,
    });
  }

  test("makes each folder first, then sends each file under it", async () => {
    const source = sendingHost({
      [SRC]: [folderEntry(SRC, "proj")],
      [`${SRC}/proj`]: [fileEntry(`${SRC}/proj`, "a.txt", { size: 3 })],
    });
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    useTransfersStore
      .getState()
      .enqueue(send([{ relative: ["proj"], kind: "folder" }, { relative: ["proj", "a.txt"] }]));
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(dest.request).toHaveBeenCalledWith(
      "fs.mkdir",
      { path: `${INBOX}/proj` },
      expect.anything(),
    );
    expect(source.transferFileTo).toHaveBeenCalledWith(
      dest.transport,
      `${SRC}/proj/a.txt`,
      `${INBOX}/proj`,
      expect.objectContaining({ name: "a.txt", overwrite: false }),
    );
    expect(items().map((item) => [item.state, item.outcome])).toEqual([
      ["done", "created"],
      ["done", "created"],
    ]);
  });

  test("an empty folder is sent as the empty folder it is", async () => {
    const source = sendingHost({ [SRC]: [folderEntry(SRC, "empty")], [`${SRC}/empty`]: [] });
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    useTransfersStore.getState().enqueue(send([{ relative: ["empty"], kind: "folder" }]));
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(dest.tree.get(INBOX)?.map((entry) => entry.name)).toEqual(["empty"]);
    expect(items()[0]?.state).toBe("done");
  });

  test("keep both on a picked folder makes “photos (2)” and everything in it goes there", async () => {
    const source = photoSource();
    const dest = photosThere();
    useTransfersStore.getState().enqueue(send(photos, "keep_both"));
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(dest.request).toHaveBeenCalledWith(
      "fs.mkdir",
      { path: `${INBOX}/photos (2)` },
      expect.anything(),
    );
    expect(source.transferFileTo.mock.calls.map((call) => [call[2], call[3]?.name])).toEqual([
      [`${INBOX}/photos (2)`, "a.jpg"],
      [`${INBOX}/photos (2)`, "b.jpg"],
    ]);
    expect(items()[0]).toMatchObject({ state: "done", savedAs: "photos (2)" });
    // The folder already there is left as it was.
    expect(dest.tree.get(`${INBOX}/photos`)?.map((entry) => entry.name)).toEqual(["a.jpg"]);
  });

  test("skip on a picked folder leaves the whole folder out", async () => {
    const source = photoSource();
    const dest = photosThere();
    useTransfersStore.getState().enqueue(send(photos, "skip"));
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(source.transferFileTo).not.toHaveBeenCalled();
    expect(items().map((item) => item.state)).toEqual(["skipped", "skipped", "skipped"]);
    expect(dest.tree.get(`${INBOX}/photos`)?.map((entry) => entry.name)).toEqual(["a.jpg"]);
  });

  test("replace on a picked folder merges: a file of the same name is replaced, the rest added", async () => {
    const source = photoSource();
    const dest = photosThere();
    useTransfersStore.getState().enqueue(send(photos, "replace"));
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(source.transferFileTo.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [`${INBOX}/photos`, expect.objectContaining({ name: "a.jpg", overwrite: true })],
      [`${INBOX}/photos`, expect.objectContaining({ name: "b.jpg", overwrite: false })],
    ]);
    expect(items().map((item) => [item.state, item.outcome])).toEqual([
      ["done", "merged"],
      ["done", "replaced"],
      ["done", "created"],
    ]);
  });

  test("ask stops at the picked folder, and what it holds waits for the answer", async () => {
    const source = photoSource();
    const dest = photosThere();
    const id = useTransfersStore.getState().enqueue(send(photos));
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(source.transferFileTo).not.toHaveBeenCalled();
    expect(items().map((item) => item.state)).toEqual(["conflict", "queued", "queued"]);
    expect(items()[0]?.clash).toEqual({ isDir: true });

    const folder = items()[0];
    if (!folder) throw new Error("missing");
    useTransfersStore.getState().decideConflict(id, folder.id, "replace", false);
    await idle();
    expect(items().map((item) => [item.state, item.outcome])).toEqual([
      ["done", "merged"],
      ["done", "replaced"],
      ["done", "created"],
    ]);
  });

  test("a file meeting a folder of its name is never swapped for it", async () => {
    const source = sendingHost({ [SRC]: [fileEntry(SRC, "photos", { size: 3 })] });
    const dest = photosThere();
    useTransfersStore.getState().enqueue(send([{ relative: ["photos"] }]));
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(items()[0]).toMatchObject({ state: "conflict", clash: { isDir: true } });
  });

  test("a folder that cannot be made fails what it holds; the rest still go", async () => {
    const source = sendingHost({
      [SRC]: [fileEntry(SRC, "top.txt", { size: 1 })],
      [`${SRC}/proj`]: [fileEntry(`${SRC}/proj`, "a.txt", { size: 1 })],
    });
    const dest = fakeHost({
      home: HOME,
      folders: { [INBOX]: [] },
      capabilities: WITH_STAT,
      before: (operation) => {
        if (operation === "fs.mkdir") throw fsError("permission_denied");
      },
    });
    useTransfersStore
      .getState()
      .enqueue(
        send([
          { relative: ["proj"], kind: "folder" },
          { relative: ["proj", "a.txt"] },
          { relative: ["top.txt"] },
        ]),
      );
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(items().map((item) => [item.name, item.state, item.error])).toEqual([
      ["proj", "failed", "SPAWN D couldn't make the folder “proj” on dream."],
      ["a.txt", "failed", "SPAWN D couldn't make the folder “proj” on dream."],
      ["top.txt", "done", null],
    ]);
  });

  test("a file gone from its source says so, naming the source host", async () => {
    const source = sendingHost({ [SRC]: [] });
    const dest = fakeHost({ home: HOME, folders: { [INBOX]: [] }, capabilities: WITH_STAT });
    useTransfersStore.getState().enqueue(send([{ relative: ["gone.txt"] }], "keep_both"));
    start({ mini: source.transport, dream: dest.transport });
    await idle();
    expect(items()[0]).toMatchObject({
      state: "failed",
      error: "“gone.txt” is no longer there on mac-mini.",
    });
  });
});
