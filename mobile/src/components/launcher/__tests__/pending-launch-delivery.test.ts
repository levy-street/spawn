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
  PROVISIONAL_RECHECK_MS,
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

const HOST = "dream";

type DisplayListener = (display: { owner: boolean }) => void;

class FakeTransport implements PendingLaunchTransport {
  state: TransportState = "idle";
  displayOwner?: boolean;
  readonly writes: Uint8Array[] = [];
  readonly listeners = new Set<(state: TransportState) => void>();
  readonly displayListeners = new Set<DisplayListener>();

  constructor(
    readonly sessionId: string,
    readonly hostId: string = HOST,
  ) {}

  write(bytes: Uint8Array): void {
    this.writes.push(bytes);
  }

  on(event: "state", listener: (state: TransportState) => void): () => void;
  on(event: "display", listener: DisplayListener): () => void;
  on(
    event: "state" | "display",
    listener: ((state: TransportState) => void) | DisplayListener,
  ): () => void {
    if (event === "display") {
      const onDisplay = listener as DisplayListener;
      this.displayListeners.add(onDisplay);
      return () => this.displayListeners.delete(onDisplay);
    }
    const onState = listener as (state: TransportState) => void;
    this.listeners.add(onState);
    return () => this.listeners.delete(onState);
  }

  emit(state: TransportState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  emitDisplay(owner: boolean): void {
    this.displayOwner = owner;
    for (const listener of this.displayListeners) listener({ owner });
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
    await pending.persist("session-1", HOST, "codex --dangerously-bypass-approvals-and-sandbox");
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

  test("waits for this view to hold the display before typing, then types once", async () => {
    // A window moved to another host can be attached there first by a device
    // that only followed it; until this view's claim lands its input would be
    // dropped, and the command with it.
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-moved", HOST, "claude --session-id abc");
    const transport = new FakeTransport("session-moved");
    transport.displayOwner = false;
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, pending, results);

    transport.emit("ready");
    await flushDelivery();
    expect(transport.writes).toHaveLength(0);
    expect(results).toEqual([]);

    transport.emitDisplay(true);
    await flushDelivery();
    transport.emitDisplay(true);
    await flushDelivery();
    expect(transport.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      "claude --session-id abc\r",
    ]);
    expect(results).toEqual([{ status: "sent" }]);
  });

  test("never types a launch queued for the window on the host it left", async () => {
    // A restart from this phone while another device held the display: the
    // resume waits. The window then moves; the phone follows it to mac, and
    // later takes control there — and after a move back, on dream's next
    // shell. The resume was for dream's old shell and is typed into neither.
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-followed", HOST, "claude --resume old");
    const onDream = new FakeTransport("session-followed", HOST);
    onDream.displayOwner = false;
    const dreamResults: PendingLaunchDeliveryResult[] = [];
    const stopDream = observe(onDream, pending, dreamResults);
    onDream.emit("ready");
    await flushDelivery();
    expect(onDream.writes).toHaveLength(0);
    stopDream();

    const onMac = new FakeTransport("session-followed", "mac");
    onMac.displayOwner = false;
    const macResults: PendingLaunchDeliveryResult[] = [];
    observe(onMac, pending, macResults);
    onMac.emit("ready");
    await flushDelivery();
    onMac.emitDisplay(true);
    await flushDelivery();
    expect(onMac.writes).toHaveLength(0);
    expect(macResults).toEqual([{ status: "missing" }]);

    const backOnDream = new FakeTransport("session-followed", HOST);
    observe(backOnDream, pending, []);
    backOnDream.emit("ready");
    await flushDelivery();
    expect(backOnDream.writes).toHaveLength(0);
  });

  test("a view on another host that holds the display drops the launch rather than typing it", async () => {
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-elsewhere", HOST, "claude --resume old");
    // Even where nothing dropped it on attachment, it is never handed over.
    const { observe: _dropsOnAttach, ...claimOnly } = pending;
    const transport = new FakeTransport("session-elsewhere", "mac");
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, claimOnly, results);
    transport.emit("ready");
    await flushDelivery();
    expect(transport.writes).toHaveLength(0);
    expect(results).toEqual([{ status: "elsewhere" }]);
  });

  test("does not type into a view that is not ready, whoever holds the display", async () => {
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-owner-early", HOST, "codex");
    const transport = new FakeTransport("session-owner-early");
    const results: PendingLaunchDeliveryResult[] = [];
    observe(transport, pending, results);

    transport.emit("connecting");
    transport.emitDisplay(true);
    await flushDelivery();
    expect(transport.writes).toHaveLength(0);

    transport.emit("ready");
    await flushDelivery();
    expect(transport.writes).toHaveLength(1);
  });

  test("does not resend when ready is emitted after a reconnect", async () => {
    const storage = new MemoryStorage();
    const pending = createPendingLaunchStore(storage);
    await pending.persist("session-2", HOST, "claude");
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
    await pending.persist("session-shared", HOST, "claude");
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
    await pending.persist("session-3", HOST, "opencode");
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
    await expect(pending.take("session-3", HOST)).resolves.toEqual({ status: "missing" });
  });

  test("abandons an expired record instead of writing it", async () => {
    const storage = new MemoryStorage();
    let now = 100;
    const pending = createPendingLaunchStore(storage, { now: () => now, ttlMs: 50 });
    await pending.persist("session-4", HOST, "aider");
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
    await createPendingLaunchStore(storage).persist("session-5", HOST, "TOKEN=secret codex");

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
        hostId: HOST,
        command: "claude",
        createdAt: 1,
        expiresAt: 2,
      }),
      take: async () => {
        await gate.promise;
        return {
          status: "ready",
          record: {
            sessionId: "session-6",
            hostId: HOST,
            command: "claude",
            createdAt: 1,
            expiresAt: 2,
          },
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

  test("waits on a provisional record and types it only once it is confirmed", async () => {
    jest.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const pending = createPendingLaunchStore(storage);
      await pending.persist("session-move", HOST, "claude --resume x", { provisional: true });
      const transport = new FakeTransport("session-move");
      const results: PendingLaunchDeliveryResult[] = [];
      observe(transport, pending, results);
      transport.emit("ready");
      await jest.advanceTimersByTimeAsync(PROVISIONAL_RECHECK_MS * 3);
      expect(transport.writes).toHaveLength(0);
      expect(results).toEqual([]);
      await pending.confirm?.("session-move", HOST);
      await jest.advanceTimersByTimeAsync(PROVISIONAL_RECHECK_MS);
      expect(transport.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
        "claude --resume x\r",
      ]);
      expect(results).toEqual([{ status: "sent" }]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a provisional record discarded while it waits is never typed", async () => {
    jest.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const pending = createPendingLaunchStore(storage);
      await pending.persist("session-move", HOST, "claude --resume x", { provisional: true });
      const transport = new FakeTransport("session-move");
      const results: PendingLaunchDeliveryResult[] = [];
      observe(transport, pending, results);
      transport.emit("ready");
      await jest.advanceTimersByTimeAsync(PROVISIONAL_RECHECK_MS);
      await pending.discard?.("session-move", HOST);
      await jest.advanceTimersByTimeAsync(PROVISIONAL_RECHECK_MS * 2);
      expect(transport.writes).toHaveLength(0);
      expect(results).toEqual([{ status: "missing" }]);
    } finally {
      jest.useRealTimers();
    }
  });
});
