import { afterEach, beforeEach, expect, jest, type Mock, spyOn, test } from "bun:test";
import { CHANNEL_WATCH_TIMING, type ChannelWatchTiming } from "./channel-watch";
import { DaemonSendScheduler, RemoteDaemonChannel } from "./daemon-channel";
import {
  type DaemonSnapshot,
  SharedDaemonConnection,
  STUCK_LEAD_MS,
  stuckBound,
} from "./daemon-connection";
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
    options: { signal?: AbortSignal; steal?: boolean; ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => Promise<void>,
  ) {
    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      if (options.ifAvailable && queue.length > 0) {
        void callback(null).then(() => resolve(), reject);
        return;
      }
      let started = false;
      let stolen = false;
      const entry = {
        begin: () => {
          started = true;
          void callback({ name })
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
  /** Where a new peer's link gets to; "open" is signalling with no working peer. */
  static reaches: HostControlState = "ready";
  readonly hostId = "host-under-test";
  readonly createdAt = Date.now();
  state: HostControlState = "idle";
  error: string | null = null;
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
    this.setState(Root.reaches);
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
    return this.error;
  }
  /** When the daemon last refused an offer (`HostControlClient.getOfferFailedAt`). */
  failedAt = 0;
  getOfferFailedAt() {
    return this.failedAt;
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
  hostOnlineAt?: () => number,
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
    hostOnlineAt,
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
      removeItem: (key: string) => values.delete(key),
    },
  };
  Root.reaches = "ready";
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

// A link that never becomes usable, under an owner that keeps announcing it.
/** The server's word, fresh at every read, that the host is online. */
const online = () => Date.now();
/** A tab with no such word: the host is offline, or the tab's list is not polled. */
const unheard = () => 0;
function tab(hostOnlineAt: () => number = online) {
  return connect("account:host", undefined, undefined, undefined, hostOnlineAt);
}

type Said = {
  type: string;
  from: string;
  owner?: string;
  term?: number;
  epoch?: number;
  snapshot?: DaemonSnapshot;
};
/** The last snapshot announced for a given peer, by whichever tab. */
function announcedFor(root: Root) {
  return (Bus.messages as Said[]).findLast(
    (message) => message.type === "snapshot" && message.snapshot?.generation === root.generation,
  );
}

/**
 * FIXTURE, not product code: the parts of `SharedDaemonConnection` at
 * 23e30e46 that decide who leads, copied as they were with the channel
 * proxying left out (its link never becomes ready, so it opens none). That is
 * the page code from before #101, still running in tabs left open since. What
 * matters about it here: it never takes a lock; when its own is taken, the
 * rejected request only publishes an error, and the tab keeps its peer and
 * its name; it answers every hello with its snapshot; and it copies any newer
 * term it hears while still announcing its old name, `<tab>:<old term>`.
 */
type Pre101Wire = Omit<Said, "from"> & { v: 1; from: string; to?: string };
class Pre101Tab {
  private snapshot: DaemonSnapshot = {
    state: "idle",
    generation: null,
    capabilities: [],
    refusal: null,
    trust: null,
  };
  readonly tab = crypto.randomUUID();
  private readonly bus: BroadcastChannel | null;
  private root: HostControlClient | null = null;
  private owner: string | null = null;
  private leader: string | null = null;
  private term = 0;
  private epoch = 0;
  private ownerSeen = 0;
  private lockAbort: AbortController | null = null;
  private releaseLock: (() => void) | null = null;
  private stopRoot: (() => void) | null = null;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly key: string,
    private readonly createRoot: () => HostControlClient,
  ) {
    try {
      this.bus = new BroadcastChannel(`spawn.daemon.v2:${key}`);
      this.bus.onmessage = ({ data }) => this.receive(data);
    } catch {
      this.bus = null;
    }
    this.heartbeat = setInterval(() => {
      if (!this.root && this.ownerSeen && Date.now() - this.ownerSeen > 6_000) {
        this.publish({ ...this.snapshot, state: "connecting", generation: null });
      }
      this.post({ type: "heartbeat" });
      if (this.root) this.announce();
    }, 2_000);
    this.post({ type: "hello" });
    this.elect();
  }

  getSnapshot = (): DaemonSnapshot => this.snapshot;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.post({ type: "depart" });
    this.relinquish();
    clearInterval(this.heartbeat);
    this.bus?.close();
  }

  private elect(): void {
    if (this.closed || this.lockAbort) return;
    const abort = new AbortController();
    this.lockAbort = abort;
    void navigator.locks
      .request(`spawn.daemon.v2:${this.key}`, { signal: abort.signal }, async () => {
        if (this.closed || abort.signal.aborted) return;
        const termKey = `spawn.daemon.term:${this.key}`;
        const saved = Number(localStorage.getItem(termKey)) || 0;
        this.term = Math.max(Date.now(), saved + 1, this.term + 1);
        localStorage.setItem(termKey, String(this.term));
        this.leader = `${this.tab}:${this.term}`;
        this.epoch = 0;
        this.owner = null;
        this.root = this.createRoot();
        this.stopRoot = this.root.subscribe(() => this.announce());
        this.root.connect();
        await new Promise<void>((resolve) => {
          this.releaseLock = resolve;
        });
      })
      .catch(() => {
        if (!abort.signal.aborted && !this.closed)
          this.publish({
            ...this.snapshot,
            state: "error",
            error: "SPAWN D could not coordinate this browser's daemon connection.",
          });
      })
      .finally(() => {
        if (this.lockAbort === abort) this.lockAbort = null;
      });
  }

  private relinquish(): void {
    if (this.leader)
      this.post({
        type: "snapshot",
        owner: this.leader,
        term: this.term,
        snapshot: { ...this.snapshot, state: "connecting" },
      });
    this.stopRoot?.();
    this.stopRoot = null;
    this.root?.close();
    this.root = null;
    this.leader = null;
    this.releaseLock?.();
    this.releaseLock = null;
    this.lockAbort?.abort();
    this.lockAbort = null;
  }

  private announce(): void {
    const root = this.root;
    if (!root || !this.leader) return;
    if (
      this.snapshot.generation !== root.getConnectionGeneration() ||
      (this.snapshot.state === "ready" && root.getState() !== "ready")
    )
      this.epoch++;
    this.post({
      type: "snapshot",
      owner: this.leader,
      term: this.term,
      snapshot: {
        state: root.getState(),
        generation: root.getConnectionGeneration(),
        capabilities: [...root.getCapabilities()],
        refusal: root.getSignedRtcRefusal(),
        trust: root.getSignalingTrust(),
        info: root.getConnectionInfo(),
        error: root.getConnectionError(),
      },
    });
  }

  private publish(snapshot: DaemonSnapshot): void {
    this.snapshot = snapshot;
  }

  private post(message: Omit<Pre101Wire, "v" | "from">): void {
    const wire: Pre101Wire = { v: 1, from: this.tab, epoch: this.epoch, ...message };
    this.bus?.postMessage(wire);
    this.receive(wire);
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Pre101Wire;
    if (message.v !== 1 || typeof message.from !== "string" || typeof message.type !== "string")
      return;
    if (message.to && message.to !== this.tab) return;
    if (message.type === "snapshot" && message.owner && message.snapshot) {
      if (!Number.isSafeInteger(message.term) || (message.term ?? 0) < this.term) return;
      if (!Number.isSafeInteger(message.epoch) || (message.epoch ?? -1) < 0) return;
      if (message.term === this.term && this.owner && this.owner !== message.owner) return;
      if (message.term === this.term && (message.epoch ?? 0) < this.epoch) return;
      this.term = message.term ?? 0;
      this.ownerSeen = Date.now();
      this.owner = message.owner;
      this.epoch = message.epoch ?? 0;
      this.publish(message.snapshot);
      return;
    }
    if (!this.root || !this.leader) return;
    if (message.type === "hello") this.announce();
  }
}
const pre101Tabs: Pre101Tab[] = [];
function pre101Tab() {
  const old = new Pre101Tab("account:host", () => {
    const root = new Root();
    roots.push(root);
    return root as unknown as HostControlClient;
  });
  pre101Tabs.push(old);
  return old;
}
afterEach(() => {
  for (const old of pre101Tabs.splice(0)) old.close();
});

test("a waiting tab takes the lead from an owner on page code from before #101; what that tab still says is ignored, by tabs opened later too", async () => {
  jest.useFakeTimers();
  Root.reaches = "open";
  const old = pre101Tab();
  await within(() => roots.length === 1, 1_000);
  Root.reaches = "ready";
  const first = tab();
  const second = tab();
  await within(
    () => first.getSnapshot().state === "open" && second.getSnapshot().state === "open",
    3_000,
  );
  await advance(STUCK_LEAD_MS - 2_000, 500);
  expect(roots).toHaveLength(1);
  await within(() => roots.length === 2, 5_000);
  const healthy = roots[1];
  await within(
    () => first.getSnapshot().state === "ready" && second.getSnapshot().state === "ready",
    1_000,
  );

  // Deposed, the old tab keeps its peer and follows the new owner for its own
  // views; having copied that owner's term, it announces its own old name
  // under it.
  expect(roots[0].closed).toBe(false);
  expect(old.getSnapshot().generation).toBe(healthy.generation);
  await advance(4_000, 500);
  const owner = announcedFor(healthy);
  const zombie = (Bus.messages as Said[]).findLast(
    (message) => message.type === "snapshot" && message.from === old.tab,
  );
  expect(zombie?.term).toBe(owner?.term);
  expect(zombie?.owner).not.toBe(owner?.owner);

  // A tab that opens now (a new tab, a reload, a rebuilt connection) has
  // followed no one: it hears the old tab answer its hello too, and must
  // still follow the healthy owner.
  const fresh = tab();
  await within(() => fresh.getSnapshot().state === "ready", 3_000);
  expect(fresh.getSnapshot().generation).toBe(healthy.generation);
  const view = fresh.createChannel(label());
  await within(() => view.readyState === "open", 1_000);
  view.send("typed");
  await within(() => healthy.channels[0]?.sent.length === 1, 1_000);

  // However long the old tab goes on, nobody takes a ready link over.
  await advance(10 * 60_000, 500);
  expect(roots).toHaveLength(2);
  expect(healthy.closed).toBe(false);
  for (const each of [first, second, fresh])
    expect(each.getSnapshot().generation).toBe(healthy.generation);
});

test("an owner whose link never comes up starts a new one itself, keeping the lead; the next wait doubles", async () => {
  jest.useFakeTimers();
  Root.reaches = "open";
  const owner = tab();
  await within(() => roots.length === 1, 1_000);
  // A waiting tab with no word from the server of its own (a hidden tab's host
  // list is not polled): here only the owner can judge its own link.
  const waiting = tab(unheard);
  await within(() => waiting.getSnapshot().state === "open", 1_000);
  const before = announcedFor(roots[0]);
  await advance(STUCK_LEAD_MS - 2_000, 500);
  expect(roots).toHaveLength(1);
  await within(() => roots.length === 2, 5_000);
  expect(roots[0].closed).toBe(true);
  // The same tab leads under the same term, past the old connection's epoch;
  // the lock never moved, so the waiting tab is still waiting.
  await within(() => waiting.getSnapshot().generation === roots[1].generation, 1_000);
  const after = announcedFor(roots[1]);
  expect(after?.owner).toBe(before?.owner);
  expect(after?.term).toBe(before?.term);
  expect(after?.epoch).toBeGreaterThan(before?.epoch ?? 0);
  expect(owner.getSnapshot().generation).toBe(roots[1].generation);

  await advance(stuckBound(1) - 3_000, 500);
  expect(roots).toHaveLength(2);
  await within(() => roots.length === 3, 6_000);
  expect(roots[2].createdAt - roots[1].createdAt).toBeGreaterThanOrEqual(stuckBound(1));
});

test("a lone tab whose link never comes up starts it afresh, at a falling rate", async () => {
  jest.useFakeTimers();
  Root.reaches = "open";
  const only = tab();
  await within(() => roots.length === 1, 1_000);
  await within(() => roots.length === 2, STUCK_LEAD_MS + 5_000);
  expect(roots[0].closed).toBe(true);
  await within(() => only.getSnapshot().generation === roots[1].generation, 1_000);
  await advance(stuckBound(1) - 3_000, 500);
  expect(roots).toHaveLength(2);
});

test("no tab takes over while the host is offline, the server's word is old, or nobody is looking", async () => {
  jest.useFakeTimers();
  Root.reaches = "open";
  const start = Date.now();
  let word: () => number = unheard;
  tab(() => word());
  tab(() => word());
  await advance(20 * 60_000, 500);
  expect(roots).toHaveLength(1);
  // Online, but said before the link was lost: what a list that stopped
  // refreshing leaves behind, a network down for everyone among them.
  word = () => start - 1;
  await advance(20 * 60_000, 500);
  expect(roots).toHaveLength(1);
  // Fresh word, but both tabs are hidden.
  word = online;
  Object.assign(globalThis.document, { visibilityState: "hidden" });
  await advance(20 * 60_000, 500);
  expect(roots).toHaveLength(1);
  // Someone looks: the link has been stuck all along, so the attempt comes at once.
  Object.assign(globalThis.document, { visibilityState: "visible" });
  await within(() => roots.length === 2, 5_000);
});

test("a ready owner keeps the lead, and so do one slow within the bound and one with a verdict to show", async () => {
  jest.useFakeTimers();
  tab();
  const waiting = tab();
  await within(() => waiting.getSnapshot().state === "ready", 1_000);
  await advance(10 * 60_000, 500);
  expect(roots).toHaveLength(1);
  // The link drops and comes back just inside the bound.
  roots[0].setState("connecting");
  await advance(STUCK_LEAD_MS - 3_000, 500);
  roots[0].setState("ready");
  await advance(10 * 60_000, 500);
  expect(roots).toHaveLength(1);
  // Retrying with an error to show (here, an unreadable device key): another
  // tab would read the same store.
  roots[0].error = "SPAWN D could not load this browser's device key. Retrying…";
  roots[0].setState("connecting");
  await advance(10 * 60_000, 500);
  expect(roots).toHaveLength(1);
  // Past the bound with nothing to wait on, the waiting tab gets its attempt.
  roots[0].error = null;
  roots[0].setState("open");
  const lost = performance.now();
  await within(() => roots.length === 2, STUCK_LEAD_MS + 5_000);
  expect(performance.now() - lost).toBeGreaterThanOrEqual(STUCK_LEAD_MS);
});

test("two tabs on a link that never comes up pass the lead at a falling rate, never straight back", async () => {
  jest.useFakeTimers();
  Root.reaches = "open";
  tab();
  tab();
  await advance(32 * 60_000, 500);
  const gaps = roots.slice(1).map((root, n) => root.createdAt - roots[n].createdAt);
  expect(gaps.length).toBeGreaterThanOrEqual(5);
  expect(gaps.length).toBeLessThanOrEqual(7);
  for (const [n, gap] of gaps.entries()) expect(gap).toBeGreaterThanOrEqual(stuckBound(n));
  expect(roots.slice(0, -1).every((root) => root.closed)).toBe(true);
  // A link that works ends the row, and a working link is left alone.
  const count = roots.length;
  roots[count - 1].setState("ready");
  await advance(30 * 60_000, 500);
  expect(roots).toHaveLength(count);
  expect(localStorage.getItem("spawn.daemon.takeover:account:host")).toBeNull();
});

test("a machine that slept does not count its sleep against the owner's link", async () => {
  jest.useFakeTimers();
  tab();
  const waiting = tab();
  await within(() => waiting.getSnapshot().state === "ready", 1_000);
  // The link drops as the lid closes; for an hour no timer runs.
  roots[0].setState("open");
  jest.setSystemTime(Date.now() + 3_600_000);
  await advance(STUCK_LEAD_MS - 3_000, 500);
  expect(roots).toHaveLength(1);
  await within(() => roots.length === 2, 6_000);
});

test("a row of take-overs from an earlier episode does not hold up a new one", async () => {
  jest.useFakeTimers();
  // Five in a row, the last 25 minutes ago, never ended by a ready link: the
  // ten-minute wait it would ask for belongs to another episode.
  localStorage.setItem("spawn.daemon.takeover:account:host", `5:${Date.now() - 25 * 60_000}`);
  Root.reaches = "open";
  tab();
  tab();
  await within(() => roots.length === 1, 1_000);
  await within(() => roots.length === 2, STUCK_LEAD_MS + 5_000);
  expect(localStorage.getItem("spawn.daemon.takeover:account:host")).toStartWith("1:");
});

test("with local storage unusable a tab still leads, and backs off on its own", async () => {
  jest.useFakeTimers();
  const refuse = () => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: refuse, setItem: refuse, removeItem: refuse },
    configurable: true,
  });
  Root.reaches = "open";
  const only = tab();
  await within(() => roots.length === 1, 1_000);
  await within(() => only.getSnapshot().state === "open", 1_000);
  await advance(5_000, 500);
  expect(roots).toHaveLength(1);
  await within(() => roots.length === 2, STUCK_LEAD_MS + 5_000);
  await advance(stuckBound(1) - 3_000, 500);
  expect(roots).toHaveLength(2);
});

test("a tab that fails while holding the lock asks again on its next heartbeat, not in a spin", async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const connection = new SharedDaemonConnection("account:host", () => {
    attempts++;
    if (attempts <= 3) throw new Error("no client today");
    const root = new Root();
    roots.push(root);
    return root as unknown as HostControlClient;
  });
  connections.push(connection);
  await advance(1_000, 10);
  expect(attempts).toBe(1);
  await within(() => connection.getSnapshot().state === "ready", 10_000);
  expect(attempts).toBe(4);
  expect(roots).toHaveLength(1);
});

test("a link whose offers the host keeps refusing is not taken over; one gone quiet is", async () => {
  jest.useFakeTimers();
  Root.reaches = "open";
  tab();
  tab();
  await within(() => roots.length === 1, 1_000);
  // The daemon answers every offer `failed`, as it does a device it has not
  // approved; the owner retries each time.
  const refusing = setInterval(() => {
    roots[0].failedAt = Date.now();
    roots[0].setState("connecting");
    roots[0].setState("open");
  }, 2_000);
  await advance(10 * 60_000, 500);
  expect(roots).toHaveLength(1);
  clearInterval(refusing);
  const quiet = performance.now();
  await within(() => roots.length === 2, 60_000);
  expect(performance.now() - quiet).toBeGreaterThanOrEqual(STUCK_LEAD_MS);
});
