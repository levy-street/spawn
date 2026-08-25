import { render, within } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { StyleSheet, View } from "react-native";

import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { borderWidth, lightColors, radii, ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

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

  test("an action trailing sits on the title's line, whatever else the row holds", async () => {
    const screen = await render(
      <ListRow
        body={<View testID="body" />}
        leading={<View testID="leading" />}
        subtitle="two lines of subtitle copy that stand under the title"
        title="Machine"
        trailing={<View testID="action" />}
        trailingPlacement="action"
      />,
      { wrapper },
    );

    const slot = screen.getByTestId("action").parent;
    if (!slot) throw new Error("The action has no slot.");
    const slotStyle = StyleSheet.flatten(slot.props["style"]);
    // The slot is exactly one title line tall, so the control centres on it
    // rather than on a block the leading glyph or the subtitle made taller.
    expect(slotStyle).toMatchObject({ height: sizing.type.rowLabel.lineHeight });
    // And it shares that line with the title itself, and with nothing else.
    const line = slot.parent;
    if (!line) throw new Error("The action's slot has no line.");
    expect(within(line).getByText("Machine")).toBeOnTheScreen();
    expect(within(line).queryByText(/subtitle copy/)).toBeNull();
    expect(within(line).queryByTestId("leading")).toBeNull();
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
