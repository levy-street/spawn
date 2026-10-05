import {
  createPendingAgentInputStore,
  decodeMoveArrival,
  encodeMoveArrival,
  type MoveArrival,
} from "@/components/launcher/pending-agent-input";

const arrival: MoveArrival = {
  version: 1,
  agent: "Claude Code",
  to: "mac",
  from: "dream",
  cwd: "~/code/spawn",
  note: {
    text: "[SPAWN D: moved from dream (Linux) to mac (macOS).] ",
    delivery: "typed_no_enter",
  },
  line: "claude --resume 6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60 --permission-mode default",
};

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

describe("what a moved window still owes its agent", () => {
  it("round-trips, and refuses anything else", () => {
    expect(decodeMoveArrival(encodeMoveArrival(arrival))).toEqual(arrival);
    expect(decodeMoveArrival(encodeMoveArrival({ ...arrival, note: null }))?.note).toBeNull();
    expect(decodeMoveArrival("{}")).toBeNull();
    expect(
      decodeMoveArrival(JSON.stringify({ ...arrival, note: { text: "x", delivery: "shout" } })),
    ).toBeNull();
    expect(decodeMoveArrival("not json")).toBeNull();
  });

  it("is kept apart from the resume line, for one incarnation, and claimed once", async () => {
    const storage = memory();
    const store = createPendingAgentInputStore(storage);
    await store.persist("session", "host-b", encodeMoveArrival(arrival));
    expect(
      [...storage.values.keys()].every((key) => key.startsWith("spawn.pendingAgentInput.")),
    ).toBe(true);
    await expect(store.take("session", "host-a")).resolves.toEqual({ status: "elsewhere" });
    await store.persist("session", "host-b", encodeMoveArrival(arrival));
    const read = await store.take("session", "host-b");
    expect(read.status === "ready" && decodeMoveArrival(read.record.command)).toEqual(arrival);
    await expect(store.take("session", "host-b")).resolves.toEqual({ status: "already_delivered" });
  });

  it("lapses with the resume line", async () => {
    let now = 0;
    const store = createPendingAgentInputStore(memory(), { now: () => now });
    await store.persist("session", "host-b", encodeMoveArrival(arrival));
    now = 15 * 60 * 1_000;
    await expect(store.take("session", "host-b")).resolves.toEqual({ status: "stale" });
  });
});
