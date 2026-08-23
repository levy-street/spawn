import * as Haptics from "expo-haptics";

import { haptics, setEnabled } from "@/lib/haptics";

describe("haptics", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    setEnabled(false);
    setEnabled(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("maps the public vocabulary to Expo haptics", () => {
    haptics.selection();
    haptics.impact("light");
    haptics.impact("medium");
    haptics.impact("heavy");
    haptics.success();
    haptics.warning();
    haptics.error();

    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(1, Haptics.ImpactFeedbackStyle.Light);
    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(2, Haptics.ImpactFeedbackStyle.Medium);
    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(3, Haptics.ImpactFeedbackStyle.Heavy);
    expect(Haptics.notificationAsync).toHaveBeenNthCalledWith(
      1,
      Haptics.NotificationFeedbackType.Success,
    );
    expect(Haptics.notificationAsync).toHaveBeenNthCalledWith(
      2,
      Haptics.NotificationFeedbackType.Warning,
    );
    expect(Haptics.notificationAsync).toHaveBeenNthCalledWith(
      3,
      Haptics.NotificationFeedbackType.Error,
    );
  });

  it("maps overlay semantics to light open and medium dismiss impacts", () => {
    haptics.overlayOpen();
    haptics.overlayDismiss();

    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(1, Haptics.ImpactFeedbackStyle.Light);
    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(2, Haptics.ImpactFeedbackStyle.Medium);
  });

  it("stays silent while disabled", () => {
    setEnabled(false);

    haptics.selection();
    haptics.success();
    haptics.impact("heavy");

    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  it("collapses identical feedback within 50 milliseconds", () => {
    jest.setSystemTime(1_000);
    haptics.selection();
    jest.advanceTimersByTime(49);
    haptics.selection();
    jest.advanceTimersByTime(1);
    haptics.selection();

    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(2);
  });

  it("does not collapse different feedback types", () => {
    haptics.impact("light");
    haptics.impact("medium");
    haptics.success();

    expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  });

  it("swallows asynchronous native rejections", async () => {
    jest.mocked(Haptics.notificationAsync).mockRejectedValueOnce(new Error("unsupported"));

    expect(() => haptics.error()).not.toThrow();
    await Promise.resolve();
  });

  it("swallows synchronous native failures", () => {
    jest.mocked(Haptics.impactAsync).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });

    expect(() => haptics.impact("heavy")).not.toThrow();
  });
});
