import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import {
  CHANNEL_WATCH_TIMING,
  ChannelOpenWatch,
  type ChannelWatchTiming,
  REBUILDING_MESSAGE,
  type WatchedPeer,
} from "./channel-watch";

const TIMING: ChannelWatchTiming = {
  unansweredMs: 20,
  abandonedAfterMs: 10,
  probeMs: 20,
  pingMs: 10,
  rebuildBackoffMs: 60,
  rebuildBackoffCapMs: 150,
};

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
  rootAnswers = true;
  rebuiltAt: number[] = [];
  openProbe(label: string) {
    const probe = new Probe(label);
    this.probes.push(probe);
    return probe as unknown as RTCDataChannel;
  }
  ping(timeoutMs: number) {
    this.pings++;
    return this.rootAnswers
      ? Promise.resolve({ pong: true })
      : new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs));
  }
  rebuild() {
    this.rebuiltAt.push(Date.now());
    return true;
  }
}

const ctl = () => `spawn.ctl/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
const pty = () => `spawn.pty/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
async function until(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}

let warn: Mock<typeof console.warn>;
const watches: ChannelOpenWatch[] = [];
function watching(peer: Peer) {
  const watch = new ChannelOpenWatch(peer, "host-under-test", TIMING);
  watches.push(watch);
  return watch;
}
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const watch of watches.splice(0)) watch.close();
  warn.mockRestore();
});

test("the production timings keep the order the trigger depends on", () => {
  const t = CHANNEL_WATCH_TIMING;
  // A terminal gives up on an open after ten seconds; a give-up that late
  // has to count, and the watch's own deadline must not come after it.
  expect(t.abandonedAfterMs).toBeLessThan(10_000);
  expect(t.unansweredMs).toBeLessThanOrEqual(10_000);
  expect(t.pingMs).toBeLessThan(t.probeMs);
  expect(t.rebuildBackoffMs).toBeGreaterThan(t.unansweredMs + t.probeMs + t.pingMs);
  expect(t.rebuildBackoffCapMs).toBeGreaterThanOrEqual(t.rebuildBackoffMs);
});

test("the notice says the same as the phone's, word for word", () => {
  expect(REBUILDING_MESSAGE).toBe(
    "The connection stopped opening terminals. SPAWN D is making a new one.",
  );
});

test("a pty channel's silence is not a symptom", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  watch.opened("quiet-shell", pty());
  await Bun.sleep(TIMING.unansweredMs * 2);
  expect(peer.probes).toHaveLength(0);
});

test("an answer anywhere while the probe waits ends it, and nothing is rebuilt", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  watch.opened("stuck", ctl());
  await until(() => peer.probes.length === 1);
  // Another view's channel, opened while the probe waits, is answered.
  watch.opened("later", ctl());
  watch.answered("later");
  expect(peer.probes[0].closed).toBe(true);
  await Bun.sleep(TIMING.probeMs + TIMING.pingMs + 10);
  expect(peer.pings).toBe(0);
  expect(peer.rebuiltAt).toHaveLength(0);
});

test("the probe's own hello or refusal is an answer", async () => {
  for (const answer of ["onmessage", "onclose"] as const) {
    const peer = new Peer();
    const watch = watching(peer);
    watch.opened(answer, ctl());
    await until(() => peer.probes.length === 1);
    peer.probes[0][answer]?.();
    await Bun.sleep(TIMING.probeMs + TIMING.pingMs + 10);
    expect(peer.pings).toBe(0);
    expect(peer.rebuiltAt).toHaveLength(0);
  }
});

test("readiness ending forgets what was pending without suspecting anything", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  watch.opened("pending", ctl());
  watch.reset();
  await Bun.sleep(TIMING.unansweredMs * 2);
  expect(peer.probes).toHaveLength(0);
  watch.opened("probed", ctl());
  await until(() => peer.probes.length === 1);
  watch.reset();
  expect(peer.probes[0].closed).toBe(true);
  await Bun.sleep(TIMING.probeMs + TIMING.pingMs + 10);
  expect(peer.rebuiltAt).toHaveLength(0);
});

test("rebuilds in a row back off, doubling to a cap; an answer starts the run over", async () => {
  const peer = new Peer();
  const watch = watching(peer);
  let stop = false;
  const failing = (async () => {
    for (let n = 0; !stop; n++) {
      watch.opened(`attempt-${n}`, ctl());
      await Bun.sleep(TIMING.unansweredMs + 2);
    }
  })();
  await until(() => peer.rebuiltAt.length === 4, 3_000);
  stop = true;
  await failing;
  const gaps = peer.rebuiltAt.slice(1).map((at, index) => at - peer.rebuiltAt[index]);
  expect(gaps[0]).toBeGreaterThanOrEqual(TIMING.rebuildBackoffMs);
  expect(gaps[1]).toBeGreaterThanOrEqual(2 * TIMING.rebuildBackoffMs);
  expect(gaps[2]).toBeGreaterThanOrEqual(TIMING.rebuildBackoffCapMs);
  expect(gaps[2]).toBeLessThan(TIMING.rebuildBackoffCapMs + 4 * TIMING.unansweredMs);
  expect(String(warn.mock.calls[3]?.[0])).toContain("4 in a row");

  // A channel answered after that resets the run, though not the gap the
  // last rebuild set.
  watch.opened("answered", ctl());
  watch.answered("answered");
  await Bun.sleep(TIMING.rebuildBackoffCapMs);
  watch.opened("after", ctl());
  await until(() => peer.rebuiltAt.length === 5);
  expect(String(warn.mock.calls[4]?.[0])).toContain("1 in a row");
  expect(String(warn.mock.calls[4]?.[0])).toContain("host host-under-test");
});
