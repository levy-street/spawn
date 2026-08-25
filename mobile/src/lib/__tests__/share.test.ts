import { act, renderHook } from "@testing-library/react-native";
import { Share } from "react-native";

import { presentShareSheet, useShareSheetOpen } from "@/lib/share";

describe("presentShareSheet", () => {
  afterEach(() => jest.restoreAllMocks());

  test("reports the sheet as up for exactly as long as it is presented", async () => {
    let settle: (action: { action: "dismissedAction" }) => void = () => undefined;
    jest.spyOn(Share, "share").mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { result } = await renderHook(() => useShareSheetOpen());
    expect(result.current).toBe(false);

    let presented: Promise<unknown> = Promise.resolve();
    await act(async () => {
      presented = presentShareSheet({ message: "hello" });
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
    expect(Share.share).toHaveBeenCalledWith({ message: "hello" }, undefined);

    await act(async () => {
      settle({ action: "dismissedAction" });
      await presented;
    });
    expect(result.current).toBe(false);
  });

  test("steps the chrome back in even when the sheet fails to present", async () => {
    jest.spyOn(Share, "share").mockRejectedValue(new Error("no window"));
    const { result } = await renderHook(() => useShareSheetOpen());

    await act(async () => {
      await expect(presentShareSheet({ message: "hello" })).rejects.toThrow("no window");
    });
    expect(result.current).toBe(false);
  });
});
