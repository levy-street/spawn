import { applyCacheEffects } from "@/data/realtime/provider";

describe("applyCacheEffects", () => {
  it("applies invalidations and safe patches in order while ignoring none effects", async () => {
    const calls: string[] = [];
    const queryClient = {
      invalidateQueries: jest.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        calls.push(`invalidate:${queryKey.join(":")}`);
      }),
      setQueryData: jest.fn((key: readonly unknown[], update: (prev: unknown) => unknown) => {
        calls.push(`patch:${key.join(":")}:${String(update(2))}`);
      }),
    };

    await applyCacheEffects(queryClient as unknown as Parameters<typeof applyCacheEffects>[0], [
      { kind: "invalidate", key: ["sessions"] },
      { kind: "none", reason: "local only" },
      { kind: "patch", key: ["local"], update: (previous) => Number(previous) + 1 },
    ]);

    expect(calls).toEqual(["invalidate:sessions", "patch:local:3"]);
  });
});
