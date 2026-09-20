import { expect, test } from "bun:test";
import { RemoteDaemonChannel } from "./daemon-channel";

test("ready and replay arriving before open are delivered once, after the real open event", () => {
  const channel = new RemoteDaemonChannel("spawn.ctl", () => {});
  const observed: unknown[] = [];
  channel.onopen = () => observed.push("open");
  channel.onmessage = ({ data }) => observed.push(data);
  const replay = Uint8Array.of(1, 2).buffer;
  channel.receive("ready");
  channel.receive(replay);
  expect(observed).toEqual([]);
  expect(channel.readyState).toBe("connecting");
  expect(() => channel.send("input")).toThrow();
  channel.opened();
  channel.opened();
  expect(observed).toEqual(["open", "ready", replay]);
});

test("retirement before open discards readiness and replay permanently", () => {
  const channel = new RemoteDaemonChannel("spawn.ctl", () => {});
  const observed: unknown[] = [];
  channel.onmessage = ({ data }) => observed.push(data);
  channel.receive("old ready");
  channel.retired();
  channel.opened();
  channel.receive("late");
  expect(channel.readyState).toBe("closed");
  expect(observed).toEqual([]);
});

test("closing in the open callback cannot release buffered data", () => {
  const channel = new RemoteDaemonChannel("spawn.ctl", () => {});
  channel.receive("ready");
  const observed: unknown[] = [];
  channel.onmessage = ({ data }) => observed.push(data);
  channel.onopen = () => channel.close();
  channel.opened();
  expect(observed).toEqual([]);
});

test("early receive is bounded by both bytes and message count", () => {
  for (const data of [new ArrayBuffer(64 * 1024), ""]) {
    const closed: unknown[] = [];
    const channel = new RemoteDaemonChannel("spawn.ctl", (event) => closed.push(event));
    for (let index = 0; index < 1025; index++) channel.receive(data);
    expect(channel.readyState).toBe("closed");
    expect(closed).toEqual([{ type: "close" }]);
  }
});

test("reentrant delivery preserves the order of the pre-open queue", () => {
  const channel = new RemoteDaemonChannel("spawn.ctl", () => {});
  const observed: unknown[] = [];
  channel.receive("first");
  channel.receive("second");
  channel.onopen = () => channel.receive("third");
  channel.onmessage = ({ data }) => {
    observed.push(data);
    if (data === "first") channel.receive("fourth");
  };
  channel.opened();
  expect(observed).toEqual(["first", "second", "third", "fourth"]);
});
