import { describe, expect, test } from "bun:test";
import { createHoverIntent, HOVER_OPEN_DELAY_MS } from "./hover-intent";

/** A hand-cranked clock, so nothing here waits on real time. */
function clock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id: number) {
      pending.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}

function harness() {
  const time = clock();
  const changes: Array<{ value: { path: string } | null; pinned: boolean }> = [];
  const intent = createHoverIntent<{ path: string }>({
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onChange: (value, pinned) => changes.push({ value, pinned }),
  });
  return { time, changes, intent, last: () => changes.at(-1) };
}

describe("createHoverIntent", () => {
  test("opens only after the delay", () => {
    const { time, intent, last } = harness();
    intent.enter({ path: "/a" });
    time.advance(HOVER_OPEN_DELAY_MS - 1);
    expect(last()).toBeUndefined();
    time.advance(1);
    expect(last()).toEqual({ value: { path: "/a" }, pinned: false });
  });

  test("moving away before the delay never opens", () => {
    // Sweeping down a list crosses dozens of rows; none of them should fetch.
    const { time, intent, changes } = harness();
    intent.enter({ path: "/a" });
    time.advance(100);
    intent.cancel();
    time.advance(1000);
    expect(changes).toHaveLength(0);
  });

  test("re-entering the open target is a no-op, not a refetch", () => {
    const { time, intent, changes } = harness();
    intent.enter({ path: "/a" });
    time.advance(HOVER_OPEN_DELAY_MS);
    expect(changes).toHaveLength(1);

    intent.enter({ path: "/a" });
    time.advance(5000);
    expect(changes).toHaveLength(1);
  });

  test("nothing closes on its own — there is no close timer", () => {
    // The card is dismissed by leaving its region, never by a deadline that
    // could expire while the pointer is still travelling toward it.
    const { time, intent, last } = harness();
    intent.enter({ path: "/a" });
    time.advance(HOVER_OPEN_DELAY_MS);
    time.advance(60_000);
    expect(last()).toEqual({ value: { path: "/a" }, pinned: false });
  });

  test("moving to a different target swaps after the delay", () => {
    const { time, intent, last } = harness();
    intent.enter({ path: "/a" });
    time.advance(HOVER_OPEN_DELAY_MS);
    intent.enter({ path: "/b" });
    time.advance(HOVER_OPEN_DELAY_MS);
    expect(last()).toEqual({ value: { path: "/b" }, pinned: false });
  });

  test("cancel closes at once, whenever the caller decides", () => {
    const { time, intent, last } = harness();
    intent.enter({ path: "/a" });
    time.advance(HOVER_OPEN_DELAY_MS);
    intent.cancel();
    expect(last()).toEqual({ value: null, pinned: false });
  });

  test("pin opens immediately and survives hover changes", () => {
    // The keyboard path: Space must not wait, and must not close because the
    // pointer wandered.
    const { time, intent, last } = harness();
    intent.pin({ path: "/a" });
    expect(last()).toEqual({ value: { path: "/a" }, pinned: true });
    intent.enter({ path: "/b" });
    time.advance(10_000);
    expect(last()).toEqual({ value: { path: "/a" }, pinned: true });
  });

  test("pin ignores a subsequent hover", () => {
    const { time, intent, last } = harness();
    intent.pin({ path: "/a" });
    intent.enter({ path: "/b" });
    time.advance(10_000);
    expect(last()?.value).toEqual({ path: "/a" });
  });

  test("cancel closes immediately, including when pinned", () => {
    const { intent, last } = harness();
    intent.pin({ path: "/a" });
    intent.cancel();
    expect(last()).toEqual({ value: null, pinned: false });
  });

  test("cancel with nothing open emits nothing", () => {
    const { intent, changes } = harness();
    intent.cancel();
    expect(changes).toHaveLength(0);
  });

  test("cancel drops a pending open", () => {
    const { time, intent, changes } = harness();
    intent.enter({ path: "/a" });
    intent.cancel();
    time.advance(10_000);
    expect(changes).toHaveLength(0);
  });

  test("dispose leaves no timer behind", () => {
    const { time, intent } = harness();
    intent.enter({ path: "/a" });
    expect(time.pendingCount()).toBe(1);
    intent.dispose();
    expect(time.pendingCount()).toBe(0);
  });
});
