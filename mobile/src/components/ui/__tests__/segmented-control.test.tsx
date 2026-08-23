import { fireEvent, render } from "@testing-library/react-native";
import type { ComponentProps, PropsWithChildren } from "react";

import { SegmentedControl } from "@/components/ui/segmented-control";
import { haptics } from "@/lib/haptics";
import { ThemeProvider } from "@/theme";

jest.mock(
  "@/components/ui/text",
  () => {
    const { Text } = jest.requireActual("react-native") as typeof import("react-native");
    return {
      Text: ({ color: _color, ...props }: { color?: string } & ComponentProps<typeof Text>) => (
        <Text {...props} />
      ),
    };
  },
  { virtual: true },
);

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

const OPTIONS = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
] as const;

describe("SegmentedControl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("changes selection with haptic feedback", async () => {
    const onChange = jest.fn();
    const screen = await render(
      <SegmentedControl onChange={onChange} options={OPTIONS} value="light" />,
      { wrapper },
    );

    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  test("does not fire for the selected or a disabled option", async () => {
    const onChange = jest.fn();
    const options = [OPTIONS[0], { ...OPTIONS[1], disabled: true }, OPTIONS[2]];
    const screen = await render(
      <SegmentedControl onChange={onChange} options={options} value="light" />,
      { wrapper },
    );

    await fireEvent.press(screen.getByRole("radio", { name: "Light" }));
    await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
    expect(haptics.selection).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
