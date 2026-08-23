import { createKeyboardFitGate } from "@/components/terminal-ui/keyboard-fit-gate";

describe("keyboard transition fit gate", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("never refits during a keyboard transition", () => {
    const fit = jest.fn();
    const gate = createKeyboardFitGate(fit, 100);
    gate.beginTransition();
    gate.requestFit();
    jest.advanceTimersByTime(1_000);
    expect(fit).not.toHaveBeenCalled();

    gate.endTransition();
    jest.advanceTimersByTime(99);
    expect(fit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  test("coalesces repeated stable-layout requests", () => {
    const fit = jest.fn();
    const gate = createKeyboardFitGate(fit, 100);
    gate.requestFit();
    jest.advanceTimersByTime(50);
    gate.requestFit();
    jest.advanceTimersByTime(99);
    expect(fit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  test("dispose cancels pending work", () => {
    const fit = jest.fn();
    const gate = createKeyboardFitGate(fit, 100);
    gate.requestFit();
    gate.dispose();
    jest.runAllTimers();
    expect(fit).not.toHaveBeenCalled();
  });
});
