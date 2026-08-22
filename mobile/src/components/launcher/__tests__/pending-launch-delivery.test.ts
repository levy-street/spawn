import {
  createPendingLaunchStore,
  type PendingLaunchStorage,
  type PendingLaunchStore,
} from "@/components/launcher/pending-launch";
import {
  observePendingLaunchDelivery,
  type PendingLaunchDeliveryResult,
  type PendingLaunchTransport,
  type PendingSessionLife,
  pendingSessionLifeFromStatus,
} from "@/components/launcher/pending-launch-delivery";
import type { TransportState } from "@/terminal/transport/types";

class MemoryStorage implements PendingLaunchStorage {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FakeTransport implements PendingLaunchTransport {
  state: TransportState = "idle";
  readonly writes: Uint8Array[] = [];
  readonly listeners = new Set<(state: TransportState) => void>();

  constructor(readonly sessionId: string) {}

  write(bytes: Uint8Array): void {
    this.writes.push(bytes);
  }

  on(_event: "state", listener: (state: TransportState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state: TransportState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function flushDelivery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function observe(
  transport: FakeTransport,
  pending: PendingLaunchStore,
  results: PendingLaunchDeliveryResult[],
  options: {
    initialSessionLife?: PendingSessionLife;
    getSessionLife?: () => Promise<PendingSessionLife>;
  } = {},
): () => void {
  return observePendingLaunchDelivery({
    transport,
    pending,
    onResult: (result) => results.push(result),
    ...options,
  });
}

describe("pending launch delivery", () => {
  test("treats starting and running sessions as live without guessing about unknown states", () => {
    expect(pendingSessionLifeFromStatus("starting")).toBe("alive");
    expect(pendingSessionLifeFromStatus("running")).toBe("alive");
    expect(pendingSessionLifeFromStatus("exited")).toBe("dead");
    expect(pendingSessionLifeFromStatus("killed")).toBe("dead");
    expect(pendingSessionLifeFromStatus("future_state")).toBe("unknown");
  });

  test("writes the constructed command and return byte only when transport is ready", async () => {
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-1", "codex --dangerously-bypass-approvals-and-sandbox");
    const transport = new FakeTransport("session-1");
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, pending, results);

    for (const state of ["signalling", "connecting", "reconnecting"] as const) {
      transport.emit(state);
      await flushDelivery();
    }
    expect(transport.writes).toHaveLength(0);

    transport.emit("ready");
    await flushDelivery();
    expect(transport.writes).toHaveLength(1);
    expect(new TextDecoder().decode(transport.writes[0])).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox\r",
    );
    expect(results).toEqual([{ status: "sent" }]);
    expect(storage.values.size).toBe(0);
  });

  test("does not resend when ready is emitted after a reconnect", async () => {
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-2", "claude");
    const transport = new FakeTransport("session-2");
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, pending, results);

    transport.emit("ready");
    await flushDelivery();
    transport.emit("reconnecting");
    transport.emit("ready");
    await flushDelivery();

    expect(transport.writes).toHaveLength(1);
    expect(results).toEqual([{ status: "sent" }]);
  });

  test("allows only one mounted transport to claim a session command", async () => {
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-shared", "claude");
    const first = new FakeTransport("session-shared");
    const second = new FakeTransport("session-shared");
    observe(first, pending, []);
    observe(second, pending, []);

    first.emit("ready");
    second.emit("ready");
    await flushDelivery();

    expect(first.writes.length + second.writes.length).toBe(1);
  });

  test("abandons without writing when the session dies before ready", async () => {
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-3", "opencode");
    const transport = new FakeTransport("session-3");
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, pending, results, { getSessionLife: async () => "dead" });

    transport.emit("connecting");
    await flushDelivery();
    expect(transport.writes).toHaveLength(0);
    transport.emit("failed");
    await flushDelivery();

    expect(transport.writes).toHaveLength(0);
    expect(results).toEqual([{ status: "abandoned", reason: "session_dead" }]);
    await expect(pending.take("session-3")).resolves.toEqual({ status: "missing" });
  });

  test("abandons an expired record instead of writing it", async () => {
    const storage = new MemoryStorage();
    let now = 100;
    const pending = createPendingLaunchStore(storage, { now: () => now, ttlMs: 50 });
    await pending.persist("session-4", "aider");
    now = 151;
    const transport = new FakeTransport("session-4");
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, pending, results);

    transport.emit("ready");
    await flushDelivery();
    expect(transport.writes).toHaveLength(0);
    expect(results).toEqual([{ status: "stale" }]);
  });

  test("a restarted process delivers a persisted record once", async () => {
    const storage = new MemoryStorage();
    await createPendingLaunchStore(storage).persist("session-5", "TOKEN=secret codex");

    const restartedPending = createPendingLaunchStore(storage);
    const transport = new FakeTransport("session-5");
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, restartedPending, results);
    transport.emit("ready");
    await flushDelivery();

    expect(transport.writes).toHaveLength(1);
    expect(new TextDecoder().decode(transport.writes[0])).toBe("TOKEN=secret codex\r");
    transport.emit("ready");
    await flushDelivery();
    expect(transport.writes).toHaveLength(1);
  });

  test("will not write if readiness is lost while the durable claim is in flight", async () => {
    const gate = deferred();
    const pending: PendingLaunchStore = {
      persist: async () => ({
        sessionId: "session-6",
        command: "claude",
        createdAt: 1,
        expiresAt: 2,
      }),
      take: async () => {
        await gate.promise;
        return {
          status: "ready",
          record: { sessionId: "session-6", command: "claude", createdAt: 1, expiresAt: 2 },
        };
      },
      complete: jest.fn(async () => undefined),
      abandon: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
    };
    const transport = new FakeTransport("session-6");
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, pending, results);

    transport.emit("ready");
    transport.emit("reconnecting");
    gate.resolve();
    await flushDelivery();

    expect(transport.writes).toHaveLength(0);
    expect(results).toEqual([{ status: "abandoned", reason: "delivery_unconfirmed" }]);
    expect(pending.complete).toHaveBeenCalledWith("session-6");
  });
});
