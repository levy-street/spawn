import { afterEach, beforeEach, expect, jest, type Mock, spyOn, test } from "bun:test";
import {
  CHANNEL_WATCH_TIMING,
  ChannelOpenWatch,
  REBUILDING_MESSAGE,
  type WatchedPeer,
} from "./channel-watch";

// Every test runs on fake timers with the production timings: what is
// asserted is exactly what a person's browser would do, without wall-clock
// sleeps that a loaded runner could stretch.
const T = CHANNEL_WATCH_TIMING;
const SUSPECT = T.unansweredMs;
const PROOF = 2 * T.probeMs;

class Probe {
  closed = false;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly label: string) {}
  close() {
    this.closed = true;
  }
}

class Peer implements WatchedPeer {
  probes: Probe[] = [];
  pings = 0;
  /** How the root answers a ping: at once, after a delay, never, or not sent at all. */
  root: "answers" | "silent" | "fails" | number = "answers";
  /** After how long the n-th probe hears a hello; null, never. */
  hello: (index: number) => number | null = () => null;
  rebuiltAt: number[] = [];
  onRebuild: () => void = () => {};
  openProbe(label: string) {
    const probe = new Probe(label);
    const delay = this.hello(this.probes.length);
    this.probes.push(probe);
    if (delay !== null) setTimeout(() => probe.onmessage?.(), delay);
    return probe as unknown as RTCDataChannel;
  }
  ping(timeoutMs: number) {
    this.pings++;
    const root = this.root;
    if (root === "answers") return Promise.resolve({ pong: true });
    if (root === "fails") return Promise.reject(new Error("not ready"));
    return new Promise((resolve, reject) => {
      if (typeof root === "number" && root < timeoutMs) setTimeout(() => resolve({}), root);
      else setTimeout(() => reject(new Error("timed out")), timeoutMs);
    });
  }
  rebuild() {
    this.rebuiltAt.push(performance.now());
    this.onRebuild();
    return true;
  }
}

const ctl = () => `spawn.ctl/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
const pty = () => `spawn.pty/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;

/** Move the fake clock, letting promise callbacks run between timers. */
async function advance(ms: number, step = 50) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    jest.advanceTimersByTime(Math.min(step, end - performance.now()));
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  }
}

let warn: Mock<typeof console.warn>;
const watches: ChannelOpenWatch[] = [];
function watching(peer: Peer) {
  const watch = new ChannelOpenWatch(peer, "host-under-test", T);
  watches.push(watch);
  return watch;
}
beforeEach(() => {
  jest.useFakeTimers();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const watch of watches.splice(0)) watch.close();
  jest.useRealTimers();
  warn.mockRestore();
});

test("the production timings keep the order the trigger depends on", () => {
  // A terminal gives up on an open after ten seconds; a give-up that late
  // has to count, and the watch's own deadline must not come after it.
  expect(T.abandonedAfterMs).toBeLessThan(10_000);
  expect(T.unansweredMs).toBeLessThanOrEqual(10_000);
  // A silent root, the path a merely slow host could reach, asks for the most.
  expect(T.rootSilenceMs).toBeGreaterThan(T.probeMs);
  expect(T.rebuildBackoffCapMs).toBeGreaterThanOrEqual(T.rebuildBackoffMs);
  // A run ends no sooner than the longest the watch ever waits between rebuilds.
  expect(T.runQuietMs).toBeGreaterThanOrEqual(T.rebuildBackoffCapMs);
});

test("the notice says the same as the phone's, word for word", () => {
  expect(REBUILDING_MESSAGE).toBe(
    "The connection stopped opening new terminals and tools. SPAWN D is making a new one.",
  );
});

test("a real wedge: two silent probes while the root answers rebuild, thirty seconds after the open", async () => {
  const peer = new Peer();
  watching(peer).opened("stuck", ctl());
  const opened = performance.now();
  await advance(SUSPECT);
  expect(peer.probes).toHaveLength(1);
  await advance(T.probeMs);
  expect(peer.probes).toHaveLength(2);
  expect(peer.pings).toBe(1);
  // The root answered at once; the second probe still gets its full window.
  await advance(T.probeMs - 100);
  expect(peer.rebuiltAt).toHaveLength(0);
  await advance(100);
  expect(peer.rebuiltAt).toEqual([opened + SUSPECT + PROOF]);
  expect(peer.probes.every((probe) => probe.closed)).toBe(true);
  expect(String(warn.mock.calls[0]?.[0])).toBe(
    "SPAWN D: host host-under-test: no new channel opens on its connection (one waited 10.0 s, " +
      "two probes 20.0 s, while the root channel answered a ping in 0 ms); " +
      "making a new connection (1 in a row).",
  );
});

test("a hello slower than the pong on a working peer stands the watch down", async () => {
  // The first probe's hello comes five seconds after the root's pong; or only
  // the second probe is answered, late in its window.
  for (const hello of [
    (index: number) => (index === 0 ? T.probeMs + 5_000 : null),
    (index: number) => (index === 1 ? T.probeMs - 2_000 : null),
  ]) {
    const peer = new Peer();
    peer.hello = hello;
    watching(peer).opened("slow", ctl());
    await advance(SUSPECT + PROOF + 2 * T.rootSilenceMs);
    expect(peer.pings).toBe(1);
    expect(peer.rebuiltAt).toHaveLength(0);
    expect(peer.probes.every((probe) => probe.closed)).toBe(true);
  }
  // A hello slower than both windows is what patience cannot tell from a
  // wedge: that one host is rebuilt.
  const slowest = new Peer();
  slowest.hello = (index) => (index === 0 ? PROOF + 1_000 : null);
  watching(slowest).opened("slowest", ctl());
  await advance(SUSPECT + PROOF + 2_000);
  expect(slowest.rebuiltAt).toHaveLength(1);
});

test("a pty channel's silence is not a symptom", async () => {
  const peer = new Peer();
  watching(peer).opened("quiet-shell", pty());
  await advance(5 * SUSPECT);
  expect(peer.probes).toHaveLength(0);
});

test("an answer on any watched channel while the probes wait ends them", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  watch.opened("stuck", ctl());
  await advance(SUSPECT + T.probeMs + 1_000);
  expect(peer.probes).toHaveLength(2);
  watch.opened("later", ctl());
  watch.answered("later");
  expect(peer.probes.every((probe) => probe.closed)).toBe(true);
  await advance(PROOF + 2 * T.rootSilenceMs);
  expect(peer.rebuiltAt).toHaveLength(0);
});

test("a silent root gets two pings before the peer is replaced; one that never left is no evidence", async () => {
  const silent = new Peer();
  silent.root = "silent";
  watching(silent).opened("stuck", ctl());
  const opened = performance.now();
  await advance(SUSPECT + T.probeMs + T.rootSilenceMs);
  expect(silent.pings).toBe(2);
  expect(silent.rebuiltAt).toHaveLength(0);
  await advance(T.rootSilenceMs);
  expect(silent.rebuiltAt).toEqual([opened + SUSPECT + T.probeMs + 2 * T.rootSilenceMs]);
  expect(String(warn.mock.calls.at(-1)?.[0])).toContain(
    "and the root channel did not answer two pings in 40.0 s",
  );

  // A root that answers its second ping late, the probes still silent: rebuilt then.
  const late = new Peer();
  late.ping = (timeoutMs) =>
    ++late.pings === 1
      ? new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs))
      : new Promise((resolve) => setTimeout(() => resolve({}), 3_000));
  watching(late).opened("stuck", ctl());
  const lateOpened = performance.now();
  await advance(SUSPECT + T.probeMs + T.rootSilenceMs + 3_000 + 100);
  expect(late.rebuiltAt).toEqual([lateOpened + SUSPECT + T.probeMs + T.rootSilenceMs + 3_000]);

  const unsent = new Peer();
  unsent.root = "fails";
  watching(unsent).opened("stuck", ctl());
  await advance(SUSPECT + PROOF + 2 * T.rootSilenceMs);
  expect(unsent.pings).toBe(1);
  expect(unsent.rebuiltAt).toHaveLength(0);
  expect(unsent.probes.every((probe) => probe.closed)).toBe(true);
});

test("readiness ending forgets what was pending without suspecting anything", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  watch.opened("pending", ctl());
  watch.reset();
  await advance(2 * SUSPECT);
  expect(peer.probes).toHaveLength(0);
  watch.opened("probed", ctl());
  await advance(SUSPECT + T.probeMs + 1_000);
  watch.reset();
  expect(peer.probes.map((probe) => probe.closed)).toEqual([true, true]);
  await advance(PROOF + 2 * T.rootSilenceMs);
  expect(peer.rebuiltAt).toHaveLength(0);
});

test("a fault a new peer does not fix: rebuilds back off 30 s, 60 s, 120 s, 240 s, then 5 min, though views reattach and are answered each time", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  let views = 0;
  // As the owner does: readiness ends, then views reattach on the new peer
  // and the daemon answers them before the fault comes back.
  peer.onRebuild = () => {
    queueMicrotask(() => {
      watch.reset();
      for (let view = 0; view < 3; view++) {
        const id = `reattached-${++views}`;
        watch.opened(id, ctl());
        watch.answered(id);
      }
    });
  };
  // A terminal that keeps retrying, as one does, and is never answered.
  let attempt = 0;
  const retry = () => {
    watch.opened(`stuck-${++attempt}`, ctl());
    setTimeout(retry, SUSPECT + 500);
  };
  retry();
  await advance(30 * 60_000, 250);
  const gaps = peer.rebuiltAt.slice(1).map((at, index) => at - peer.rebuiltAt[index]);
  expect(gaps.length).toBeGreaterThanOrEqual(6);
  expect(gaps[0]).toBeGreaterThanOrEqual(T.rebuildBackoffMs);
  expect(gaps[1]).toBeGreaterThanOrEqual(2 * T.rebuildBackoffMs);
  expect(gaps[2]).toBeGreaterThanOrEqual(4 * T.rebuildBackoffMs);
  expect(gaps[3]).toBeGreaterThanOrEqual(8 * T.rebuildBackoffMs);
  // Capped: never more than five minutes plus one detection round apart.
  for (const gap of gaps.slice(4)) {
    expect(gap).toBeGreaterThanOrEqual(T.rebuildBackoffCapMs);
    expect(gap).toBeLessThan(T.rebuildBackoffCapMs + SUSPECT + 500 + PROOF + 1_000);
  }
  expect(String(warn.mock.calls.at(-1)?.[0])).toContain(`(${peer.rebuiltAt.length} in a row)`);
});

test("a replacement that stays healthy for five minutes ends the run", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  peer.onRebuild = () => queueMicrotask(() => watch.reset());
  // A fault that keeps coming back, until three rebuilds in a row.
  for (let attempt = 0; peer.rebuiltAt.length < 3; attempt++) {
    watch.opened(`stuck-${attempt}`, ctl());
    await advance(SUSPECT + 500);
  }
  await advance(PROOF);
  expect(String(warn.mock.calls.at(-1)?.[0])).toContain("(3 in a row)");
  // Five healthy minutes, then the fault again: back to the first rung.
  await advance(T.runQuietMs);
  const before = performance.now();
  watch.opened("again", ctl());
  await advance(SUSPECT + PROOF + 100);
  expect(peer.rebuiltAt).toHaveLength(4);
  expect(peer.rebuiltAt[3]).toBe(before + SUSPECT + PROOF);
  expect(String(warn.mock.calls.at(-1)?.[0])).toContain("(1 in a row)");
});

test("a view given up on after the abandon threshold raises suspicion; one closed sooner does not", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  watch.opened("early", ctl());
  await advance(T.abandonedAfterMs - 1_000);
  watch.abandoned("early");
  await advance(2 * SUSPECT);
  expect(peer.probes).toHaveLength(0);
  watch.opened("late", ctl());
  await advance(T.abandonedAfterMs);
  watch.abandoned("late");
  expect(peer.probes).toHaveLength(1);
});
