import { render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { StyleSheet, View } from "react-native";

import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { borderWidth, lightColors, radii, ThemeProvider } from "@/theme";

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("ListRow", () => {
  test("renders inset by default and honours the full-bleed shape", async () => {
    const screen = await render(
      <View>
        <ListRow title="Inset row" />
        <ListRow shape="fullBleed" title="Full row" />
      </View>,
      { wrapper },
    );

    const insetStyle = StyleSheet.flatten(screen.getByLabelText("Inset row").props["style"]);
    const fullBleedStyle = StyleSheet.flatten(screen.getByLabelText("Full row").props["style"]);

    expect(insetStyle).toMatchObject({ borderRadius: radii.lg, width: "100%" });
    expect(fullBleedStyle).toMatchObject({
      borderRadius: borderWidth.none,
      width: "100%",
    });
  });
});

describe("ListSeparator", () => {
  test("runs edge to edge, with no horizontal offset on either side", async () => {
    const screen = await render(<ListSeparator />, { wrapper });
    const style = StyleSheet.flatten(screen.getByTestId("list-separator").props["style"]);

    expect(style).toMatchObject({
      backgroundColor: lightColors.border,
      height: borderWidth.hairline,
    });
    // A divider that clears one edge but not the other reads as a misalignment.
    for (const offset of [
      "marginLeft",
      "marginRight",
      "marginStart",
      "marginEnd",
      "marginHorizontal",
      "paddingLeft",
      "paddingRight",
      "paddingStart",
      "paddingEnd",
      "paddingHorizontal",
      "left",
      "right",
    ] as const) {
      expect(style[offset]).toBeUndefined();
    }
  });
});
