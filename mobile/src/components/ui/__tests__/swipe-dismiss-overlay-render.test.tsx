import { render } from "@testing-library/react-native";
import { StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { dismissNavigationOverlays } from "@/components/nav/overlay-dismiss";
import { SwipeDismissOverlay } from "@/components/ui/swipe-dismiss-overlay";
import { darkTheme, ThemeProvider } from "@/theme";

const INSETS = { bottom: 34, left: 0, right: 0, top: 59 };

function overlay(onDismiss: () => void) {
  return (
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <ThemeProvider>
        <SwipeDismissOverlay onDismiss={onDismiss} visible>
          <View />
        </SwipeDismissOverlay>
      </ThemeProvider>
    </SafeAreaInsetsContext.Provider>
  );
}

describe("SwipeDismissOverlay presentation", () => {
  it("clips the moving panel to the shared overlay radius", async () => {
    const screen = await render(overlay(jest.fn()));
    const style = StyleSheet.flatten(
      screen.getByTestId("swipe-dismiss-overlay-panel").props["style"],
    );

    expect(style.borderRadius).toBe(darkTheme.radii.xxl);
    expect(style.overflow).toBe("hidden");
  });

  it("allows primary navigation to close every mounted overlay", async () => {
    const onDismiss = jest.fn();
    const screen = await render(overlay(onDismiss));

    expect(dismissNavigationOverlays()).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await screen.unmount();
    expect(dismissNavigationOverlays()).toBe(false);
  });
});
