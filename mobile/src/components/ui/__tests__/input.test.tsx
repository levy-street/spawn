import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import type { TextInput, TextInputProps } from "react-native";

import { getInputPurposeConfig, Input, type InputPurpose } from "@/components/ui/input";
import { ThemeProvider } from "@/theme";

jest.mock(
  "@/components/ui/icon",
  () => ({
    Icon: () => null,
  }),
  { virtual: true },
);

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

const PURPOSES: InputPurpose[] = [
  "email",
  "password",
  "newPassword",
  "oneTimeCode",
  "url",
  "path",
  "name",
  "search",
  "plain",
];

describe("Input", () => {
  test.each(PURPOSES)("applies the complete %s purpose configuration", async (purpose) => {
    const screen = await render(<Input purpose={purpose} testID="input" />, { wrapper });
    const input = screen.getByTestId("input");
    const inputProps = input.props as TextInputProps;
    const config = getInputPurposeConfig(purpose);

    expect(inputProps.autoCapitalize).toBe(config.autoCapitalize);
    expect(inputProps.autoCorrect).toBe(config.autoCorrect);
    expect(inputProps.spellCheck).toBe(config.spellCheck);
    expect(inputProps.keyboardType).toBe(config.keyboardType);
    expect(inputProps.textContentType).toBe(config.textContentType);
    expect(inputProps.autoComplete).toBe(config.autoComplete);
    expect(inputProps.smartInsertDelete).toBe(config.smartInsertDelete);
    expect(inputProps.secureTextEntry).toBe(config.secureTextEntry);
  });

  test("allows an explicit native text-input prop to override its purpose default", async () => {
    const screen = await render(
      <Input purpose="email" autoCapitalize="characters" autoCorrect testID="input" />,
      { wrapper },
    );

    const inputProps = screen.getByTestId("input").props as TextInputProps;
    expect(inputProps.autoCapitalize).toBe("characters");
    expect(inputProps.autoCorrect).toBe(true);
  });

  test("reveals and hides password text", async () => {
    const screen = await render(<Input purpose="password" testID="input" />, { wrapper });

    expect((screen.getByTestId("input").props as TextInputProps).secureTextEntry).toBe(true);
    await fireEvent.press(screen.getByLabelText("Show password"));
    expect((screen.getByTestId("input").props as TextInputProps).secureTextEntry).toBe(false);
    await fireEvent.press(screen.getByLabelText("Hide password"));
    expect((screen.getByTestId("input").props as TextInputProps).secureTextEntry).toBe(true);
  });

  test("calls the submit callback and focuses nextRef", async () => {
    const onSubmitEditing = jest.fn();
    const focus = jest.fn();
    const nextRef = { current: { focus } as unknown as TextInput };
    const screen = await render(
      <Input
        nextRef={nextRef}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="next"
        testID="input"
      />,
      { wrapper },
    );

    await fireEvent(screen.getByTestId("input"), "submitEditing", {
      nativeEvent: { text: "first" },
    });

    expect(onSubmitEditing).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe("Input rule variant", () => {
  test("swaps the plate for a rule and keeps the value on the sheet's own margin", async () => {
    const screen = await render(<Input testID="input" variant="rule" />, { wrapper });

    expect(screen.getByTestId("input-rule")).toBeTruthy();
    expect(screen.queryByTestId("input-focus-halo")).toBeNull();
    expect(screen.getByTestId("input")).toHaveStyle({ paddingHorizontal: 0 });
  });

  test("keeps the plated field's halo when no rule was asked for", async () => {
    const screen = await render(<Input testID="input" />, { wrapper });

    expect(screen.getByTestId("input-focus-halo")).toBeTruthy();
    expect(screen.queryByTestId("input-rule")).toBeNull();
  });
});
