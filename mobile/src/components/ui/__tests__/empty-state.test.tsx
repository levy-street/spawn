import { render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { StyleSheet } from "react-native";

import { EmptyState } from "@/components/ui/empty-state";
import { borderWidth, lightColors, radii, ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("EmptyState", () => {
  test("always renders on the global bordered container", async () => {
    const screen = await render(
      <EmptyState
        style={{
          backgroundColor: lightColors.background,
          borderWidth: borderWidth.none,
          minHeight: sizing.emptyState.iconPlate,
        }}
        testID="empty-state"
        title="No workspaces"
      />,
      { wrapper },
    );

    const style = StyleSheet.flatten(screen.getByTestId("empty-state").props["style"]);

    expect(style).toMatchObject({
      backgroundColor: lightColors.card,
      borderColor: lightColors.border,
      borderRadius: radii.lg,
      borderWidth: borderWidth.hairline,
      minHeight: sizing.emptyState.containerMinHeight,
      padding: sizing.emptyState.containerPadding,
    });
  });
});
