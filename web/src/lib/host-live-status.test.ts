import { expect, test } from "bun:test";
import { hostLiveStatus } from "./host-live-status";

const dream = { name: "dream", status: "online" };

test("the server's offline wins: nothing to reconnect to", () => {
  expect(hostLiveStatus({ name: "pallete", status: "offline" }, { state: "connecting" })).toEqual({
    tone: "offline",
    label: "pallete is offline",
    problem: null,
    reconnecting: false,
  });
});

test("an online host is connected when this device's link is ready, or has none yet", () => {
  expect(hostLiveStatus(dream, { state: "ready" }).tone).toBe("active");
  expect(hostLiveStatus(dream, null).tone).toBe("active");
});

test("an online host this device has lost reads as reconnecting, and an error says why", () => {
  expect(hostLiveStatus(dream, { state: "connecting" })).toMatchObject({
    tone: "warning",
    label: "Reconnecting to dream…",
    reconnecting: true,
    problem: null,
  });
  expect(hostLiveStatus(dream, { state: "error", error: "Key mismatch" })).toMatchObject({
    tone: "warning",
    problem: "Key mismatch",
    reconnecting: true,
  });
});
