import { describe, expect, test } from "bun:test";
import {
  dropHostControlClient,
  hostControlPresence,
  reportHostControlState,
  subscribe,
} from "@/lib/host-control-presence";

describe("host control presence", () => {
  test("aggregates clients in ready, connecting, then failed order", () => {
    const hostId = "host-aggregate";
    const first = Symbol("first");
    const second = Symbol("second");
    const third = Symbol("third");

    expect(hostControlPresence(hostId)).toBeNull();

    reportHostControlState(hostId, first, "error");
    expect(hostControlPresence(hostId)).toBe("failed");

    reportHostControlState(hostId, second, "open");
    expect(hostControlPresence(hostId)).toBe("connecting");

    reportHostControlState(hostId, third, "ready");
    expect(hostControlPresence(hostId)).toBe("ready");

    reportHostControlState(hostId, third, "closed");
    expect(hostControlPresence(hostId)).toBe("connecting");

    dropHostControlClient(hostId, second);
    expect(hostControlPresence(hostId)).toBe("failed");

    dropHostControlClient(hostId, first);
    expect(hostControlPresence(hostId)).toBeNull();
    dropHostControlClient(hostId, third);
  });

  test("treats idle and closed clients as absent", () => {
    const hostId = "host-inactive";
    reportHostControlState(hostId, "idle-client", "idle");
    reportHostControlState(hostId, "closed-client", "closed");
    expect(hostControlPresence(hostId)).toBeNull();
    dropHostControlClient(hostId, "idle-client");
    dropHostControlClient(hostId, "closed-client");
  });

  test("notifies subscribers only when a client entry changes", () => {
    const hostId = "host-subscribe";
    const clientId = Symbol("subscriber");
    let notifications = 0;
    const unsubscribe = subscribe(() => {
      notifications += 1;
    });

    reportHostControlState(hostId, clientId, "connecting");
    reportHostControlState(hostId, clientId, "connecting");
    reportHostControlState(hostId, clientId, "ready");
    dropHostControlClient(hostId, clientId);
    dropHostControlClient(hostId, clientId);

    expect(notifications).toBe(3);
    unsubscribe();
  });
});
