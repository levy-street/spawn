// @ts-nocheck -- focused browser transport fakes; production code remains type-checked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  hostControlInventoryViolations,
  loadProductionSourceFiles,
} from "../../test-support/production-source-guard";
import type { Host } from "./api";
import {
  approveBrowserHostPin,
  resolveActiveBrowserHostPinMaterial,
  revokeBrowserHostPin,
} from "./browser-host-pins";
import type { BrowserTrustStatus } from "./browser-trust";
import { resolveHostWithinTrustEpoch } from "./browser-trust-operations";
import { type HostControlTrustDependencies, HostControlTrustRegistry } from "./host-control-trust";
import { ed25519PublicKeyFingerprint, encodeBase64Url } from "./signed-signal";

const HOST_1 = "00000000-0000-4000-8000-000000000001";
const HOST_2 = "00000000-0000-4000-8000-000000000002";
const USER_A = "00000000-0000-4000-8000-000000000010";
const USER_B = "00000000-0000-4000-8000-000000000020";
const HOST_3 = "00000000-0000-4000-8000-000000000003";
const ORIGIN = "https://spawn.example";
const HOST_KEY_1 = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const HOST_KEY_2 = "11qYAYdk9Jt0uvL7Tp_5eQK8heP0LOEYVVt4dSK3M3A";

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

function lifecycleDependencies(): HostControlTrustDependencies {
  const fingerprint = "SHA256:CCCCCCCCCCCCCCCC";
  return {
    serverOrigin: () => ORIGIN,
    fetchHost: async (hostId) =>
      ({
        id: hostId,
        host_public_key: HOST_KEY_1,
        host_key_fingerprint: fingerprint,
      }) as Host,
    resolvePin: async (lease, origin, host) => ({
      accountId: lease.accountOwnerUserId,
      approvedAtMs: 1,
      createdAtMs: 1,
      hostFingerprint: fingerprint,
      hostIds: [host.id],
      hostPublicKey: HOST_KEY_1,
      origin,
      revokedAtMs: null,
      state: "active",
      version: 1,
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    const registry = new HostControlTrustRegistry(undefined, lifecycleDependencies());
    registry.applyTrust(trusted(USER_A, 1));
    const active = await registry.resolveClient(HOST_1);
    const pending = await registry.resolveClient(HOST_2);

    expect(active.trustMaterial).toMatchObject({
      accountOwnerUserId: USER_A,
      destination: { hostId: HOST_1, peerIdentity: { status: "local_host_pin" } },
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

    const replacement = await registry.resolveClient(HOST_2);
    expect(replacement.trustMaterial).toMatchObject({
      accountOwnerUserId: USER_B,
      trustEpochKey: "2:trusted:00000000-0000-4000-8000-000000000020",
      destination: { hostId: HOST_2 },
    });
    replacement.close();
  });

  test("normal close and caller-aborted waits release listeners before bounded reacquisition", async () => {
    const registry = new HostControlTrustRegistry(undefined, lifecycleDependencies());
    registry.applyTrust(trusted(USER_A, 1));
    const reusable = await registry.resolveClient(HOST_1);
    expect(registry.activeClientCount()).toBe(1);
    reusable.close();
    expect(registry.activeClientCount()).toBe(0);

    reusable.connect();
    expect(registry.activeClientCount()).toBe(1);
    reusable.close();
    expect(registry.activeClientCount()).toBe(0);

    const waiting = await registry.resolveClient(HOST_2);
    for (let index = 0; index < 96; index += 1) {
      const caller = new AbortController();
      const result = waiting.waitUntilReady(10_000, caller.signal).catch((error) => error);
      caller.abort();
      expect((await result).name).toBe("AbortError");
    }
    waiting.close();
    expect(registry.activeClientCount()).toBe(0);

    for (let index = 0; index < 96; index += 1) {
      const client = await registry.resolveClient(HOST_1);
      client.close();
    }
    expect(registry.activeClientCount()).toBe(0);

    const clients = await Promise.all(
      Array.from({ length: 32 }, () => registry.resolveClient(HOST_1)),
    );
    await expect(registry.resolveClient(HOST_2)).rejects.toThrow("Too many host control clients");
    for (const client of clients) client.close();
    expect(registry.activeClientCount()).toBe(0);
  });

  test("pending destination resolution is bounded and keeps its charge until abort settles", async () => {
    const gate = deferred<Host>();
    const dependencies = lifecycleDependencies();
    const registry = new HostControlTrustRegistry(undefined, {
      ...dependencies,
      fetchHost: () => gate.promise,
    });
    registry.applyTrust(trusted(USER_A, 1));
    const pending = Array.from({ length: 32 }, () =>
      registry.resolveClient(HOST_1).catch((error) => error),
    );
    await expect(registry.resolveClient(HOST_2)).rejects.toThrow("Too many host control clients");

    registry.invalidate();
    gate.resolve(await lifecycleDependencies().fetchHost(HOST_1, new AbortController().signal));
    const results = await Promise.all(pending);
    expect(results.every((error) => error instanceof Error && error.name === "AbortError")).toBe(
      true,
    );
    expect(registry.activeClientCount()).toBe(0);
  });

  test("resolves H1 and H2 distinct local pins and fails closed on missing, swapped, or revoked pins", async () => {
    const factory = new IDBFactory();
    const fingerprint1 = await ed25519PublicKeyFingerprint(HOST_KEY_1);
    const fingerprint2 = await ed25519PublicKeyFingerprint(HOST_KEY_2);
    await approveBrowserHostPin(
      {
        accountId: USER_A,
        origin: ORIGIN,
        hostPublicKey: HOST_KEY_1,
        hostFingerprint: fingerprint1,
      },
      { indexedDBFactory: factory },
    );
    await approveBrowserHostPin(
      {
        accountId: USER_A,
        origin: ORIGIN,
        hostPublicKey: HOST_KEY_2,
        hostFingerprint: fingerprint2,
      },
      { indexedDBFactory: factory },
    );
    const missingPair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as {
      publicKey: CryptoKey;
    };
    const missingKey = encodeBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("raw", missingPair.publicKey)),
    );
    const missingFingerprint = await ed25519PublicKeyFingerprint(missingKey);
    const host = (id: string, key: string, fingerprint: string): Host =>
      ({
        id,
        name: id,
        host_key_algorithm: "ed25519",
        host_public_key: key,
        host_key_fingerprint: fingerprint,
        status: "online",
        last_seen_at: null,
        agent_count: 0,
      }) as Host;
    const responses = new Map<string, Host>([
      [HOST_1, host(HOST_1, HOST_KEY_1, fingerprint1)],
      [HOST_2, host(HOST_2, HOST_KEY_2, fingerprint2)],
      [HOST_3, host(HOST_3, missingKey, missingFingerprint)],
    ]);
    const dependencies: HostControlTrustDependencies = {
      serverOrigin: () => ORIGIN,
      fetchHost: async (hostId) => responses.get(hostId)!,
      resolvePin: (lease, origin, claimed) =>
        resolveHostWithinTrustEpoch(
          {
            lease,
            origin,
            hostId: claimed.id,
            claimedHostPublicKey: claimed.host_public_key ?? null,
            claimedHostFingerprint: claimed.host_key_fingerprint ?? null,
          },
          (input, signal) =>
            resolveActiveBrowserHostPinMaterial(input, {
              indexedDBFactory: factory,
              signal,
            }),
        ),
    };
    const registry = new HostControlTrustRegistry(undefined, dependencies);
    registry.applyTrust(trusted(USER_A, 1));

    const h1 = await registry.resolveClient(HOST_1);
    const h2 = await registry.resolveClient(HOST_2);
    expect(h1.trustMaterial.destination).toMatchObject({
      hostId: HOST_1,
      serverOrigin: ORIGIN,
      peerIdentity: {
        status: "local_host_pin",
        publicKey: HOST_KEY_1,
        fingerprint: fingerprint1,
      },
    });
    expect(h2.trustMaterial.destination.peerIdentity.publicKey).toBe(HOST_KEY_2);
    h1.close();
    h2.close();

    await expect(registry.resolveClient(HOST_3)).rejects.toThrow("no locally approved host pin");
    responses.set(HOST_2, host(HOST_2, HOST_KEY_1, fingerprint1));
    await expect(registry.resolveClient(HOST_2)).rejects.toThrow("different local key");
    responses.set(HOST_2, host(HOST_2, HOST_KEY_2, fingerprint2));
    await revokeBrowserHostPin(
      {
        accountId: USER_A,
        origin: ORIGIN,
        targetHostId: HOST_2,
        claimedHostId: HOST_2,
        claimedHostPublicKey: HOST_KEY_2,
        claimedHostFingerprint: fingerprint2,
      },
      { indexedDBFactory: factory },
    );
    await expect(registry.resolveClient(HOST_2)).rejects.toThrow("revoked");
    expect(registry.activeClientCount()).toBe(0);
  });

  test("production construction has one mandatory registry boundary and no raw callers", async () => {
    const sources = await loadProductionSourceFiles();
    expect(hostControlInventoryViolations(sources)).toEqual([]);
  });
});
