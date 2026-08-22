import { render } from "@testing-library/react-native";
import type { ComponentProps, PropsWithChildren } from "react";
import { TextInput, type TextInputProps } from "react-native";

import { Field } from "@/components/ui/field";
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

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("Field", () => {
  test("renders a hint and wires its label to the control", async () => {
    const screen = await render(
      <Field hint="We will never share it." label="Email" required nativeID="email-field">
        <TextInput testID="control" />
      </Field>,
      { wrapper },
    );

    expect(screen.getByText("Email", { exact: false })).toBeOnTheScreen();
    expect(screen.getByText("We will never share it.")).toBeOnTheScreen();
    const controlProps = screen.getByTestId("control").props as TextInputProps;
    expect(controlProps.accessibilityLabel).toBe("Email");
    expect(controlProps.accessibilityLabelledBy).toBe("email-field-label");
  });

  test("replaces the hint with an error", async () => {
    const initial = await render(
      <Field hint="Helpful hint" label="Name">
        <TextInput />
      </Field>,
      { wrapper },
    );

    expect(initial.getByTestId("field-helper-slot")).toBeOnTheScreen();
    await initial.rerender(
      <Field error="Name is required." hint="Helpful hint" label="Name">
        <TextInput />
      </Field>,
    );

    expect(initial.queryByText("Helpful hint")).not.toBeOnTheScreen();
    expect(initial.getByText("Name is required.")).toBeOnTheScreen();
    expect(initial.getByTestId("field-helper-slot")).toBeOnTheScreen();
  });

  test("renders no helper row when there is neither hint nor error", async () => {
    const screen = await render(
      <Field label="Name">
        <TextInput />
      </Field>,
      { wrapper },
    );

    expect(screen.queryByTestId("field-helper-slot")).not.toBeOnTheScreen();
  });
});
