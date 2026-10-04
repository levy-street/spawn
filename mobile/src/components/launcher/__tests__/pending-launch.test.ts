import {
  createPendingLaunchStore,
  PENDING_LAUNCH_PROVISIONAL_MS,
  PENDING_LAUNCH_TTL_MS,
  type PendingLaunchStorage,
} from "@/components/launcher/pending-launch";

const HOST = "dream";

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
    await firstProcess.persist("session-1", HOST, command);

    const restartedProcess = createPendingLaunchStore(storage, { now: () => 2_000 });
    await expect(restartedProcess.take("session-1", HOST)).resolves.toEqual({
      status: "ready",
      record: {
        sessionId: "session-1",
        hostId: HOST,
        command,
        createdAt: 1_000,
        expiresAt: 1_000 + PENDING_LAUNCH_TTL_MS,
      },
    });
    await restartedProcess.complete?.("session-1");
    await expect(restartedProcess.take("session-1", HOST)).resolves.toEqual({ status: "missing" });
    expect(storage.values.size).toBe(0);
  });

  test("does not expose a command again after a restart between claim and completion", async () => {
    const storage = new MemoryStorage();
    const firstProcess = createPendingLaunchStore(storage, { now: () => 1_000 });
    await firstProcess.persist("session-claim", HOST, "claude");
    await expect(firstProcess.take("session-claim", HOST)).resolves.toMatchObject({
      status: "ready",
    });

    const restartedProcess = createPendingLaunchStore(storage, { now: () => 2_000 });
    await expect(restartedProcess.take("session-claim", HOST)).resolves.toEqual({
      status: "already_delivered",
    });
    expect(storage.values.size).toBe(0);
  });

  test("serializes competing claims so only one caller receives command bytes", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 100 });
    await store.persist("session-race", HOST, "codex");

    const results = await Promise.all([
      store.take("session-race", HOST),
      store.take("session-race", HOST),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_delivered", "ready"]);
  });

  test("abandons stale persisted commands cleanly", async () => {
    const storage = new MemoryStorage();
    let now = 100;
    const store = createPendingLaunchStore(storage, { now: () => now, ttlMs: 50 });
    await store.persist("session-2", HOST, "claude");
    now = 151;
    await expect(store.take("session-2", HOST)).resolves.toEqual({ status: "stale" });
    expect(storage.values.size).toBe(0);
  });

  test("reports a partially lost record honestly and clears it", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 100 });
    await store.persist("session-3", HOST, "x".repeat(2_000));
    const chunk = [...storage.values.keys()].find((key) => key.endsWith(".0"));
    expect(chunk).toBeDefined();
    if (chunk) storage.values.delete(chunk);

    const result = await store.take("session-3", HOST);
    expect(result.status).toBe("lost");
    if (result.status === "lost") expect(result.reason).toBe("missing_chunk");
    expect(storage.values.size).toBe(0);
  });

  test("clear removes an abandoned pending command", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage);
    await store.persist("session-4", HOST, "opencode");
    await store.clear("session-4");
    await expect(store.take("session-4", HOST)).resolves.toEqual({ status: "missing" });
  });

  test("is typed only into the incarnation it was queued for, and dropped once seen elsewhere", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 100 });
    await store.persist("session-moved", HOST, "claude --resume old");
    // A terminal attached to the window where it was queued keeps it.
    await store.observe?.("session-moved", HOST);
    expect(storage.values.size).toBeGreaterThan(0);
    // One attached to it on another host means the shell it was for is gone.
    await store.observe?.("session-moved", "mac");
    expect(storage.values.size).toBe(0);
    // A move back to dream is another shell there, and finds nothing to type.
    await expect(store.take("session-moved", HOST)).resolves.toEqual({ status: "missing" });
  });

  test("refuses to hand a command to a view on another host, and drops it", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 100 });
    await store.persist("session-elsewhere", HOST, "claude --resume old");
    await expect(store.take("session-elsewhere", "mac")).resolves.toEqual({
      status: "elsewhere",
    });
    expect(storage.values.size).toBe(0);
  });

  test("a launch queued for the window's new host survives a view there", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 100 });
    await store.persist("session-new", HOST, "claude --resume old");
    await store.persist("session-new", "mac", "claude --session-id new");
    await store.observe?.("session-new", "mac");
    await expect(store.take("session-new", "mac")).resolves.toMatchObject({
      status: "ready",
      record: { hostId: "mac", command: "claude --session-id new" },
    });
  });

  test("takes a record an earlier version saved without a host at its word", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 100 });
    await store.persist("session-legacy", HOST, "codex");
    const manifestKey = "spawn.pendingLaunch.session-legacy";
    const manifest = JSON.parse(storage.values.get(manifestKey) ?? "{}");
    delete manifest.hostId;
    storage.values.set(manifestKey, JSON.stringify(manifest));

    await store.observe?.("session-legacy", "mac");
    await expect(store.take("session-legacy", "mac")).resolves.toMatchObject({
      status: "ready",
      record: { hostId: null, command: "codex" },
    });
  });

  test("abandons a command without leaving it eligible for delivery", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage);
    await store.persist("session-5", HOST, "aider");
    await store.abandon?.("session-5");
    await expect(store.take("session-5", HOST)).resolves.toEqual({ status: "missing" });
  });

  test("a provisional record is never typable until confirmed, and is left in place meanwhile", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const store = createPendingLaunchStore(storage, { now: () => now });
    await store.persist("session-move", HOST, "claude --resume x", { provisional: true });
    await expect(store.take("session-move", HOST)).resolves.toEqual({ status: "provisional" });
    // Asked again, still there and still not claimed.
    await expect(store.take("session-move", HOST)).resolves.toEqual({ status: "provisional" });
    await store.confirm?.("session-move", HOST);
    now += 10;
    await expect(store.take("session-move", HOST)).resolves.toMatchObject({
      status: "ready",
      record: { command: "claude --resume x" },
    });
  });

  test("a provisional record survives an app restart unconfirmed: never typed, and it lapses", async () => {
    const storage = new MemoryStorage();
    await createPendingLaunchStore(storage, { now: () => 1_000 }).persist(
      "session-move",
      HOST,
      "claude --resume x",
      { provisional: true },
    );
    const restarted = createPendingLaunchStore(storage, {
      now: () => 1_000 + PENDING_LAUNCH_PROVISIONAL_MS,
    });
    await expect(restarted.take("session-move", HOST)).resolves.toEqual({ status: "stale" });
    expect(storage.values.size).toBe(0);
  });

  test("discard drops only a provisional record for that host", async () => {
    const storage = new MemoryStorage();
    const store = createPendingLaunchStore(storage, { now: () => 1_000 });
    await store.persist("session-move", HOST, "claude --resume x", { provisional: true });
    await store.discard?.("session-move", "elsewhere");
    await expect(store.take("session-move", HOST)).resolves.toEqual({ status: "provisional" });
    await store.discard?.("session-move", HOST);
    await expect(store.take("session-move", HOST)).resolves.toEqual({ status: "missing" });
    // A confirmed one — a restart's resume queued since — is never discarded.
    await store.persist("session-move", HOST, "claude --resume y");
    await store.discard?.("session-move", HOST);
    await expect(store.take("session-move", HOST)).resolves.toMatchObject({ status: "ready" });
  });
});
