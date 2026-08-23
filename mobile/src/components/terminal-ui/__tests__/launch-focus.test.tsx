import { act, render } from "@testing-library/react-native";
import { useRef } from "react";
import { View } from "react-native";

import { LAUNCH_FOCUS_DELAY_MS, useLaunchAutoFocus } from "@/components/terminal-ui/launch-focus";

interface HarnessProps {
  focused: boolean;
  held: boolean;
  onFocus: () => void;
  arm: { current: (() => void) | null };
}

function Harness({ arm, focused, held, onFocus }: HarnessProps) {
  const armLaunchFocus = useLaunchAutoFocus({ focused, held, onFocus });
  const slot = useRef(arm);
  slot.current.current = armLaunchFocus;
  return <View testID="harness" />;
}

async function mount(initial: { focused: boolean; held: boolean }) {
  const onFocus = jest.fn();
  const arm: { current: (() => void) | null } = { current: null };
  let state = initial;
  const view = await render(<Harness arm={arm} onFocus={onFocus} {...state} />);
  const set = async (next: Partial<typeof initial>) => {
    state = { ...state, ...next };
    await act(async () => {
      await view.rerender(<Harness arm={arm} onFocus={onFocus} {...state} />);
    });
  };
  const deliver = async () => {
    await act(async () => {
      arm.current?.();
    });
  };
  return { deliver, onFocus, set, view };
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe("terminal launch auto focus", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("stays quiet until a launch is actually delivered", async () => {
    const { onFocus } = await mount({ focused: true, held: false });
    await settle(LAUNCH_FOCUS_DELAY_MS * 4);
    expect(onFocus).not.toHaveBeenCalled();
  });

  test("raises the keyboard once the agent command has gone out", async () => {
    const { deliver, onFocus } = await mount({ focused: true, held: false });

    await deliver();
    expect(onFocus).not.toHaveBeenCalled();

    await settle(LAUNCH_FOCUS_DELAY_MS);
    expect(onFocus).toHaveBeenCalledTimes(1);

    await settle(LAUNCH_FOCUS_DELAY_MS * 4);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  test("waits for the terminal to be the screen on top", async () => {
    const { deliver, onFocus, set } = await mount({ focused: false, held: false });

    await deliver();
    await settle(LAUNCH_FOCUS_DELAY_MS * 2);
    expect(onFocus).not.toHaveBeenCalled();

    await set({ focused: true });
    await settle(LAUNCH_FOCUS_DELAY_MS);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  test("does not rise behind an open drawer", async () => {
    const { deliver, onFocus, set } = await mount({ focused: true, held: true });

    await deliver();
    await settle(LAUNCH_FOCUS_DELAY_MS * 2);
    expect(onFocus).not.toHaveBeenCalled();

    await set({ held: false });
    await settle(LAUNCH_FOCUS_DELAY_MS);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  test("drops the request when the screen leaves before the delay elapses", async () => {
    const { deliver, onFocus, set } = await mount({ focused: true, held: false });

    await deliver();
    await settle(LAUNCH_FOCUS_DELAY_MS / 2);
    await set({ focused: false });
    await settle(LAUNCH_FOCUS_DELAY_MS * 2);
    expect(onFocus).not.toHaveBeenCalled();
  });
});
