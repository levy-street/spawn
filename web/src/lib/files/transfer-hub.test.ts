import { afterEach, expect, test } from "bun:test";
import { HostControlError } from "@/lib/hostControl";
import { TransferEngine, type TransferEnv, type TransferView } from "./transfer-engine";
import { decode, FakeHost, MemorySink, sha } from "./transfer-fakes";
import { type HubBus, TransferHub } from "./transfer-hub";

/** BroadcastChannel as tabs see it: every other tab hears, cloned, a moment later. */
class Bus implements HubBus {
  static all = new Set<Bus>();
  /** A tab that has gone quiet: it neither sends nor hears. */
  silent = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor() {
    Bus.all.add(this);
  }
  postMessage(data: unknown): void {
    if (this.silent) return;
    const copy = structuredClone(data);
    for (const bus of Bus.all)
      if (bus !== this && !bus.silent) queueMicrotask(() => bus.onmessage?.({ data: copy }));
  }
  close(): void {
    Bus.all.delete(this);
  }
}

const hubs: TransferHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  Bus.all.clear();
});

const FAST = { acceptMs: 80, heartbeatMs: 20, silenceMs: 120 };

/** One browser tab: its engine, its hub, and who it thinks holds each host's connection. */
function tab(name: string, hosts: FakeHost[], owner: { current: string }) {
  const byId = new Map(hosts.map((host) => [host.name, host]));
  const env: TransferEnv = {
    host: async (id) => {
      const host = byId.get(id);
      if (!host) throw new HostControlError("connection_closed");
      return host;
    },
    hostName: (id) => id,
    flavor: () => "posix",
    pathKind: () => "direct",
    rttMs: () => 10,
    connected: () => true,
    lastOwnerRelease: () => null,
    tabId: name,
    now: () => Date.now(),
    hash: async (file) => sha(new Uint8Array(await file.arrayBuffer())),
  };
  let hub!: TransferHub;
  const engine = new TransferEngine(env, () => hub?.engineChanged());
  const bus = new Bus();
  hub = new TransferHub(engine, {
    tabId: name,
    bus,
    ownerOf: () => owner.current,
    hostName: (id) => id,
    onChange: () => {},
    timing: FAST,
  });
  hubs.push(hub);
  return { name, engine, hub, bus };
}

async function until<T>(read: () => T, ok: (value: T) => boolean, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(value)}`);
    await Bun.sleep(3);
  }
}

const only = (hub: TransferHub) => hub.views()[0] as TransferView & { elsewhere: boolean };
const file = (name: string, content: string) => new File([content], name);

test("an upload asked for in another tab runs in the tab that holds the connection", async () => {
  const dream = new FakeHost("dream");
  const owner = { current: "owner" };
  const ownerTab = tab("owner", [dream], owner);
  const follower = tab("follower", [dream], owner);
  follower.hub.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "a.txt", file: file("a.txt", "from the follower") }],
    emptyDirs: [],
    policy: "ask",
  });
  const mirrored = await until(
    () => only(follower.hub),
    (view) => view?.phase === "done",
  );
  expect(mirrored.elsewhere).toBe(true);
  expect(mirrored.doneItems).toBe(1);
  expect(decode(dream.files.get("/home/u/a.txt")?.bytes)).toBe("from the follower");
  // It ran in the owner, which lists it too.
  expect(ownerTab.engine.views().map((view) => view.phase)).toEqual(["done"]);
  expect(follower.engine.views()).toEqual([]);
  // Dismissed in the tab that asked, it goes from both.
  follower.hub.dismiss(mirrored.id);
  await until(
    () => ownerTab.engine.views().length,
    (count) => count === 0,
  );
});

test("a question raised in the owner is answered from the tab that asked", async () => {
  const dream = new FakeHost("dream").file("/home/u/a.txt", "old");
  const owner = { current: "owner" };
  tab("owner", [dream], owner);
  const follower = tab("follower", [dream], owner);
  const id = follower.hub.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "a.txt", file: file("a.txt", "new") }],
    emptyDirs: [],
    policy: "ask",
  });
  await until(
    () => only(follower.hub),
    (view) => view?.question?.kind === "conflict",
  );
  follower.hub.answer(id, { kind: "conflict", decision: "replace", applyToOthers: false });
  await until(
    () => only(follower.hub),
    (view) => view?.phase === "done",
  );
  expect(decode(dream.files.get("/home/u/a.txt")?.bytes)).toBe("new");
});

test("when the owner goes, the job says so and Resume carries on from where it was", async () => {
  const dream = new FakeHost("dream")
    .file("/home/u/photos/a.jpg", "AAAA")
    .file("/home/u/photos/b.jpg", "BBBB");
  const mini = new FakeHost("mini");
  const owner = { current: "owner" };
  const ownerTab = tab("owner", [dream, mini], owner);
  const follower = tab("follower", [dream, mini], owner);
  // The owner sends the first file, then hangs before the second.
  let release!: () => void;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const write = mini.writeStream.bind(mini);
  mini.writeStream = async (...args) => {
    writes += 1;
    if (writes === 2) await hang;
    return write(...args);
  };
  const id = follower.hub.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
    destDir: "/home/u",
    destLabel: "Home",
    policy: "ask",
  });
  await until(
    () => only(follower.hub),
    (view) => view?.doneItems === 1,
  );
  // The owner tab closes: it says goodbye, and the follower holds the connection now.
  ownerTab.hub.goodbye();
  ownerTab.bus.silent = true;
  owner.current = "follower";
  const interrupted = await until(
    () => only(follower.hub),
    (view) => view?.phase === "interrupted",
  );
  expect(interrupted.interruption?.cause).toBe("other-tab");
  expect(interrupted.canResume).toBe(true);
  follower.hub.resume(id);
  const done = await until(
    () => follower.hub.views().find((view) => view.id === id),
    (view) => view?.phase === "done",
  );
  expect(done?.elsewhere).toBe(false);
  expect(decode(mini.files.get("/home/u/photos/a.jpg")?.bytes)).toBe("AAAA");
  expect(decode(mini.files.get("/home/u/photos/b.jpg")?.bytes)).toBe("BBBB");
  // a.jpg was not sent again: the follower took the plan and the progress.
  expect(writes).toBe(3);
  release();
});

test("an owner that falls silent counts as gone", async () => {
  const dream = new FakeHost("dream");
  const owner = { current: "owner" };
  const ownerTab = tab("owner", [dream], owner);
  const follower = tab("follower", [dream], owner);
  const write = dream.writeStream.bind(dream);
  dream.writeStream = async (...args) => {
    ownerTab.bus.silent = true;
    await new Promise(() => {});
    return write(...args);
  };
  follower.hub.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "a.txt", file: file("a.txt", "x") }],
    emptyDirs: [],
    policy: "ask",
  });
  await until(
    () => only(follower.hub),
    (view) => view?.phase === "interrupted",
  );
});

test("an owner that never answers leaves the job to run here", async () => {
  const dream = new FakeHost("dream");
  const owner = { current: "gone" };
  const follower = tab("follower", [dream], owner);
  follower.hub.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "a.txt", file: file("a.txt", "here") }],
    emptyDirs: [],
    policy: "ask",
  });
  const view = await until(
    () => only(follower.hub),
    (current) => current?.phase === "done",
  );
  expect(view.elsewhere).toBe(false);
  expect(decode(dream.files.get("/home/u/a.txt")?.bytes)).toBe("here");
});

test("a download always runs in the tab that asked: its bytes end there", async () => {
  const dream = new FakeHost("dream").file("/home/u/a.txt", "bytes");
  const owner = { current: "owner" };
  const ownerTab = tab("owner", [dream], owner);
  const follower = tab("follower", [dream], owner);
  const sink = new MemorySink();
  follower.hub.submit({
    kind: "download",
    hostId: "dream",
    sources: [{ path: "/home/u/a.txt", name: "a.txt", isDir: false, size: 5 }],
    archive: null,
    sink,
  });
  await until(
    () => only(follower.hub),
    (view) => view?.phase === "done",
  );
  expect(decode(sink.bytes())).toBe("bytes");
  expect(ownerTab.engine.views()).toEqual([]);
});

test("cancel from the tab that asked stops the job where it runs", async () => {
  const dream = new FakeHost("dream");
  const owner = { current: "owner" };
  const ownerTab = tab("owner", [dream], owner);
  const follower = tab("follower", [dream], owner);
  const write = dream.writeStream.bind(dream);
  dream.writeStream = async (stream, declaration, signal) => {
    await new Promise((resolve) => signal?.addEventListener("abort", resolve));
    return write(stream, declaration, signal);
  };
  const id = follower.hub.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "a.txt", file: file("a.txt", "x") }],
    emptyDirs: [],
    policy: "ask",
  });
  await until(
    () => only(follower.hub),
    (view) => view?.phase === "running",
  );
  follower.hub.cancel(id);
  await until(
    () => only(follower.hub),
    (view) => view?.phase === "cancelled",
  );
  expect(ownerTab.engine.views().map((view) => view.phase)).toEqual(["cancelled"]);
});

test("Resume on a job whose runner only went quiet carries on there, without starting over", async () => {
  const dream = new FakeHost("dream");
  const owner = { current: "owner" };
  const ownerTab = tab("owner", [dream], owner);
  const follower = tab("follower", [dream], owner);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const write = dream.writeStream.bind(dream);
  dream.writeStream = async (...args) => {
    writes += 1;
    await held;
    return write(...args);
  };
  const id = follower.hub.submit({
    kind: "upload",
    hostId: "dream",
    dir: "/home/u",
    dirLabel: "Home",
    items: [{ rel: "a.txt", file: file("a.txt", "slow") }],
    emptyDirs: [],
    policy: "ask",
  });
  await until(
    () => writes,
    (count) => count === 1,
  );
  // The runner's reports stop for a while (a throttled background tab).
  ownerTab.bus.silent = true;
  await until(
    () => only(follower.hub),
    (view) => view?.phase === "interrupted",
  );
  ownerTab.bus.silent = false;
  follower.hub.resume(id);
  release();
  await until(
    () => only(follower.hub),
    (view) => view?.phase === "done",
  );
  // The same write finished: nothing was released, nothing written twice.
  expect(writes).toBe(1);
  expect(decode(dream.files.get("/home/u/a.txt")?.bytes)).toBe("slow");
});

test("the plan reaches the tab that asked before the first write, so a Resume never plans afresh", async () => {
  const dream = new FakeHost("dream").file("/home/u/photos/a.jpg", "AAAA");
  const mini = new FakeHost("mini");
  const owner = { current: "owner" };
  const ownerTab = tab("owner", [dream, mini], owner);
  const follower = tab("follower", [dream, mini], owner);
  // The owner commits the first file and dies there, before any timer of its
  // own runs: nothing but what it said synchronously reached the follower.
  let writes = 0;
  const write = mini.writeStream.bind(mini);
  mini.writeStream = async (...args) => {
    writes += 1;
    if (writes === 1) {
      await write(...args);
      ownerTab.bus.silent = true;
      owner.current = "follower";
      await new Promise(() => {});
    }
    return write(...args);
  };
  const id = follower.hub.submit({
    kind: "send",
    from: "dream",
    to: "mini",
    sources: [{ path: "/home/u/photos", name: "photos", isDir: true }],
    destDir: "/home/u",
    destLabel: "Home",
    policy: "ask",
  });
  await until(
    () => only(follower.hub),
    (view) => view?.phase === "interrupted",
  );
  follower.hub.resume(id);
  const done = await until(
    () => follower.hub.views().find((view) => view.id === id),
    (view) => view?.phase === "done" || view?.question !== null,
  );
  // Carried on from the plan: the folder it made is its own, not a clash to
  // ask about, and the file it wrote is checked by digest, not copied again.
  expect(done?.question).toBeNull();
  expect(done?.phase).toBe("done");
  expect([...mini.files.keys()]).toEqual(["/home/u/photos/a.jpg"]);
  expect(mini.writes).toHaveLength(1);
});
