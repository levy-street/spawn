import { type ToastRecord, toastQueueReducer } from "@/components/ui/toast";

function toast(id: string, overrides: Partial<ToastRecord> = {}): ToastRecord {
  return {
    id,
    message: `Message ${id}`,
    variant: "default",
    durationMs: 5_000,
    expiresAt: 10_000,
    leaving: false,
    ...overrides,
  };
}

describe("toastQueueReducer", () => {
  test("stacks distinct notices in arrival order", () => {
    const first = toastQueueReducer([], { type: "enqueue", toast: toast("one") });
    const second = toastQueueReducer(first, { type: "enqueue", toast: toast("two") });
    expect(second.map((item) => item.id)).toEqual(["one", "two"]);
  });

  test("refreshes an exact live duplicate without adding a row", () => {
    const initial = toast("one", { message: "Connected", detail: "Workspace", expiresAt: 100 });
    const next = toastQueueReducer([initial], {
      type: "enqueue",
      toast: toast("new-id", {
        message: "Connected",
        detail: "Workspace",
        durationMs: 8_000,
        expiresAt: 9_000,
      }),
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "one", durationMs: 8_000, expiresAt: 9_000 });
  });

  test("variant and detail participate in duplicate identity", () => {
    const initial = toast("one", { message: "Connection changed" });
    const error = toastQueueReducer([initial], {
      type: "enqueue",
      toast: toast("two", { message: "Connection changed", variant: "error" }),
    });
    const detailed = toastQueueReducer(error, {
      type: "enqueue",
      toast: toast("three", { message: "Connection changed", detail: "Host A" }),
    });
    expect(detailed).toHaveLength(3);
  });

  test("keeps the newest five live notices", () => {
    const queue = ["one", "two", "three", "four", "five", "six"].reduce<ToastRecord[]>(
      (state, id) => toastQueueReducer(state, { type: "enqueue", toast: toast(id) }),
      [],
    );
    expect(queue.map((item) => item.id)).toEqual(["two", "three", "four", "five", "six"]);
  });

  test("does not coalesce into a row that is already leaving", () => {
    const leaving = toast("one", { message: "Saved", leaving: true });
    const next = toastQueueReducer([leaving], {
      type: "enqueue",
      toast: toast("two", { message: "Saved" }),
    });
    expect(next.map((item) => item.id)).toEqual(["one", "two"]);
  });

  test("marks, removes, and clears notices independently", () => {
    const initial = [toast("one"), toast("two")];
    const dismissed = toastQueueReducer(initial, { type: "dismiss", id: "one" });
    expect(dismissed.find((item) => item.id === "one")?.leaving).toBe(true);
    expect(toastQueueReducer(dismissed, { type: "remove", id: "one" })).toEqual([initial[1]]);
    expect(toastQueueReducer(initial, { type: "clear" })).toEqual([]);
  });
});
