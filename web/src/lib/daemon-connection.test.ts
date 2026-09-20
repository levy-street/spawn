import { afterEach, beforeEach, expect, test } from "bun:test";
import { DaemonSendScheduler, RemoteDaemonChannel } from "./daemon-channel";
import { SharedDaemonConnection } from "./daemon-connection";
import type { HostControlClient, HostControlState } from "./hostControl";

class Bus {
  static instances = new Set<Bus>();
  static messages: unknown[] = [];
  static delayOpens = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    Bus.instances.add(this);
  }
  postMessage(data: unknown) {
    Bus.messages.push(structuredClone(data));
    if (Bus.delayOpens && (data as { type: string }).type === "channel-open") return;
    for (const bus of Bus.instances)
      if (bus !== this && bus.name === this.name)
        queueMicrotask(() => {
          if (Bus.instances.has(bus)) bus.onmessage?.({ data: structuredClone(data) });
        });
  }
  close() {
    Bus.instances.delete(this);
  }
}
class Locks {
  queues = new Map<string, Array<() => void>>();
  request(name: string, options: { signal: AbortSignal }, callback: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      let started = false;
      const begin = () => {
        started = true;
        void callback()
          .then(resolve, reject)
          .finally(() => {
            queue.shift();
            queue[0]?.();
          });
      };
      options.signal.addEventListener("abort", () => {
        if (started) return;
        const index = queue.indexOf(begin);
        if (index >= 0) queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      });
      queue.push(begin);
      if (queue.length === 1) queueMicrotask(begin);
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
class Root {
  state: HostControlState = "idle";
  retryCalls = 0;
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
    this.channels.push(dc);
    return dc;
  }
}

const originals = new Map<string, PropertyDescriptor | undefined>();
const connections: SharedDaemonConnection[] = [];
const roots: Root[] = [];
const session = "11111111-2222-4333-8444-555555555555";
const label = (kind = "pty") =>
  `spawn.${kind}/${session}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
function connect(key = "account:host", active = () => true) {
  const connection = new SharedDaemonConnection(
    key,
    () => {
      const root = new Root();
      roots.push(root);
      return root as unknown as HostControlClient;
    },
    active,
  );
  connections.push(connection);
  return connection;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}
beforeEach(() => {
  const values = new Map<string, string>();
  const replacements = {
    BroadcastChannel: Bus,
    navigator: { locks: new Locks() },
    window: new EventTarget(),
    document: new EventTarget(),
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
});
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  await Bun.sleep(2);
  Bus.instances.clear();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
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
