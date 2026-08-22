import {
  createPendingLaunchStore,
  PENDING_LAUNCH_TTL_MS,
  type PendingLaunchStorage,
} from "@/components/launcher/pending-launch";

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

describe("pending agent launches", () => {
  test("survives a simulated app restart and is consumed exactly once", async () => {
    const storage = new MemoryStorage();
    const firstProcess = createPendingLaunchStore(storage, { now: () => 1_000 });
    const command = `TOKEN='${"secret ".repeat(400)}' codex`;
    await firstProcess.persist("session-1", command);

    const restartedProcess = createPendingLaunchStore(storage, { now: () => 2_000 });
    await expect(restartedProcess.take("session-1")).resolves.toEqual({
      status: "ready",
      record: {
        sessionId: "session-1",
        command,
        createdAt: 1_000,
        expiresAt: 1_000 + PENDING_LAUNCH_TTL_MS,
      },
    });
    await restartedProcess.complete?.("session-1");
    await expect(restartedProcess.take("session-1")).resolves.toEqual({ status: "missing" });
    expect(storage.values.size).toBe(0);
  });

  test("does not expose a command again after a restart between claim and completion", async () => {
    const storage = new MemoryStorage();
    const firstProcess = createPendingLaunchStore(storage, { now: () => 1_000 });
    await firstProcess.persist("session-claim", "claude");
    await expect(firstProcess.take("session-claim")).resolves.toMatchObject({ status: "ready" });

    const restartedProcess = createPendingLaunchStore(storage, { now: () => 2_000 });
    await expect(restartedProcess.take("session-claim")).resolves.toEqual({
      status: "already_delivered",
    });
    expect(storage.values.size).toBe(0);
  });

  test("serializes competing claims so only one caller receives command bytes", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 100 });
    await store.persist("session-race", "codex");

    const results = await Promise.all([store.take("session-race"), store.take("session-race")]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_delivered", "ready"]);
  });

  test("abandons stale persisted commands cleanly", async () => {
    const storage = new MemoryStorage();
    let now = 100;
    const store = createPendingLaunchStore(storage, { now: () => now, ttlMs: 50 });
    await store.persist("session-2", "claude");
    now = 151;
    await expect(store.take("session-2")).resolves.toEqual({ status: "stale" });
    expect(storage.values.size).toBe(0);
  });

  test("reports a partially lost record honestly and clears it", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 100 });
    await store.persist("session-3", "x".repeat(2_000));
    const chunk = [...storage.values.keys()].find((key) => key.endsWith(".0"));
    expect(chunk).toBeDefined();
    if (chunk) storage.values.delete(chunk);

    const result = await store.take("session-3");
    expect(result.status).toBe("lost");
    if (result.status === "lost") expect(result.reason).toBe("missing_chunk");
    expect(storage.values.size).toBe(0);
  });

  test("clear removes an abandoned pending command", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage);
    await store.persist("session-4", "opencode");
    await store.clear("session-4");
    await expect(store.take("session-4")).resolves.toEqual({ status: "missing" });
  });

  test("abandons a command without leaving it eligible for delivery", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage);
    await store.persist("session-5", "aider");
    await store.abandon?.("session-5");
    await expect(store.take("session-5")).resolves.toEqual({ status: "missing" });
  });
});
