import { afterEach, beforeEach, expect, jest, type Mock, spyOn, test } from "bun:test";
import { CHANNEL_WATCH_TIMING, type ChannelWatchTiming } from "./channel-watch";
import { DaemonSendScheduler, RemoteDaemonChannel } from "./daemon-channel";
import { type DaemonSnapshot, SharedDaemonConnection } from "./daemon-connection";
import type { HostControlClient, HostControlState } from "./hostControl";

class Bus {
  static instances = new Set<Bus>();
  static messages: unknown[] = [];
  static delayOpens = false;
  // A hung tab: it neither delivers nor receives messages.
  static hung = new Set<Bus>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    Bus.instances.add(this);
  }
  postMessage(data: unknown) {
    Bus.messages.push(structuredClone(data));
    if (Bus.delayOpens && (data as { type: string }).type === "channel-open") return;
    if (Bus.hung.has(this)) return;
    for (const bus of Bus.instances)
      if (bus !== this && bus.name === this.name)
        queueMicrotask(() => {
          if (Bus.instances.has(bus) && !Bus.hung.has(bus))
            bus.onmessage?.({ data: structuredClone(data) });
        });
  }
  close() {
    Bus.instances.delete(this);
  }
}
class Locks {
  queues = new Map<string, Array<{ begin: () => void; stolen?: () => void }>>();
  request(
    name: string,
    options: { signal?: AbortSignal; steal?: boolean },
    callback: () => Promise<void>,
  ) {
    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      let started = false;
      let stolen = false;
      const entry = {
        begin: () => {
          started = true;
          void callback()
            .then(
              () => !stolen && resolve(),
              (error) => !stolen && reject(error),
            )
            .finally(() => {
              if (stolen) return;
              queue.shift();
              queue[0]?.begin();
            });
        },
        // The spec: a steal releases the holder at once and rejects its request.
        stolen: () => {
          stolen = true;
          reject(new DOMException("Lock stolen", "AbortError"));
        },
      };
      options.signal?.addEventListener("abort", () => {
        if (started) return;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      });
      if (options.steal) {
        if (queue.length > 0) queue.shift()?.stolen?.();
        queue.unshift(entry);
        queueMicrotask(entry.begin);
        return;
      }
      queue.push(entry);
      if (queue.length === 1) queueMicrotask(entry.begin);
    });
  }
}
class Channel {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];
  /** The peer it was opened on. */
  generation = "";
  constructor(readonly label: string) {
    queueMicrotask(() => {
      if (this.readyState === "connecting") {
        this.readyState = "open";
        this.onopen?.();
      }
    });
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
}
/** How the daemon answers a channel it accepts: by speaking first (a ready or
 *  a hello), by refusing it, or not at all — what a daemon whose channel
 *  acceptor has ended does with every new channel while its root answers. */
type Daemon = (dc: Channel) => void;
const silent: Daemon = () => {};
const speaks: Daemon = (dc) => dc.onmessage?.({ data: '{"type":"hello"}' });
const refuses: Daemon = (dc) => dc.close();
class Root {
  readonly hostId = "host-under-test";
  state: HostControlState = "idle";
  retryCalls = 0;
  daemon: Daemon = silent;
  rootAnswers = true;
  pings = 0;
  rebuilds = 0;
  generation = crypto.randomUUID();
  readonly channels: Channel[] = [];
  readonly listeners = new Set<() => void>();
  closed = false;
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  setState(state: HostControlState) {
    this.state = state;
    for (const fn of this.listeners) fn();
  }
  connect() {
    this.setState("ready");
  }
  close() {
    this.closed = true;
    for (const channel of this.channels) channel.close();
  }
  getState() {
    return this.state;
  }
  getConnectionGeneration() {
    return this.generation;
  }
  getCapabilities() {
    return new Set(["session.transport.v1"]);
  }
  getSignedRtcRefusal() {
    return null;
  }
  getConnectionError() {
    return null;
  }
  getSignalingTrust() {
    return "verified";
  }
  getConnectionInfo() {
    return { kind: "direct", rttMs: 1, protocol: "udp" };
  }
  retryConnection() {
    this.retryCalls++;
    this.setState("connecting");
  }
  createDeviceChannel(label: string) {
    const dc = new Channel(label);
    dc.generation = this.generation;
    this.channels.push(dc);
    setTimeout(() => {
      if (dc.readyState === "open") this.daemon(dc);
    }, 1);
    return dc;
  }
  ping({ timeoutMs = 0 }: { timeoutMs?: number } = {}) {
    this.pings++;
    if (this.rootAnswers) return Promise.resolve({ pong: true });
    return new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs));
  }
  /** A fresh peer on the same client, as `HostControlClient.rebuildPeer`: the
   *  old one's readiness ends at once, the new one is ready a moment later. */
  /** False holds the replacement peer short of ready. */
  readyAfterRebuild = true;
  rebuildPeer() {
    if (this.state !== "ready") return false;
    this.rebuilds++;
    this.generation = crypto.randomUUID();
    this.setState("open");
    if (this.readyAfterRebuild) setTimeout(() => this.setState("ready"), 5);
    return true;
  }
  /** Channels the watch opened itself: consumers in these tests use `spawn.ctl`. */
  probes() {
    return this.channels.filter((dc) => dc.label.startsWith("spawn.host.ctl/"));
  }
}

const originals = new Map<string, PropertyDescriptor | undefined>();
const connections: SharedDaemonConnection[] = [];
const roots: Root[] = [];
const session = "11111111-2222-4333-8444-555555555555";
const label = (kind = "pty") =>
  `spawn.${kind}/${session}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
function connect(
  key = "account:host",
  active = () => true,
  onRetired = () => {},
  timing?: { heartbeatMs: number; ownerSilenceMs: number; watch?: ChannelWatchTiming },
) {
  const connection = new SharedDaemonConnection(
    key,
    () => {
      const root = new Root();
      roots.push(root);
      return root as unknown as HostControlClient;
    },
    active,
    onRetired,
    timing,
  );
  connections.push(connection);
  return connection;
}
async function until(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}
let warn: Mock<typeof console.warn>;
beforeEach(() => {
  const values = new Map<string, string>();
  const replacements = {
    BroadcastChannel: Bus,
    navigator: { locks: new Locks() },
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  };
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  roots.length = 0;
  Bus.messages.length = 0;
  Bus.delayOpens = false;
  Bus.hung.clear();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  jest.useRealTimers();
  for (const connection of connections.splice(0)) connection.close();
  await Bun.sleep(2);
  Bus.instances.clear();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
  warn.mockRestore();
});

test("tabs and terminal views reuse one daemon peer; detaching a view preserves the others", async () => {
  const first = connect(),
    second = connect();
  await until(
    () => first.getSnapshot().state === "ready" && second.getSnapshot().state === "ready",
  );
  expect(roots).toHaveLength(1);
  const a = first.createChannel(label()),
    b = second.createChannel(label());
  await until(() => a.readyState === "open" && b.readyState === "open");
  a.send("first");
  b.send("second");
  await until(() => roots[0].channels.every((dc) => dc.sent.length === 1));
  a.close();
  b.send("still attached");
  await until(() => roots[0].channels[1].sent.length === 2);
  expect(roots[0].closed).toBe(false);
  expect(b.readyState).toBe("open");
  expect(roots[0].channels[0].readyState).toBe("closed");
});

test("reconfirmed trust preserves healthy roots and retries a refused owner only once", async () => {
  const owner = connect(),
    follower = connect();
  await until(() => follower.getSnapshot().state === "ready");
  const channel = follower.createChannel(label());
  await until(() => channel.readyState === "open");
  owner.retry(true);
  follower.retry(true);
  await Bun.sleep(10);
  expect(roots[0].retryCalls).toBe(0);
  expect(channel.readyState).toBe("open");
  channel.send("still attached");
  await until(() => roots[0].channels[0].sent.length === 1);

  roots[0].setState("error");
  await until(() => follower.getSnapshot().state === "error");
  // Several tabs can replay the approval before they receive the recovery
  // snapshot. The owner must arbitrate using its current state.
  follower.retry(true);
  follower.retry(true);
  owner.retry(true);
  await until(() => follower.getSnapshot().state === "connecting");
  await Bun.sleep(10);
  expect(roots[0].retryCalls).toBe(1);
  follower.retry(true);
  await Bun.sleep(10);
  expect(roots[0].retryCalls).toBe(1);

  roots[0].setState("ready");
  await until(() => follower.getSnapshot().state === "ready");
  follower.retry();
  await until(() => roots[0].retryCalls === 2);
  expect(roots[0].state).toBe("connecting");
});

test("owner handover fences old channels and rejects delayed snapshots from the former owner", async () => {
  const first = connect(),
    second = connect();
  await until(() => second.getSnapshot().state === "ready");
  const old = second.createChannel(label());
  await until(() => old.readyState === "open");
  const snapshot = Bus.messages.find(
    (message) => (message as { type: string }).type === "snapshot",
  );
  first.close();
  await until(() => roots.length === 2 && second.getSnapshot().generation === roots[1].generation);
  expect(old.readyState).toBe("closed");
  for (const bus of Bus.instances) bus.onmessage?.({ data: snapshot });
  expect(second.getSnapshot().generation).toBe(roots[1].generation);
  const replacement = second.createChannel(label());
  await until(() => replacement.readyState === "open");
  expect(roots[1].channels[0].sent).toEqual([]);
});

test("connection loss and account retirement discard pending input", async () => {
  let active = true;
  const connection = connect("account:host", () => active);
  await until(() => connection.getSnapshot().state === "ready");
  const channel = connection.createChannel(label());
  await until(() => channel.readyState === "open");
  channel.send("must not replay");
  roots[0].setState("connecting");
  await Bun.sleep(10);
  expect(roots[0].channels[0].sent).toEqual([]);
  roots[0].setState("ready");
  const next = connection.createChannel(label());
  await until(() => next.readyState === "open");
  active = false;
  next.send("wrong account");
  await Bun.sleep(10);
  expect(roots[0].channels[1].sent).toEqual([]);
  expect(() => connection.createChannel(label())).toThrow();
});

test("same-peer readiness loss retires downstream queues in every tab before recovery", async () => {
  const owner = connect(),
    follower = connect();
  await until(() => follower.getSnapshot().state === "ready");
  const channels = [
    owner.createChannel(label()),
    follower.createChannel(label()),
    follower.createChannel(label("ctl")),
    owner.createChannel(`spawn.host.ctl/${crypto.randomUUID()}`),
  ];
  await until(() => channels.every((channel) => channel.readyState === "open"));
  const root = roots[0];
  for (const native of root.channels) native.bufferedAmount = 128 * 1024;
  for (const channel of channels) channel.send("must not replay after network loss");
  // Wait for dispatch across the local bus into the owner's scheduler. An
  // immediate loss only exercises the earlier proxy promise tail.
  await until(
    () =>
      Bus.messages.filter((message) => (message as { type: string }).type === "channel-send")
        .length === channels.length,
  );
  await Bun.sleep(10);
  const staleSends = Bus.messages.filter(
    (message) => (message as { type: string }).type === "channel-send",
  );
  root.setState("connecting");
  expect(root.channels.every((native) => native.readyState === "closed")).toBe(true);
  root.setState("ready");
  await until(() => channels.every((channel) => channel.readyState === "closed"));
  expect(channels.every((channel) => channel.bufferedAmount === 0)).toBe(true);
  for (const native of root.channels) native.bufferedAmount = 0;
  for (const bus of Bus.instances)
    for (const message of staleSends) bus.onmessage?.({ data: message });
  await Bun.sleep(10);
  expect(root.channels.every((native) => native.sent.length === 0)).toBe(true);
  expect(roots).toHaveLength(1);
  expect(root.closed).toBe(false);
  expect(follower.getSnapshot().generation).toBe(root.generation);
  const fresh = follower.createChannel(label());
  await until(() => fresh.readyState === "open");
  fresh.send("new input");
  await until(() => root.channels.at(-1)!.sent.length === 1);
  expect(root.channels.at(-1)!.sent).toEqual(["new input"]);
});

test("same-peer recovery rejects follower opens delayed past their readiness epoch", async () => {
  connect();
  const follower = connect();
  await until(() => follower.getSnapshot().state === "ready");
  Bus.delayOpens = true;
  const pending = follower.createChannel(label());
  await until(() =>
    Bus.messages.some((message) => (message as { type: string }).type === "channel-open"),
  );
  const staleOpen = Bus.messages.find(
    (message) => (message as { type: string }).type === "channel-open",
  );
  expect(roots[0].channels).toHaveLength(0);
  roots[0].setState("connecting");
  roots[0].setState("ready");
  await until(() => pending.readyState === "closed");
  Bus.delayOpens = false;
  for (const bus of Bus.instances) bus.onmessage?.({ data: staleOpen });
  await Bun.sleep(10);
  expect(roots[0].channels).toHaveLength(0);
  const fresh = follower.createChannel(label());
  await until(() => fresh.readyState === "open");
  expect(roots).toHaveLength(1);
  expect(roots[0].channels).toHaveLength(1);
});

test("a retirement callback can attach to the published successor without its new channel being retired", async () => {
  const owner = connect();
  await until(() => owner.getSnapshot().state === "ready");
  const old = owner.createChannel(label());
  await until(() => old.readyState === "open");
  let replacement: ReturnType<typeof owner.createChannel> | null = null;
  old.onclose = () => {
    replacement = owner.createChannel(label());
  };
  roots[0].generation = crypto.randomUUID();
  roots[0].setState("ready");
  await until(() => replacement?.readyState === "open");
  expect(old.readyState).toBe("closed");
  expect(roots[0].channels.at(-1)!.readyState).toBe("open");
});

test("separate daemons and accounts do not share a peer", async () => {
  connect("a:host1");
  connect("a:host2");
  connect("b:host1");
  await until(() => roots.length === 3);
});

test("a stalled bulk channel does not block terminal input; queues and empty messages are bounded", async () => {
  const scheduler = new DaemonSendScheduler();
  const bulk = new Channel("spawn.ctl/test"),
    input = new Channel("spawn.pty/test");
  await Bun.sleep(2);
  bulk.bufferedAmount = 128 * 1024;
  scheduler.enqueue(bulk as unknown as RTCDataChannel, new ArrayBuffer(48 * 1024), () => {});
  scheduler.enqueue(input as unknown as RTCDataChannel, "key", () => {});
  await until(() => input.sent.length === 1);
  expect(bulk.sent).toHaveLength(0);
  scheduler.close();
  const proxy = new RemoteDaemonChannel("test", () => {});
  proxy.opened();
  for (let n = 0; n < 1024; n++) proxy.send("");
  expect(() => proxy.send("")).toThrow();
  proxy.close();
  expect(proxy.bufferedAmount).toBe(0);
});

test("freezing an owner relinquishes its peer and resume can rejoin", async () => {
  const first = connect();
  await until(() => first.getSnapshot().state === "ready");
  document.dispatchEvent(new Event("freeze"));
  expect(roots[0].closed).toBe(true);
  document.dispatchEvent(new Event("resume"));
  await until(() => roots.length === 2 && first.getSnapshot().generation === roots[1].generation);
});

test("unavailable cross-tab coordination produces an explicit error without opening a peer", () => {
  Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
  const connection = connect();
  expect(connection.getSnapshot().state).toBe("error");
  expect(connection.getSnapshot().error).toContain("Update your browser");
  expect(roots).toHaveLength(0);
});

const FAST = { heartbeatMs: 20, ownerSilenceMs: 150 };

test("a visible follower takes the lock from a silent owner, which stands down and follows", async () => {
  const owner = connect(
    "account:host",
    () => true,
    () => {},
    FAST,
  );
  const ownerBus = [...Bus.instances].at(-1)!;
  const follower = connect(
    "account:host",
    () => true,
    () => {},
    FAST,
  );
  await until(() => follower.getSnapshot().state === "ready");
  expect(roots).toHaveLength(1);

  Bus.hung.add(ownerBus);
  await until(
    () => roots.length === 2 && follower.getSnapshot().generation === roots[1].generation,
  );
  // The stolen owner's request rejected: its peer is gone, not left competing.
  await until(() => roots[0].closed);

  Bus.hung.delete(ownerBus);
  await until(() => owner.getSnapshot().generation === roots[1].generation);
  const channel = owner.createChannel(label());
  await until(() => channel.readyState === "open");
  expect(roots).toHaveLength(2);
});

test("a follower that hears its owner never takes the lock", async () => {
  connect(
    "account:host",
    () => true,
    () => {},
    FAST,
  );
  const follower = connect(
    "account:host",
    () => true,
    () => {},
    FAST,
  );
  await until(() => follower.getSnapshot().state === "ready");
  await Bun.sleep(FAST.ownerSilenceMs * 3);
  expect(roots).toHaveLength(1);
  expect(roots[0].closed).toBe(false);
});

test("a hidden follower waits for a silent owner rather than taking its lock", async () => {
  const owner = connect(
    "account:host",
    () => true,
    () => {},
    FAST,
  );
  void owner;
  const ownerBus = [...Bus.instances].at(-1)!;
  connect(
    "account:host",
    () => true,
    () => {},
    FAST,
  );
  await until(() => roots[0]?.state === "ready");
  Object.assign(globalThis.document, { visibilityState: "hidden" });
  Bus.hung.add(ownerBus);
  await Bun.sleep(FAST.ownerSilenceMs * 3);
  expect(roots).toHaveLength(1);
});

test("a connection that retires itself says so, so its provider can rebuild it", async () => {
  let active = true;
  let retired = 0;
  const connection = connect(
    "account:host",
    () => active,
    () => retired++,
    FAST,
  );
  await until(() => connection.getSnapshot().state === "ready");
  active = false;
  await until(() => connection.isClosed());
  expect(retired).toBe(1);
  expect(connection.getSnapshot().state).toBe("closed");
});

// The channel watch at the owner, on fake timers and the production timings.
const T = CHANNEL_WATCH_TIMING;
/** From a channel's open to the rebuild, when the root still answers. */
const WEDGE_TO_REBUILD = T.unansweredMs + 2 * T.probeMs;

/** Move the fake clock, letting the tabs' promise and microtask hops run. */
async function advance(ms: number, step = 50) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    jest.advanceTimersByTime(Math.min(step, end - performance.now()));
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  }
}
async function within(predicate: () => boolean, maxMs = 60_000) {
  const end = performance.now() + maxMs;
  while (!predicate() && performance.now() < end) await advance(10, 10);
  expect(predicate()).toBe(true);
}
function heardOn(channel: ReturnType<SharedDaemonConnection["createChannel"]>) {
  const heard: unknown[] = [];
  channel.onmessage = ({ data }) => heard.push(data);
  return heard;
}
async function readyPair() {
  jest.useFakeTimers();
  const owner = connect();
  const follower = connect();
  await within(() => follower.getSnapshot().state === "ready", 1_000);
  return { owner, follower, root: roots[0] };
}

test("a peer that stops opening channels is rebuilt once, and its views open again on the new one", async () => {
  const { follower, root } = await readyPair();
  const seen: DaemonSnapshot[] = [];
  follower.subscribe(() => seen.push(follower.getSnapshot()));
  root.daemon = speaks;
  const live = follower.createChannel(label("ctl"));
  const liveHeard = heardOn(live);
  await within(() => liveHeard.length === 1, 1_000);
  const before = follower.getSnapshot().generation;
  const firstPeer = root.channels[0].generation;

  // The daemon stops accepting channels. The peer and its root carry on.
  root.daemon = silent;
  const opened = performance.now();
  const stuck = follower.createChannel(label("ctl"));
  await within(() => root.rebuilds === 1);
  expect(performance.now() - opened).toBeGreaterThanOrEqual(WEDGE_TO_REBUILD);
  expect(root.probes()).toHaveLength(2);
  expect(root.pings).toBe(1);
  await within(
    () => follower.getSnapshot().state === "ready" && follower.getSnapshot().generation !== before,
  );
  // Every view on the old peer was retired with it ...
  expect(live.readyState).toBe("closed");
  expect(stuck.readyState).toBe("closed");
  // ... and the tabs were told why while it was replaced, and no longer.
  expect(seen.some((snapshot) => snapshot.rebuilding && snapshot.state !== "ready")).toBe(true);
  expect(follower.getSnapshot().rebuilding).toBeUndefined();

  // A fresh peer accepts: a view reopens on it like any reconnect.
  root.daemon = speaks;
  const reopened = follower.createChannel(label("ctl"));
  const reopenedHeard = heardOn(reopened);
  await within(() => reopenedHeard.length === 1, 1_000);
  expect(root.channels.at(-1)?.generation).toBe(root.generation);
  expect(root.channels.at(-1)?.generation).not.toBe(firstPeer);

  await advance(10 * 60_000, 500);
  expect(root.rebuilds).toBe(1);
  expect(roots).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain(`host ${root.hostId}`);
});

test("a refused channel is an answer: refusals never probe or rebuild", async () => {
  const { follower, root } = await readyPair();
  root.daemon = refuses;
  for (let attempt = 0; attempt < 4; attempt++) {
    const refused = follower.createChannel(label("ctl"));
    await within(() => refused.readyState === "closed", 1_000);
    await advance(T.unansweredMs / 2);
  }
  await advance(2 * WEDGE_TO_REBUILD);
  expect(root.probes()).toHaveLength(0);
  expect(root.pings).toBe(0);
  expect(root.rebuilds).toBe(0);
  expect(warn).not.toHaveBeenCalled();
});

test("a slow session on a working peer is probed, not rebuilt", async () => {
  const { follower, root } = await readyPair();
  // The session's channel waits on its worker; anything else is accepted.
  root.daemon = (dc) => {
    if (dc.label.startsWith("spawn.host.ctl/")) speaks(dc);
  };
  const slow = follower.createChannel(label("ctl"));
  await within(() => root.probes().length === 1);
  await within(() => root.probes()[0].readyState === "closed", 1_000);
  await advance(2 * WEDGE_TO_REBUILD);
  expect(root.rebuilds).toBe(0);
  expect(root.pings).toBe(0);
  expect(slow.readyState).toBe("open");
});

test("a probe's hello slower than the root's pong leaves a working peer alone", async () => {
  const { follower, root } = await readyPair();
  // The root answers at once; the first probe's hello comes five seconds
  // after the second probe opens (a busy admission lock, a slow home mount).
  root.daemon = (dc) => {
    if (dc.label.startsWith("spawn.host.ctl/") && root.probes()[0] === dc)
      setTimeout(() => speaks(dc), T.probeMs + 5_000);
  };
  follower.createChannel(label("ctl"));
  await within(() => root.pings === 1);
  await advance(2 * WEDGE_TO_REBUILD);
  expect(root.probes()).toHaveLength(2);
  expect(root.rebuilds).toBe(0);
  expect(warn).not.toHaveBeenCalled();
});

test("a peer whose root falls silent with its channels is replaced after two silent pings", async () => {
  // An old daemon's association stops acknowledging anything once channels
  // pile up behind its dead acceptor: the root goes quiet with them.
  const { follower, root } = await readyPair();
  root.rootAnswers = false;
  const opened = performance.now();
  follower.createChannel(label("ctl"));
  await within(() => root.pings === 2);
  expect(root.rebuilds).toBe(0);
  await within(() => root.rebuilds === 1);
  expect(performance.now() - opened).toBeGreaterThanOrEqual(
    T.unansweredMs + T.probeMs + 2 * T.rootSilenceMs,
  );
  expect(root.probes().every((probe) => probe.readyState === "closed")).toBe(true);
  expect(String(warn.mock.calls[0]?.[0])).toContain("did not answer two pings");
});

test("two tabs waiting on one dead peer rebuild it once", async () => {
  const { owner, follower, root } = await readyPair();
  for (let view = 0; view < 3; view++) {
    owner.createChannel(label("ctl"));
    follower.createChannel(label("ctl"));
  }
  await within(() => root.rebuilds === 1);
  await advance(2 * WEDGE_TO_REBUILD);
  expect(root.probes()).toHaveLength(2);
  expect(root.rebuilds).toBe(1);
  expect(roots).toHaveLength(1);
});

test("an owner tab closed mid-rebuild hands over a fresh connection, not a stuck notice", async () => {
  const { owner, follower, root } = await readyPair();
  root.readyAfterRebuild = false;
  follower.createChannel(label("ctl"));
  await within(() => root.rebuilds === 1);
  await within(() => follower.getSnapshot().rebuilding === true, 1_000);
  owner.close();
  await within(() => roots.length === 2 && follower.getSnapshot().state === "ready");
  expect(root.closed).toBe(true);
  expect(follower.getSnapshot().generation).toBe(roots[1].generation);
  expect(follower.getSnapshot().rebuilding).toBeUndefined();
  roots[1].daemon = speaks;
  const reopened = follower.createChannel(label("ctl"));
  const heard = heardOn(reopened);
  await within(() => heard.length === 1, 1_000);
  await advance(2 * WEDGE_TO_REBUILD);
  expect(roots[1].rebuilds).toBe(0);
});

test("a reattach burst bigger than an old daemon's accept queue is slow, not a wedge", async () => {
  const { follower, root } = await readyPair();
  follower.createChannel(label("ctl"));
  await within(() => root.rebuilds === 1);
  await within(() => follower.getSnapshot().state === "ready");
  // The replacement's acceptor is alive, but the old SCTP queues only sixteen
  // streams; the rest wait for a retransmission once it drains, here longer
  // than a channel's ten seconds.
  let accepted = 0;
  root.daemon = (dc) => {
    if (dc.label.startsWith("spawn.host.ctl/") || ++accepted % 20 <= 16) speaks(dc);
    else setTimeout(() => speaks(dc), T.unansweredMs + 2_000);
  };
  const burst = () =>
    Array.from({ length: 20 }, () => heardOn(follower.createChannel(label("ctl"))));
  // Right after the rebuild the backoff holds any suspicion ...
  const reattached = burst();
  await within(() => reattached.every((heard) => heard.length === 1));
  expect(root.probes()).toHaveLength(2);
  // ... and once it has passed, the probes find the acceptor alive.
  await advance(T.rebuildBackoffMs);
  const later = burst();
  await within(() => later.every((heard) => heard.length === 1));
  await advance(2 * WEDGE_TO_REBUILD);
  expect(root.probes().length).toBeGreaterThanOrEqual(3);
  expect(root.probes().every((probe) => probe.readyState === "closed")).toBe(true);
  expect(root.rebuilds).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
});

test("a view given up on after the abandon threshold raises suspicion; one closed sooner does not", async () => {
  const { follower, root } = await readyPair();
  const early = follower.createChannel(label("ctl"));
  await within(() => root.channels.length === 1, 1_000);
  await advance(T.abandonedAfterMs - 1_000);
  early.close();
  await advance(2 * T.unansweredMs);
  expect(root.probes()).toHaveLength(0);

  const late = follower.createChannel(label("ctl"));
  await within(() => root.channels.length === 2, 1_000);
  await advance(T.abandonedAfterMs);
  late.close();
  await within(() => root.probes().length === 1, 1_000);
});
