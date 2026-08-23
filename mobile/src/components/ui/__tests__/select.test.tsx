import { fireEvent, render } from "@testing-library/react-native";
import type { ComponentProps, PropsWithChildren, ReactNode } from "react";

import { Select } from "@/components/ui/select";
import { ThemeProvider } from "@/theme";

jest.mock("@/components/ui/action-sheet", () => {
  const { Pressable, Text, View } = jest.requireActual(
    "react-native",
  ) as typeof import("react-native");
  return {
    ActionSheet: ({
      actions,
      visible,
    }: {
      actions: Array<{ id: string; label: string; onPress: () => void }>;
      visible: boolean;
    }) =>
      visible ? (
        <View testID="action-sheet">
          {actions.map((action) => (
            <Pressable accessibilityLabel={action.label} key={action.id} onPress={action.onPress}>
              <Text>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null,
  };
});

jest.mock("@/components/ui/sheet", () => {
  const { ScrollView, Text, View } = jest.requireActual(
    "react-native",
  ) as typeof import("react-native");
  return {
    Sheet: ({ children, visible }: { children: ReactNode; visible: boolean }) =>
      visible ? <View testID="sheet">{children}</View> : null,
    SheetHeader: ({ title }: { title: string }) => <Text>{title}</Text>,
    SheetScrollView: ScrollView,
  };
});

jest.mock("@/components/ui/icon", () => ({ Icon: () => null }));

jest.mock("@/components/ui/text", () => {
  const { Text } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Text: ({
      color: _color,
      variant: _variant,
      ...props
    }: ComponentProps<typeof Text> & { color?: string; variant?: string }) => <Text {...props} />,
  };
});

jest.mock("@/lib/haptics", () => ({
  haptics: {
    selection: jest.fn(),
  },
}));

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

const FEW_OPTIONS = [
  { label: "Alpha", value: "alpha" },
  { label: "Beta", value: "beta" },
] as const;

describe("Select", () => {
  test("opens an action sheet for a few options and changes value", async () => {
    const onChange = jest.fn();
    const screen = await render(
      <Select
        accessibilityLabel="Workspace"
        onChange={onChange}
        options={FEW_OPTIONS}
        placeholder="Choose workspace"
        testID="select"
        value={null}
      />,
      { wrapper },
    );

    expect(screen.queryByTestId("action-sheet")).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("select"));
    expect(screen.getByTestId("action-sheet")).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText("Beta"));
    expect(onChange).toHaveBeenCalledWith("beta");
    expect(screen.queryByTestId("action-sheet")).not.toBeOnTheScreen();
  });

  test("uses a scrolling sheet for many options and marks the current one", async () => {
    const options = Array.from({ length: 7 }, (_, index) => ({
      label: `Host ${index + 1}`,
      value: `host-${index + 1}`,
    }));
    const onChange = jest.fn();
    const screen = await render(
      <Select
        onChange={onChange}
        options={options}
        placeholder="Choose host"
        testID="select"
        value="host-1"
      />,
      { wrapper },
    );

    await fireEvent.press(screen.getByTestId("select"));
    expect(screen.getByTestId("sheet")).toBeOnTheScreen();
    expect(screen.getByText("Host 7")).toBeOnTheScreen();

    // The long list presents the same drawer rows as the short one: a choice
    // reports itself as a radio and the current value carries the tick.
    const current = screen.getByLabelText("Host 1");
    expect(current.props["accessibilityRole"]).toBe("radio");
    expect(current.props["accessibilityState"]).toMatchObject({ checked: true });
    expect(screen.getByLabelText("Host 2").props["accessibilityState"]).toMatchObject({
      checked: false,
    });

    await fireEvent.press(screen.getByLabelText("Host 7"));
    expect(onChange).toHaveBeenCalledWith("host-7");
  });
});
