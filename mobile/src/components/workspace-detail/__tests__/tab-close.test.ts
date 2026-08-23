import { deleteSessionsForTab } from "@/components/workspace-detail/use-workspace-actions";

describe("tab close session deletion", () => {
  it("waits for every session deletion and reports failure before layout removal can continue", async () => {
    const failure = new Error("session stayed alive");
    let finishSecond: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const removeSession = jest.fn((sessionId: string) =>
      sessionId === "one" ? Promise.reject(failure) : second,
    );
    let settled = false;

    const deletion = deleteSessionsForTab(["one", "two"], removeSession);
    void deletion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();

    expect(removeSession).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    finishSecond?.();
    await expect(deletion).rejects.toBe(failure);
    expect(settled).toBe(true);
  });

  it("resolves only after all sessions have been removed", async () => {
    const removeSession = jest.fn(async () => undefined);

    await expect(deleteSessionsForTab(["one", "two"], removeSession)).resolves.toBeUndefined();
    expect(removeSession).toHaveBeenCalledTimes(2);
  });
});
