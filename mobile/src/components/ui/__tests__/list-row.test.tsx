import { render } from "@testing-library/react-native";
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
});

describe("ListSeparator", () => {
  test.each([
    [undefined, sizing.listRow.separatorInset],
    [true, sizing.listRow.separatorInset],
    [false, sizing.listRow.separatorFullBleed],
  ] as const)("uses inset %s with the matching leading clearance", async (inset, marginLeft) => {
    const screen = await render(
      inset === undefined ? <ListSeparator /> : <ListSeparator inset={inset} />,
      { wrapper },
    );
    const style = StyleSheet.flatten(screen.getByTestId("list-separator").props["style"]);

    expect(style).toMatchObject({
      backgroundColor: lightColors.border,
      height: borderWidth.hairline,
      marginLeft,
    });
  });
});
