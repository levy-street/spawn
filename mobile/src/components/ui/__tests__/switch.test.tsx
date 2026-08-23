import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { Switch } from "@/components/ui/switch";
import { haptics } from "@/lib/haptics";
import { ThemeProvider } from "@/theme";

jest.mock(
  "@/lib/haptics",
  () => ({
    haptics: {
      selection: jest.fn(),
    },
  }),
  { virtual: true },
);

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("Switch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("announces state and fires selection feedback before changing", async () => {
    const onValueChange = jest.fn();
    const screen = await render(
      <Switch
        accessibilityLabel="Notifications"
        onValueChange={onValueChange}
        testID="switch"
        value={false}
      />,
      { wrapper },
    );

    expect(screen.getByRole("switch")).not.toBeChecked();
    await fireEvent.press(screen.getByTestId("switch"));
    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  test("disabled switches do not fire", async () => {
    const onValueChange = jest.fn();
    const screen = await render(
      <Switch disabled onValueChange={onValueChange} testID="switch" value />,
      { wrapper },
    );

    await fireEvent.press(screen.getByTestId("switch"));
    expect(haptics.selection).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
