import { expect, test } from "bun:test";
import { HostControlError } from "@/lib/hostControl";
import { browserStoppedSaving } from "./copy";
import { memorySink } from "./download-sink";
import {
  archiveNames,
  isTransportFailure,
  LocalTransferError,
  TransferEngine,
  type TransferEnv,
  type TransferView,
} from "./transfer-engine";
import { decode, FakeHost, MemorySink, sha } from "./transfer-fakes";
import type { PathKind } from "./transfer-plan";

function setup(hosts: FakeHost[], kinds: Record<string, PathKind> = {}) {
  const byId = new Map(hosts.map((host) => [host.name, host]));
  const releases = new Map<string, { page: string; at: number }>();
  const offline = new Set<string>();
  let changes = 0;
  const env: TransferEnv = {
    host: async (id) => {
      const host = byId.get(id);
      if (!host || offline.has(id)) throw new HostControlError("connection_closed");
      return host;
    },
    hostName: (id) => id,
    flavor: () => "posix",
    pathKind: (id) => kinds[id] ?? "direct",
    rttMs: () => 20,
    connected: (id) => !offline.has(id),
    lastOwnerRelease: (id) => releases.get(id) ?? null,
    tabId: "this-tab",
    now: () => Date.now(),
    hash: async (file) => sha(new Uint8Array(await file.arrayBuffer())),
  };
  const engine = new TransferEngine(env, () => {
    changes += 1;
  });
  /** The other tab that held the connection to `id` let it go. */
  const otherTabLetGo = (id: string) => releases.set(id, { page: "other-tab", at: Date.now() });
  return { engine, env, offline, otherTabLetGo, changes: () => changes };
}

async function until<T>(read: () => T, ok: (value: T) => boolean, ms = 2_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(value)}`);
    await Bun.sleep(2);
  }
}

const viewOf = (engine: TransferEngine, id: string) => engine.view(id) as TransferView;
const phase = (engine: TransferEngine, id: string, wanted: TransferView["phase"]) =>
  until(
    () => viewOf(engine, id),
    (view) => view.phase === wanted,
  );

const file = (name: string, content: string) =>
  new File([content], name, { lastModified: 1_700_000_000_000 });

test("transport failures are told apart from a host's refusals", () => {
  expect(isTransportFailure(new HostControlError("connection_closed"))).toBe(true);
  expect(isTransportFailure(new HostControlError("outcome_unknown"))).toBe(true);
  expect(isTransportFailure(new Error("Host control channel is not ready"))).toBe(true);
  expect(isTransportFailure(new HostControlError("permission_denied"))).toBe(false);
  expect(isTransportFailure(new HostControlError("integrity_mismatch"))).toBe(false);
  expect(isTransportFailure(new TypeError("bug"))).toBe(false);
  expect(isTransportFailure(new DOMException("x", "NotReadableError"))).toBe(false);
});

test("an upload makes its folders and writes every file, then says what it did", async () => {
  const dream = new FakeHost("dream");
  const { engine } = setup([dream]);
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [
      { rel: "site/index.html", file: file("index.html", "<h1>hi</h1>") },
      { rel: "site/css/a.css", file: file("a.css", "body{}") },
      { rel: "notes.md", file: file("notes.md", "# notes") },
    ],
    emptyDirs: ["site/empty"],
    policy: "ask",
  });
  const view = await phase(engine, id, "done");
  expect(decode(dream.files.get("/home/u/site/index.html")?.bytes)).toBe("<h1>hi</h1>");
  expect(decode(dream.files.get("/home/u/site/css/a.css")?.bytes)).toBe("body{}");
  expect(decode(dream.files.get("/home/u/notes.md")?.bytes)).toBe("# notes");
  expect(dream.dirs.has("/home/u/site/empty")).toBe(true);
  expect(view).toMatchObject({
    verb: "upload",
    names: ["site", "notes.md"],
    to: "dream",
    totalItems: 3,
    doneItems: 3,
    failed: 0,
    totalBytes: 11 + 6 + 7,
    doneBytes: 24,
    canDismiss: true,
  });
});

test("a name already there is asked about, and the answer can cover the rest", async () => {
  const dream = new FakeHost("dream")
    .file("/home/u/notes.md", "old notes")
    .file("/home/u/site/index.html", "old index")
    .file("/home/u/site/keep.txt", "untouched")
    .file("/home/u/todo.txt", "old todo");
  const { engine } = setup([dream]);
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [
      { rel: "notes.md", file: file("notes.md", "new notes") },
      { rel: "site/index.html", file: file("index.html", "new index") },
      { rel: "todo.txt", file: file("todo.txt", "new todo") },
    ],
    emptyDirs: [],
    policy: "ask",
  });
  const first = await phase(engine, id, "waiting");
  expect(first.question).toMatchObject({
    kind: "conflict",
    text: "“notes.md” already exists in Home on dream.",
    others: 2,
    othersLabel: "Do this for the other 2",
  });
  expect(first.question?.kind === "conflict" && first.question.choices.map((c) => c.label)).toEqual(
    ["Replace", "Keep both", "Skip"],
  );
  engine.answer(id, { kind: "conflict", decision: "keep-both", applyToOthers: false });
  const second = await until(
    () => viewOf(engine, id),
    (view) => view.question?.text.startsWith("A folder named “site”") === true,
  );
  expect(
    second.question?.kind === "conflict" && second.question.choices.map((c) => c.label),
  ).toEqual(["Merge", "Keep both", "Skip"]);
  engine.answer(id, { kind: "conflict", decision: "replace", applyToOthers: true });
  const done = await phase(engine, id, "done");
  expect(decode(dream.files.get("/home/u/notes.md")?.bytes)).toBe("old notes");
  expect(decode(dream.files.get("/home/u/notes (2).md")?.bytes)).toBe("new notes");
  // Merged: the same name replaced, nothing else touched.
  expect(decode(dream.files.get("/home/u/site/index.html")?.bytes)).toBe("new index");
  expect(decode(dream.files.get("/home/u/site/keep.txt")?.bytes)).toBe("untouched");
  // "Do this for the other 1": todo.txt was replaced without asking.
  expect(decode(dream.files.get("/home/u/todo.txt")?.bytes)).toBe("new todo");
  expect(done.doneItems).toBe(3);
});

test("Skip leaves what is there and counts it", async () => {
  const dream = new FakeHost("dream").file("/home/u/a.txt", "keep");
  const { engine } = setup([dream]);
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [
      { rel: "a.txt", file: file("a.txt", "new") },
      { rel: "b.txt", file: file("b.txt", "b") },
    ],
    emptyDirs: [],
    policy: "skip",
  });
  const view = await phase(engine, id, "done");
  expect(decode(dream.files.get("/home/u/a.txt")?.bytes)).toBe("keep");
  expect(view).toMatchObject({ doneItems: 1, skipped: 1, totalItems: 2 });
});

test("a send walks the folder, keeps both on a clash, and says what it left out", async () => {
  const dream = new FakeHost("dream")
    .file("/home/u/photos/a.jpg", "AAAA")
    .file("/home/u/photos/trip/b.jpg", "BBBBBB")
    .dir("/home/u/photos/empty");
  dream.links.add("/home/u/photos/latest");
  const mini = new FakeHost("mini").file("/home/u/Documents/photos/old.jpg", "old");
  const { engine } = setup([dream, mini]);
  const id = engine.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
    destDir: "/home/u/Documents",
    destLabel: "Documents",
    policy: "keep-both",
  });
  const view = await phase(engine, id, "done");
  expect(decode(mini.files.get("/home/u/Documents/photos (2)/a.jpg")?.bytes)).toBe("AAAA");
  expect(decode(mini.files.get("/home/u/Documents/photos (2)/trip/b.jpg")?.bytes)).toBe("BBBBBB");
  expect(mini.dirs.has("/home/u/Documents/photos (2)/empty")).toBe(true);
  expect(decode(mini.files.get("/home/u/Documents/photos/old.jpg")?.bytes)).toBe("old");
  expect(view).toMatchObject({
    verb: "send",
    from: "dream",
    to: "mini",
    doneItems: 2,
    totalBytes: 10,
    notes: ["1 link was skipped."],
  });
});

test("a tab letting go mid-send interrupts it with Resume, and Resume finishes it", async () => {
  const dream = new FakeHost("dream").file("/home/u/a.bin", "0123456789abcdef");
  const mini = new FakeHost("mini");
  const { engine, otherTabLetGo } = setup([dream, mini]);
  dream.breakReadAfter = 8;
  dream.onBreak = () => otherTabLetGo("dream");
  const id = engine.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [{ path: "/home/u/a.bin", name: "a.bin", isDir: false, size: 16 }],
    destDir: "/home/u",
    destLabel: "Home",
    policy: "ask",
  });
  const paused = await phase(engine, id, "interrupted");
  expect(paused.interruption).toEqual({ cause: "other-tab", host: "dream" });
  expect(paused.canResume).toBe(true);
  expect(mini.files.has("/home/u/a.bin")).toBe(false);
  engine.resume(id);
  await phase(engine, id, "done");
  expect(decode(mini.files.get("/home/u/a.bin")?.bytes)).toBe("0123456789abcdef");
});

test("a host that dropped without another tab letting go is said as lost touch", async () => {
  const dream = new FakeHost("dream").file("/home/u/a.bin", "0123456789");
  const { engine, offline } = setup([dream]);
  dream.breakReadAfter = 4;
  dream.onBreak = () => offline.add("dream");
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/a.bin", name: "a.bin", isDir: false, size: 10 }],
    archive: null,
    sink,
  });
  const paused = await phase(engine, id, "interrupted");
  expect(paused.interruption).toEqual({ cause: "lost-touch", host: "dream" });
  offline.delete("dream");
  engine.resume(id);
  await phase(engine, id, "done");
  expect(decode(sink.bytes())).toBe("0123456789");
  // It picked up at the byte it reached, not from the start.
  expect(dream.ranges.map((range) => range.offset)).toEqual([0, 4]);
  expect(sink.closed).toBe(true);
});

test("a write whose commit may have landed is checked by digest, never written twice", async () => {
  const dream = new FakeHost("dream");
  const { engine, otherTabLetGo } = setup([dream]);
  dream.loseNextCommitAck = true;
  dream.onBreak = () => otherTabLetGo("dream");
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "report.pdf", file: file("report.pdf", "PDF!") }],
    emptyDirs: [],
    policy: "keep-both",
  });
  await phase(engine, id, "interrupted");
  engine.resume(id);
  const view = await phase(engine, id, "done");
  expect(view.doneItems).toBe(1);
  expect([...dream.files.keys()]).toEqual(["/home/u/report.pdf"]);
});

test("a name taken after planning is settled as the policy says", async () => {
  const dream = new FakeHost("dream");
  const { engine } = setup([dream]);
  // Appears between the folder being read and the file being written.
  const list = dream.listPage.bind(dream);
  dream.listPage = async (...args) => {
    const page = await list(...args);
    dream.file("/home/u/a.txt", "someone else's");
    return page;
  };
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "a.txt", file: file("a.txt", "mine") }],
    emptyDirs: [],
    policy: "keep-both",
  });
  await phase(engine, id, "done");
  expect(decode(dream.files.get("/home/u/a.txt")?.bytes)).toBe("someone else's");
  expect(decode(dream.files.get("/home/u/a (2).txt")?.bytes)).toBe("mine");
});

test("a file that changes part-way through a download fails rather than splice two versions", async () => {
  const big = new Uint8Array(40 * 1024 * 1024).map((_, i) => i % 256);
  const dream = new FakeHost("dream").file("/home/u/big.bin", big);
  dream.changeAfterRanges = { path: "/home/u/big.bin", after: 1 };
  const { engine } = setup([dream]);
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/big.bin", name: "big.bin", isDir: false, size: big.length }],
    archive: null,
    sink,
  });
  const view = await phase(engine, id, "failed");
  expect(view.error).toBe("“big.bin” changed while it was being copied. Try again.");
  expect(sink.aborted).toBe(true);
}, 20_000);

test("a folder downloads as one zip; an unreadable file is left out and named", async () => {
  const dream = new FakeHost("dream")
    .file("/home/u/photos/a.jpg", "AAAA")
    .file("/home/u/photos/secret.key", "nope")
    .file("/home/u/photos/trip/b.jpg", "BBBBBB");
  dream.refuse.set("read:/home/u/photos/secret.key", "permission_denied");
  const { engine } = setup([dream]);
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
    archive: "photos.zip",
    sink,
  });
  const view = await phase(engine, id, "failed");
  expect(sink.name).toBe("photos.zip");
  expect(sink.closed).toBe(true);
  expect(view.failures).toEqual([
    { rel: "photos/secret.key", reason: "SPAWN D on dream isn't allowed to read “secret.key”." },
  ]);
  const zip = sink.bytes();
  const names: string[] = [];
  const view8 = new DataView(zip.buffer);
  for (let at = 0; at + 4 <= zip.length; at += 1) {
    if (view8.getUint32(at, true) !== 0x02014b50) continue;
    const length = view8.getUint16(at + 28, true);
    names.push(decode(zip.subarray(at + 46, at + 46 + length)));
  }
  expect(names).toEqual(["photos/", "photos/a.jpg", "photos/trip/", "photos/trip/b.jpg"]);
});

test("OD3: a relayed transfer over 100 MB asks first, and No cancels it untouched", async () => {
  const dream = new FakeHost("dream").file("/home/u/huge.bin", "x");
  const { engine } = setup([dream], { dream: "relay" });
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [
      { path: "/home/u/huge.bin", name: "huge.bin", isDir: false, size: 300 * 1024 * 1024 },
    ],
    archive: null,
    sink,
  });
  const asked = await phase(engine, id, "waiting");
  expect(asked.question).toMatchObject({ kind: "relay", proceed: "Download anyway" });
  expect(asked.question?.text).toStartWith(
    "This transfer goes through the SPAWN D relay because dream and this device can't reach each other directly. 300 MB may take a while.",
  );
  expect(asked.question?.text).toContain("It will take about");
  engine.answer(id, { kind: "relay", proceed: false });
  await phase(engine, id, "cancelled");
  expect(dream.ranges).toEqual([]);
  expect(sink.name).toBeNull();
});

test("transfers to one host take turns; another host's run alongside", async () => {
  const dream = new FakeHost("dream");
  const mini = new FakeHost("mini").file("/home/u/m.txt", "mini");
  const { engine } = setup([dream, mini]);
  let release!: () => void;
  const gateOpen = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = dream.writeStream.bind(dream);
  dream.writeStream = async (...args) => {
    await gateOpen;
    return write(...args);
  };
  const upload = (name: string) =>
    engine.submit({
      kind: "upload",
      hostId: "dream",
      dir: "/home/u",
      dirLabel: "Home",
      items: [{ rel: name, file: file(name, name) }],
      emptyDirs: [],
      policy: "ask",
    });
  const first = upload("one.txt");
  const second = upload("two.txt");
  await phase(engine, first, "running");
  expect(viewOf(engine, second).phase).toBe("queued");
  const sink = new MemorySink();
  const other = engine.submit({
    kind: "download",
    hostId: "mini",
    sources: [{ path: "/home/u/m.txt", name: "m.txt", isDir: false, size: 4 }],
    archive: null,
    sink,
  });
  await phase(engine, other, "done");
  expect(viewOf(engine, second).phase).toBe("queued");
  release();
  await phase(engine, second, "done");
  expect(dream.writes.map((w) => w.name)).toEqual(["one.txt", "two.txt"]);
});

test("cancel stops a transfer and throws away its download", async () => {
  const dream = new FakeHost("dream").file("/home/u/a.bin", "0123456789");
  const { engine } = setup([dream]);
  dream.breakReadAfter = 4;
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/a.bin", name: "a.bin", isDir: false, size: 10 }],
    archive: null,
    sink,
  });
  await phase(engine, id, "interrupted");
  engine.cancel(id);
  await phase(engine, id, "cancelled");
  expect(sink.aborted).toBe(true);
  engine.dismiss(id);
  expect(engine.has(id)).toBe(false);
});

test("a folder past the item limit is refused whole, by its own name", async () => {
  const dream = new FakeHost("dream");
  const { engine } = setup([dream]);
  const items = Array.from({ length: 10_001 }, (_, i) => ({
    rel: `big/f${i}.txt`,
    file: file(`f${i}.txt`, ""),
  }));
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items,
    emptyDirs: [],
    policy: "ask",
  });
  const view = await phase(engine, id, "failed");
  // Named for what was picked, not for the folder it was going into.
  expect(view.error).toBe("“big” holds more than 10,000 items. Pick a smaller folder.");
  expect(dream.writes).toEqual([]);
});

test("failed items can be tried again on their own", async () => {
  const dream = new FakeHost("dream");
  dream.refuse.set("write:/home/u/b.txt", "permission_denied");
  const { engine } = setup([dream]);
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [
      { rel: "a.txt", file: file("a.txt", "a") },
      { rel: "b.txt", file: file("b.txt", "b") },
    ],
    emptyDirs: [],
    policy: "ask",
  });
  const failed = await phase(engine, id, "failed");
  expect(failed.failures).toEqual([
    { rel: "b.txt", reason: "SPAWN D on dream isn't allowed to write to Home." },
  ]);
  dream.refuse.clear();
  engine.retry(id);
  const done = await phase(engine, id, "done");
  expect(done.doneItems).toBe(2);
  expect(dream.writes.map((w) => w.name)).toEqual(["a.txt", "b.txt"]);
});

test("a job picked up from another tab checks what may already be written", async () => {
  const dream = new FakeHost("dream").file("/home/u/photos/a.jpg", "AAAA");
  const mini = new FakeHost("mini").dir("/home/u/photos").file("/home/u/photos/a.jpg", "AAAA");
  const { engine } = setup([dream, mini]);
  const id = engine.submit(
    {
      kind: "send",
      from: "dream",
      to: "mini",
      sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
      destDir: "/home/u",
      destLabel: "Home",
      policy: "ask",
    },
    {
      adopt: {
        items: [
          {
            kind: "dir",
            rel: "photos",
            name: "photos",
            size: 0,
            modified: null,
            srcPath: "/home/u/photos",
            destPath: "/home/u/photos",
            overwrite: false,
            top: true,
            state: "done",
            bytes: 0,
          },
          {
            kind: "file",
            rel: "photos/a.jpg",
            name: "a.jpg",
            size: 4,
            modified: null,
            srcPath: "/home/u/photos/a.jpg",
            destDir: "/home/u/photos",
            overwrite: false,
            top: false,
            state: "pending",
            bytes: 0,
          },
        ],
        notes: [],
        relayConfirmed: true,
      },
    },
  );
  const view = await phase(engine, id, "done");
  expect(view.doneItems).toBe(1);
  expect(mini.writes).toEqual([]);
});

// ---- This device's own end failing ------------------------------------------------------

const settled = (engine: TransferEngine, id: string) =>
  until(
    () => viewOf(engine, id),
    (view) => ["done", "failed", "interrupted", "cancelled"].includes(view.phase),
  );

test("a download memory can't hold fails with memory's own sentence, not as a lost connection", async () => {
  const big = new Uint8Array(64 * 1024).map((_, i) => i % 256);
  const dream = new FakeHost("dream").file("/home/u/big.bin", big);
  const { engine } = setup([dream]);
  // A worker was in control (no limit up front), but its handshake failed: memory took over.
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/big.bin", name: "big.bin", isDir: false, size: big.length }],
    archive: null,
    sink: { limit: null, open: async (name) => memorySink(name, 16 * 1024, () => {}) },
  });
  const view = await settled(engine, id);
  expect(view.phase).toBe("failed");
  expect(view.interruption).toBeNull();
  expect(view.canResume).toBe(false);
  expect(view.error).toBe(
    "This browser can only save up to 16 KB at a time from SPAWN D. Reload the page and try again, or use Chrome or Edge.",
  );
});

test("a download the browser stopped saving fails and says so", async () => {
  const dream = new FakeHost("dream").file("/home/u/movie.mov", "0123456789");
  const { engine } = setup([dream]);
  let aborted = false;
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/movie.mov", name: "movie.mov", isDir: false, size: 10 }],
    archive: null,
    sink: {
      limit: null,
      open: async (name) => ({
        // What the stream sink throws once the browser cancels its download.
        write: async () => {
          throw new Error(browserStoppedSaving(name));
        },
        close: async () => {},
        abort: async () => {
          aborted = true;
        },
      }),
    },
  });
  const view = await settled(engine, id);
  expect(view.phase).toBe("failed");
  expect(view.error).toBe("The browser stopped saving “movie.mov”.");
  expect(aborted).toBe(true);
  // Nothing is read again for a save that can't take it.
  expect(dream.ranges.map((range) => range.offset)).toEqual([0]);
});

test("a step on this device is never taken for a lost connection", () => {
  expect(isTransportFailure(new LocalTransferError(new Error("anything")))).toBe(false);
  expect(new LocalTransferError(new Error("The browser stopped saving “a”.")).message).toBe(
    "The browser stopped saving “a”.",
  );
});

test("names a zip would fold together are kept apart in the archive", async () => {
  const dream = new FakeHost("dream")
    .file("/home/u/d/a\\b", "one")
    .file("/home/u/d/a_b", "two")
    .file("/home/u/d/Docs/x.txt", "upper")
    .file("/home/u/d/docs/y.txt", "lower");
  const { engine } = setup([dream]);
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/d", name: "d", isDir: true }],
    archive: "d.zip",
    sink,
  });
  const view = await settled(engine, id);
  expect(view.phase).toBe("done");
  const zip = sink.bytes();
  const names: string[] = [];
  const data = new DataView(zip.buffer);
  for (let at = 0; at + 4 <= zip.length; at += 1) {
    if (data.getUint32(at, true) !== 0x02014b50) continue;
    names.push(decode(zip.subarray(at + 46, at + 46 + data.getUint16(at + 28, true))));
  }
  expect(names.sort()).toEqual(
    [
      "d/",
      "d/Docs/",
      "d/Docs/x.txt",
      "d/a_b",
      "d/a_b (2)",
      "d/docs (2)/",
      "d/docs (2)/y.txt",
    ].sort(),
  );
});

test("archive names: cleaned, kept apart without case, children follow a renamed folder", () => {
  expect(
    archiveNames([
      { rel: ["p"], kind: "dir" },
      { rel: ["p", "A"], kind: "dir" },
      { rel: ["p", "A", "x"], kind: "file" },
      { rel: ["p", "a"], kind: "file" },
      { rel: ["p", "notes.tar.gz"], kind: "file" },
      { rel: ["p", "NOTES.tar.gz"], kind: "file" },
      { rel: ["p", ".."], kind: "file" },
    ]),
  ).toEqual(["p/", "p/A/", "p/A/x", "p/a (2)", "p/notes.tar.gz", "p/NOTES (2).tar.gz", "p/_"]);
});

// ---- A streamed download's length ---------------------------------------------------------

test("a single-file download is opened at the length the host declared, not the listing's", async () => {
  // Listed at 4 bytes; it has grown to 10 by the time it is read.
  const dream = new FakeHost("dream").file("/home/u/app.log", "0123456789");
  const { engine } = setup([dream]);
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/app.log", name: "app.log", isDir: false, size: 4 }],
    archive: null,
    sink,
  });
  await phase(engine, id, "done");
  expect(sink.size).toBe(10);
  expect(decode(sink.bytes())).toBe("0123456789");
});

test("without ranged reads, the length is the one fs.read declared", async () => {
  const dream = new FakeHost("dream").file("/home/u/app.log", "0123456789");
  dream.capabilities.delete("fs.read.range");
  const { engine } = setup([dream]);
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/app.log", name: "app.log", isDir: false, size: 99 }],
    archive: null,
    sink,
  });
  await phase(engine, id, "done");
  expect(sink.size).toBe(10);
  expect(decode(sink.bytes())).toBe("0123456789");
});

// ---- A destination listed only in part ----------------------------------------------------

/** A folder with more entries than the host lists (its 1,024 cap), "photos" among the unlisted. */
function crowded(name: string) {
  const host = new FakeHost(name);
  for (let i = 0; i < 1_200; i += 1) host.dir(`/home/u/Documents/d${String(i).padStart(4, "0")}`);
  host.file("/home/u/Documents/photos/old.jpg", "old");
  return host;
}

test("a picked folder past the listed part of the destination is still seen: Keep both", async () => {
  const dream = new FakeHost("dream").file("/home/u/photos/a.jpg", "AAAA");
  const mini = crowded("mini");
  const { engine } = setup([dream, mini]);
  const id = engine.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
    destDir: "/home/u/Documents",
    destLabel: "Documents",
    policy: "keep-both",
  });
  await phase(engine, id, "done");
  expect(decode(mini.files.get("/home/u/Documents/photos (2)/a.jpg")?.bytes)).toBe("AAAA");
  expect(mini.files.has("/home/u/Documents/photos/a.jpg")).toBe(false);
});

test("…and Skip leaves it alone, and Ask asks", async () => {
  const dream = new FakeHost("dream").file("/home/u/photos/a.jpg", "AAAA");
  const mini = crowded("mini");
  const { engine } = setup([dream, mini]);
  const skip = engine.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
    destDir: "/home/u/Documents",
    destLabel: "Documents",
    policy: "skip",
  });
  const skipped = await phase(engine, skip, "done");
  expect(mini.files.has("/home/u/Documents/photos/a.jpg")).toBe(false);
  expect(skipped.skipped).toBe(1);
  const ask = engine.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
    destDir: "/home/u/Documents",
    destLabel: "Documents",
    policy: "ask",
  });
  const asked = await phase(engine, ask, "waiting");
  expect(asked.question?.text).toBe("A folder named “photos” already exists in Documents on mini.");
  engine.cancel(ask);
});

test("a Keep both name taken past the listed part moves on to the next free one", async () => {
  const dream = new FakeHost("dream").file("/home/u/photos/a.jpg", "AAAA");
  const mini = crowded("mini").dir("/home/u/Documents/photos (2)");
  // Without fs.stat, the name is looked up by listing it.
  mini.capabilities.delete("fs.stat");
  const { engine } = setup([dream, mini]);
  const id = engine.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
    destDir: "/home/u/Documents",
    destLabel: "Documents",
    policy: "keep-both",
  });
  await phase(engine, id, "done");
  expect(decode(mini.files.get("/home/u/Documents/photos (3)/a.jpg")?.bytes)).toBe("AAAA");
});

// ---- Links picked directly ---------------------------------------------------------------

test("a link picked directly is skipped and counted, never sent as a file", async () => {
  const dream = new FakeHost("dream").file("/home/u/a.txt", "a");
  dream.links.add("/home/u/latest");
  const mini = new FakeHost("mini");
  const { engine } = setup([dream, mini]);
  const id = engine.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [
      { path: "/home/u/latest", name: "latest", isDir: false, kind: "link" },
      { path: "/home/u/a.txt", name: "a.txt", isDir: false, kind: "file", size: 1 },
    ],
    destDir: "/home/u",
    destLabel: "Home",
    policy: "ask",
  });
  const view = await phase(engine, id, "done");
  expect(view.notes).toEqual(["1 link was skipped."]);
  expect(view.failed).toBe(0);
  expect(mini.writes.map((write) => write.name)).toEqual(["a.txt"]);
});

test("a download of nothing but a link opens no download at all", async () => {
  const dream = new FakeHost("dream");
  dream.links.add("/home/u/latest");
  const { engine } = setup([dream]);
  const sink = new MemorySink();
  const id = engine.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/latest", name: "latest", isDir: false, kind: "link" }],
    archive: null,
    sink,
  });
  const view = await phase(engine, id, "done");
  expect(view.notes).toEqual(["1 link was skipped."]);
  expect(sink.name).toBeNull();
});

// ---- Folders named in errors, and a big file's fingerprint ---------------------------------

test("a failure inside a folder names the folder it was going into", async () => {
  const dream = new FakeHost("dream");
  dream.refuse.set("write:/home/u/site/css/a.css", "permission_denied");
  const { engine } = setup([dream]);
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "site/css/a.css", file: file("a.css", "body{}") }],
    emptyDirs: [],
    policy: "ask",
  });
  const view = await phase(engine, id, "failed");
  expect(view.failures).toEqual([
    { rel: "site/css/a.css", reason: "SPAWN D on dream isn't allowed to write to css." },
  ]);
  expect(view).toMatchObject({ folder: "Home", to: "dream" });
});

test("a big local file says how far its fingerprint is: Preparing… N%", async () => {
  const dream = new FakeHost("dream");
  const { engine, env } = setup([dream]);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const big = new File([new Uint8Array(20 * 1024 * 1024)], "big.bin");
  const hash = env.hash as NonNullable<TransferEnv["hash"]>;
  env.hash = async (value, onBytes) => {
    onBytes?.(value.size / 4);
    await held;
    return hash(value);
  };
  const id = engine.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "big.bin", file: big }],
    emptyDirs: [],
    policy: "ask",
  });
  const preparing = await until(
    () => viewOf(engine, id),
    (view) => view.preparing !== null,
  );
  expect(preparing.preparing).toBe(25);
  finish();
  const done = await phase(engine, id, "done");
  expect(done.preparing).toBeNull();
}, 20_000);
