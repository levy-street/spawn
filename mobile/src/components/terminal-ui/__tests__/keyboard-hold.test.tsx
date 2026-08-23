import { act, render } from "@testing-library/react-native";
import { View } from "react-native";

import { useTerminalKeyboardHold } from "@/components/terminal-ui/keyboard-hold";

const mockDismiss = jest.fn(async () => undefined);
const mockKeyboard = { visible: true };

jest.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: () => mockDismiss() },
  useKeyboardState: (selector: (state: { isVisible: boolean }) => unknown) =>
    selector({ isVisible: mockKeyboard.visible }),
}));

function Harness({
  held,
  onHold,
  onRelease,
}: {
  held: boolean;
  onHold: () => void;
  onRelease: () => void;
}) {
  useTerminalKeyboardHold({ held, onHold, onRelease });
  return <View testID="harness" />;
}

async function mount(held: boolean) {
  const onHold = jest.fn();
  const onRelease = jest.fn();
  const view = await render(<Harness held={held} onHold={onHold} onRelease={onRelease} />);
  const heldRef = { held };
  const set = async (next: boolean) => {
    heldRef.held = next;
    await act(async () => {
      await view.rerender(<Harness held={next} onHold={onHold} onRelease={onRelease} />);
    });
  };
  // useKeyboardState re-renders on a real keyboard change; the fake needs a nudge.
  const refresh = () => set(heldRef.held);
  return { onHold, onRelease, refresh, set, view };
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe("terminal keyboard hold", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockKeyboard.visible = true;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("stands the keyboard down for a drawer and puts it back on close", async () => {
    const { onHold, onRelease, set } = await mount(false);

    await set(true);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();

    mockKeyboard.visible = false;
    await set(false);
    // The drawer is still animating out, so nothing is asked for yet.
    expect(onRelease).not.toHaveBeenCalled();

    await settle(200);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  test("keeps asking until the keyboard actually comes back", async () => {
    const { onRelease, refresh, set } = await mount(false);
    await set(true);
    mockKeyboard.visible = false;
    await set(false);

    // Focus asked for over a drawer still on screen is swallowed.
    await settle(200);
    await settle(200);
    expect(onRelease).toHaveBeenCalledTimes(2);

    mockKeyboard.visible = true;
    await refresh();
    await settle(400);
    expect(onRelease).toHaveBeenCalledTimes(2);
  });

  test("gives up rather than asking forever", async () => {
    const { onRelease, set } = await mount(false);
    await set(true);
    mockKeyboard.visible = false;
    await set(false);

    await settle(10_000);
    expect(onRelease).toHaveBeenCalledTimes(6);
  });

  test("a drawer opening mid-restore calls off the restore", async () => {
    const { onRelease, set } = await mount(false);
    await set(true);
    mockKeyboard.visible = false;
    await set(false);
    await set(true);

    await settle(10_000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  test("leaves a quiet terminal quiet", async () => {
    mockKeyboard.visible = false;
    const { onHold, onRelease, set } = await mount(false);

    await set(true);
    expect(onHold).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();

    // Nothing was taken away, so nothing is owed back.
    await set(false);
    await settle(10_000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  test("one drawer opening straight into another holds once", async () => {
    const { onHold, onRelease, set } = await mount(false);

    await set(true);
    // Two open drawers still read as one held keyboard.
    await set(true);
    expect(onHold).toHaveBeenCalledTimes(1);

    mockKeyboard.visible = false;
    await set(false);
    await settle(200);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  test("never raises a keyboard over whatever screen comes next", async () => {
    const { onRelease, view } = await mount(true);
    await act(async () => {
      await view.unmount();
    });
    await settle(10_000);

    expect(onRelease).not.toHaveBeenCalled();
  });
});
