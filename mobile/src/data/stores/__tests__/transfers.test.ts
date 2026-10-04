import {
  batchPercent,
  hostsInUse,
  isSettledBatch,
  type NewTransferBatch,
  nextQueuedItem,
  summarizeTransfers,
  useTransfersStore,
} from "@/data/stores/transfers";

const dream = { id: "dream", name: "dream", publicKey: "k1", os: "linux" };
const mini = { id: "mini", name: "mac-mini", publicKey: "k2", os: "macos" };

function upload(names: string[], extra: Partial<NewTransferBatch> = {}): NewTransferBatch {
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
    ...extra,
  };
}

/** A send of `paths`: a folder for each path that has something below it, files otherwise. */
function send(paths: string[][]): NewTransferBatch {
  const folders = new Set(paths.filter((path) => path.length > 1).map((path) => path[0]));
  return {
    kind: "send",
    source: mini,
    destination: dream,
    destDir: "/home/me/Inbox",
    destLabel: "Inbox",
    items: paths.map((relative) => ({
      kind: relative.length === 1 && folders.has(relative[0]) ? "folder" : "file",
      name: relative.at(-1) ?? "",
      relative,
      size: 10,
      source: { kind: "host", path: `/src/${relative.join("/")}` },
      policy: "ask",
    })),
  };
}

function batchById(id: string) {
  const batch = useTransfersStore.getState().batches.find((candidate) => candidate.id === id);
  if (!batch) throw new Error("missing batch");
  return batch;
}

beforeEach(() => {
  useTransfersStore.getState().reset();
});

describe("the transfers queue", () => {
  test("runs files in the order they were asked for, and nothing while paused", () => {
    const store = useTransfersStore.getState();
    const first = store.enqueue(upload(["a.txt", "b.txt"]));
    store.enqueue(upload(["c.txt"]));
    expect(nextQueuedItem(useTransfersStore.getState())?.item.name).toBe("a.txt");
    const a = batchById(first).items[0];
    if (!a) throw new Error("missing");
    store.patchItem(first, a.id, { state: "done" });
    expect(nextQueuedItem(useTransfersStore.getState())?.item.name).toBe("b.txt");
    store.pause({ cause: "background" });
    expect(nextQueuedItem(useTransfersStore.getState())).toBeNull();
    expect(hostsInUse(useTransfersStore.getState())).toEqual([]);
  });

  test("a refused file is in the batch, failed with its reason", () => {
    const id = useTransfersStore.getState().enqueue(
      upload(["ok.txt"], {
        refused: [
          {
            item: {
              name: "huge.iso",
              size: 600,
              source: { kind: "local", uri: "file:///cache/huge.iso", mimeType: null },
              policy: "ask",
            },
            reason: "too big",
          },
        ],
      }),
    );
    expect(batchById(id).items.map((item) => [item.name, item.state, item.error])).toEqual([
      ["ok.txt", "queued", null],
      ["huge.iso", "failed", "too big"],
    ]);
  });

  test("cancel stops what is waiting and leaves the running file to the engine", () => {
    const store = useTransfersStore.getState();
    const id = store.enqueue(upload(["a", "b", "c"]));
    const [a, b, c] = batchById(id).items;
    if (!a || !b || !c) throw new Error("missing");
    store.patchItem(id, a.id, { state: "running" });
    store.patchItem(id, c.id, { state: "conflict" });
    store.cancelBatch(id);
    const batch = batchById(id);
    expect(batch.cancelled).toBe(true);
    expect(batch.items.map((item) => item.state)).toEqual(["running", "cancelled", "cancelled"]);
  });

  test("retry puts failed and cancelled files back, cleared", () => {
    const store = useTransfersStore.getState();
    const id = store.enqueue(upload(["a", "b"]));
    const [a, b] = batchById(id).items;
    if (!a || !b) throw new Error("missing");
    store.patchItem(id, a.id, { state: "failed", error: "nope", transferred: 50 });
    store.patchItem(id, b.id, { state: "done" });
    store.retryBatch(id);
    expect(batchById(id).items.map((item) => [item.state, item.error, item.transferred])).toEqual([
      ["queued", null, 0],
      ["done", null, 0],
    ]);
  });

  test("an answer to a taken name can be given for the other picked items too", () => {
    const store = useTransfersStore.getState();
    const id = store.enqueue(send([["a"], ["b"], ["c"], ["d"], ["e", "inside.txt"]]));
    const [a, b, , d] = batchById(id).items;
    if (!a || !b || !d) throw new Error("missing");
    store.patchItem(id, a.id, { state: "conflict", clash: { isDir: false } });
    store.patchItem(id, b.id, { state: "conflict", clash: { isDir: false } });
    store.patchItem(id, d.id, { state: "done" });
    store.decideConflict(id, a.id, "keep_both", true);
    expect(batchById(id).items.map((item) => [item.state, item.policy, item.clash])).toEqual([
      ["queued", "keep_both", null],
      ["queued", "keep_both", null],
      ["queued", "keep_both", null],
      ["done", "ask", null],
      // What is inside a folder follows its folder, not the answer for the rest.
      ["queued", "ask", null],
    ]);
  });

  test("resume sends again what the background cut off", () => {
    const store = useTransfersStore.getState();
    const id = store.enqueue(upload(["a"]));
    const [a] = batchById(id).items;
    if (!a) throw new Error("missing");
    store.patchItem(id, a.id, {
      state: "interrupted",
      unconfirmed: { name: "a" },
      interruption: { cause: "background" },
    });
    store.pause({ cause: "background" });
    // The first cause is the one said.
    store.pause({ cause: "lost-touch", host: "dream" });
    expect(useTransfersStore.getState().pausedBy).toEqual({ cause: "background" });
    store.resume();
    const state = useTransfersStore.getState();
    expect(state.paused).toBe(false);
    expect(state.pausedBy).toBeNull();
    // What may have arrived is still to be checked when it runs again.
    expect(batchById(id).items[0]).toMatchObject({
      state: "queued",
      unconfirmed: { name: "a" },
      interruption: null,
    });
  });

  test("clear finished removes only batches with nothing left to run", () => {
    const store = useTransfersStore.getState();
    const done = store.enqueue(upload(["a"]));
    const live = store.enqueue(upload(["b"]));
    const [a] = batchById(done).items;
    if (!a) throw new Error("missing");
    store.patchItem(done, a.id, { state: "done" });
    expect(isSettledBatch(batchById(done))).toBe(true);
    const removed = store.clearFinished();
    expect(removed.map((batch) => batch.id)).toEqual([done]);
    expect(useTransfersStore.getState().batches.map((batch) => batch.id)).toEqual([live]);
  });

  test("the summary counts transfers, not files: what moves, what needs someone, how far", () => {
    const store = useTransfersStore.getState();
    const id = store.enqueue(
      upload(["a", "b"], { kind: "send", source: mini, destination: dream }),
    );
    const [a, b] = batchById(id).items;
    if (!a || !b) throw new Error("missing");
    store.patchItem(id, a.id, { state: "done", total: 100 });
    store.patchItem(id, b.id, {
      state: "running",
      phase: "streaming",
      transferred: 50,
      total: 100,
    });
    const summary = summarizeTransfers(useTransfersStore.getState());
    expect(summary).toMatchObject({
      active: 1,
      percent: 75,
      needsYou: 0,
      running: true,
      any: true,
    });
    expect(batchPercent(batchById(id))).toBe(75);
    expect(hostsInUse(useTransfersStore.getState()).map((host) => host.id)).toEqual([
      "mini",
      "dream",
    ]);
  });

  test("a batch of a thousand files is one transfer, and one with many failures needs no one", () => {
    const store = useTransfersStore.getState();
    const many = store.enqueue(upload(Array.from({ length: 1000 }, (_, index) => `f${index}`)));
    expect(summarizeTransfers(useTransfersStore.getState())).toMatchObject({
      active: 1,
      needsYou: 0,
    });
    for (const item of batchById(many).items) {
      store.patchItem(many, item.id, { state: "failed", error: "nope" });
    }
    // Settled, it is done; its failures are said by its notice and in the sheet.
    expect(summarizeTransfers(useTransfersStore.getState())).toMatchObject({
      active: 0,
      needsYou: 0,
    });
    const asking = store.enqueue(upload(["x", "y", "z"]));
    for (const item of batchById(asking).items) {
      store.patchItem(asking, item.id, { state: "conflict" });
    }
    expect(summarizeTransfers(useTransfersStore.getState())).toMatchObject({
      active: 1,
      needsYou: 1,
    });
  });

  test("what is inside a folder waits until the folder is made, and follows it out", () => {
    const store = useTransfersStore.getState();
    const id = store.enqueue(send([["photos"], ["photos", "a.jpg"], ["notes.md"]]));
    const [photos, inside, notes] = batchById(id).items;
    if (!photos || !inside || !notes) throw new Error("missing");
    expect(nextQueuedItem(useTransfersStore.getState())?.item.id).toBe(photos.id);
    store.patchItem(id, photos.id, { state: "conflict", clash: { isDir: true } });
    // The folder waits on an answer; what is in it waits with it, the rest goes on.
    expect(nextQueuedItem(useTransfersStore.getState())?.item.id).toBe(notes.id);
    store.patchItem(id, notes.id, { state: "done" });
    expect(nextQueuedItem(useTransfersStore.getState())).toBeNull();
    // Waiting on the person holds no channel open.
    expect(hostsInUse(useTransfersStore.getState())).toEqual([]);
    store.decideConflict(id, photos.id, "replace", false);
    store.patchItem(id, photos.id, { state: "done", outcome: "merged" });
    expect(nextQueuedItem(useTransfersStore.getState())?.item.id).toBe(inside.id);
    store.settleInside(id, ["photos"], { state: "skipped" });
    expect(batchById(id).items.map((item) => item.state)).toEqual(["done", "skipped", "done"]);
  });

  test("retrying a folder takes what it holds with it", () => {
    const store = useTransfersStore.getState();
    const id = store.enqueue(send([["photos"], ["photos", "a.jpg"], ["other.txt"]]));
    const [photos, inside, other] = batchById(id).items;
    if (!photos || !inside || !other) throw new Error("missing");
    store.patchItem(id, photos.id, { state: "failed", error: "no" });
    store.settleInside(id, ["photos"], { state: "failed", error: "no" });
    store.patchItem(id, other.id, { state: "failed", error: "no" });
    store.retryItem(id, photos.id);
    expect(batchById(id).items.map((item) => item.state)).toEqual(["queued", "queued", "failed"]);
  });
});
