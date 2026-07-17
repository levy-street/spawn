// @ts-nocheck -- focused browser transport fakes; production code remains type-checked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BrowserTrustStatus } from "./browser-trust";
import { HostControlTrustRegistry, unsignedHostControlDestination } from "./host-control-trust";

const HOST_1 = "00000000-0000-4000-8000-000000000001";
const HOST_2 = "00000000-0000-4000-8000-000000000002";
const USER_A = "00000000-0000-4000-8000-000000000010";
const USER_B = "00000000-0000-4000-8000-000000000020";

class IdleWebSocket {
  static instances: IdleWebSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  protocol = "spawn.host.v1";
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor() {
    IdleWebSocket.instances.push(this);
  }

  send() {}
  close() {
    this.readyState = 3;
  }
}

function trusted(userId: string, epoch: number): BrowserTrustStatus {
  return {
    status: "trusted",
    reason: null,
    epoch,
    epochKey: `${epoch}:trusted:${userId}`,
    accountOwnerUserId: userId,
    observedUserId: userId,
    browserDeviceId: `00000000-0000-4000-8000-${epoch.toString().padStart(12, "0")}`,
    browserPublicKey:
      userId === USER_A
        ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        : "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  };
}

describe("HostControl browser trust registry", () => {
  beforeEach(() => {
    IdleWebSocket.instances = [];
    globalThis.WebSocket = IdleWebSocket;
  });

  afterEach(() => {
    delete globalThis.WebSocket;
  });

  test("binds each destination to one owner and synchronously revokes active and pending clients", async () => {
    const registry = new HostControlTrustRegistry();
    registry.applyTrust(trusted(USER_A, 1));
    const active = registry.createClient(unsignedHostControlDestination(HOST_1));
    const pending = registry.createClient(unsignedHostControlDestination(HOST_2));

    expect(active.trustMaterial).toMatchObject({
      accountOwnerUserId: USER_A,
      destination: { hostId: HOST_1, peerIdentity: { status: "unsigned_not_implemented" } },
    });
    expect(pending.trustMaterial.destination.hostId).toBe(HOST_2);
    const waiting = pending.waitUntilReady(10_000).catch((error) => error);
    active.connect();
    expect(registry.activeClientCount()).toBe(2);

    registry.applyTrust(trusted(USER_B, 2));
    expect((await waiting).name).toBe("AbortError");
    expect(active.getState()).toBe("closed");
    expect(pending.getState()).toBe("closed");
    expect(registry.activeClientCount()).toBe(0);

    const socketCount = IdleWebSocket.instances.length;
    active.connect();
    pending.connect();
    expect(IdleWebSocket.instances).toHaveLength(socketCount);
    expect(registry.activeClientCount()).toBe(0);

    const replacement = registry.createClient(unsignedHostControlDestination(HOST_2));
    expect(replacement.trustMaterial).toMatchObject({
      accountOwnerUserId: USER_B,
      trustEpochKey: "2:trusted:00000000-0000-4000-8000-000000000020",
      destination: { hostId: HOST_2 },
    });
    replacement.close();
  });

  test("normal close and caller-aborted waits release listeners before bounded reacquisition", async () => {
    const registry = new HostControlTrustRegistry();
    registry.applyTrust(trusted(USER_A, 1));
    const reusable = registry.createClient(unsignedHostControlDestination(HOST_1));
    expect(registry.activeClientCount()).toBe(1);
    reusable.close();
    expect(registry.activeClientCount()).toBe(0);

    reusable.connect();
    expect(registry.activeClientCount()).toBe(1);
    reusable.close();
    expect(registry.activeClientCount()).toBe(0);

    const waiting = registry.createClient(unsignedHostControlDestination(HOST_2));
    for (let index = 0; index < 96; index += 1) {
      const caller = new AbortController();
      const result = waiting.waitUntilReady(10_000, caller.signal).catch((error) => error);
      caller.abort();
      expect((await result).name).toBe("AbortError");
    }
    waiting.close();
    expect(registry.activeClientCount()).toBe(0);

    for (let index = 0; index < 96; index += 1) {
      const client = registry.createClient(unsignedHostControlDestination(HOST_1));
      client.close();
    }
    expect(registry.activeClientCount()).toBe(0);

    const clients = Array.from({ length: 32 }, () =>
      registry.createClient(unsignedHostControlDestination(HOST_1)),
    );
    expect(() => registry.createClient(unsignedHostControlDestination(HOST_2))).toThrow(
      "Too many host control clients",
    );
    for (const client of clients) client.close();
    expect(registry.activeClientCount()).toBe(0);
  });

  test("production construction has one mandatory registry boundary and no raw callers", async () => {
    const hits: Array<{ path: string; count: number }> = [];
    const glob = new Bun.Glob("src/**/*.{ts,tsx}");
    for await (const path of glob.scan(".")) {
      if (path.includes(".test.") || path.includes("/hostControl.ts")) continue;
      const source = await Bun.file(path).text();
      const count = source.match(/new\s+HostControlClient\s*\(/gu)?.length ?? 0;
      if (count > 0) hits.push({ path, count });
    }
    expect(hits).toEqual([{ path: "src/lib/host-control-trust.tsx", count: 1 }]);
  });
});
