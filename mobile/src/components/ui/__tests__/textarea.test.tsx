import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import type { TextInputProps } from "react-native";

import { Textarea } from "@/components/ui/textarea";
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

describe("Textarea", () => {
  test("grows to content and becomes scrollable at its maximum", async () => {
    const screen = await render(<Textarea minHeight={60} maxHeight={120} testID="textarea" />, {
      wrapper,
    });
    const input = screen.getByTestId("textarea");
    const inputProps = () => screen.getByTestId("textarea").props as TextInputProps;

    await fireEvent(input, "contentSizeChange", {
      nativeEvent: { contentSize: { height: 96 } },
    });
    expect(input.parent).toHaveStyle({ height: 96 });
    expect(inputProps().scrollEnabled).toBe(false);

    await fireEvent(input, "contentSizeChange", {
      nativeEvent: { contentSize: { height: 180 } },
    });
    expect(input.parent).toHaveStyle({ height: 120 });
    expect(inputProps().scrollEnabled).toBe(true);
  });

  test("uses the path keyboard configuration", async () => {
    const screen = await render(<Textarea purpose="path" testID="textarea" />, { wrapper });
    const input = screen.getByTestId("textarea");
    const inputProps = input.props as TextInputProps;

    expect(inputProps.autoCapitalize).toBe("none");
    expect(inputProps.autoCorrect).toBe(false);
    expect(inputProps.smartInsertDelete).toBe(false);
    expect(inputProps.autoComplete).toBe("off");
  });
});
