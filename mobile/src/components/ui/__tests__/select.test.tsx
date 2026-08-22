import { fireEvent, render } from "@testing-library/react-native";
import type { ComponentProps, PropsWithChildren, ReactNode } from "react";
import { Text as NativeText } from "react-native";

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

  test("uses a sheet for many options and supports custom rows", async () => {
    const options = Array.from({ length: 7 }, (_, index) => ({
      label: `Host ${index + 1}`,
      value: `host-${index + 1}`,
    }));
    const renderOption = jest.fn((option: (typeof options)[number]) => (
      <NativeText>{`Custom ${option.label}`}</NativeText>
    ));
    const screen = await render(
      <Select
        onChange={jest.fn()}
        options={options}
        placeholder="Choose host"
        renderOption={renderOption}
        testID="select"
        value="host-1"
      />,
      { wrapper },
    );

    await fireEvent.press(screen.getByTestId("select"));
    expect(screen.getByTestId("sheet")).toBeOnTheScreen();
    expect(screen.getByText("Custom Host 7")).toBeOnTheScreen();
    expect(renderOption).toHaveBeenCalledWith(options[0], { selected: true });
  });
});
