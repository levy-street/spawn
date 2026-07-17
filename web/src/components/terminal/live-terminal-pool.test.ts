import { describe, expect, test } from "bun:test";
import { destroyLiveTerminalEntries } from "./live-terminal-pool";

describe("live terminal trust teardown", () => {
  test("disconnects and removes claimed and parked entries without exemptions", () => {
    const disconnected: string[] = [];
    const removed: string[] = [];
    const claimed = {
      host: { remove: () => removed.push("claimed") },
      handleRef: { current: { disconnect: () => disconnected.push("claimed") } },
    };
    const parked = {
      host: { remove: () => removed.push("parked") },
      handleRef: { current: { disconnect: () => disconnected.push("parked") } },
    };

    destroyLiveTerminalEntries([claimed, parked]);

    expect(disconnected).toEqual(["claimed", "parked"]);
    expect(removed).toEqual(["claimed", "parked"]);
    expect(claimed.handleRef.current).toBeNull();
    expect(parked.handleRef.current).toBeNull();
  });

  test("continues closing later data channels when one entry teardown throws", () => {
    const disconnected: string[] = [];
    const removed: string[] = [];
    const broken = {
      host: {
        remove: () => {
          throw new Error("detached host is corrupt");
        },
      },
      handleRef: {
        current: {
          disconnect: () => {
            disconnected.push("broken");
            throw new Error("broken data channel");
          },
        },
      },
    };
    const healthy = {
      host: { remove: () => removed.push("healthy") },
      handleRef: { current: { disconnect: () => disconnected.push("healthy") } },
    };

    destroyLiveTerminalEntries([broken, healthy]);

    expect(disconnected).toEqual(["broken", "healthy"]);
    expect(removed).toEqual(["healthy"]);
    expect(broken.handleRef.current).toBeNull();
    expect(healthy.handleRef.current).toBeNull();
  });
});
