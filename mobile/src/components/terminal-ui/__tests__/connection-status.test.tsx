import { render, screen } from "@testing-library/react-native";
import { StyleSheet, type ViewStyle } from "react-native";

import { ConnectionStateOverlay } from "@/components/terminal-ui/connection-status";
import { ThemeProvider } from "@/theme";

function bannerStyle(testID: string): ViewStyle {
  return StyleSheet.flatten(screen.getByTestId(testID).props["style"]) as ViewStyle;
}

describe("the connection banner over a terminal that has been ready", () => {
  test("reads as a bar across the foot, not a floating card", async () => {
    await render(
      <ThemeProvider>
        <ConnectionStateOverlay hasEverBeenReady onRetry={jest.fn()} state="connecting" />
      </ThemeProvider>,
    );

    const style = bannerStyle("connection-state-connecting");
    expect(style.borderRadius).toBeUndefined();
    expect(style.borderWidth).toBeUndefined();
    expect(style.borderTopWidth).toBe(1);
    expect(style.left).toBe(0);
    expect(style.right).toBe(0);
    expect(style.bottom).toBe(0);
  });

  test("the first connection still takes the whole surface, with no rule of its own", async () => {
    await render(
      <ThemeProvider>
        <ConnectionStateOverlay hasEverBeenReady={false} onRetry={jest.fn()} state="connecting" />
      </ThemeProvider>,
    );

    const style = bannerStyle("connection-state-connecting");
    expect(style.borderTopWidth).toBe(0);
    expect(style.position).toBe("absolute");
  });
});
