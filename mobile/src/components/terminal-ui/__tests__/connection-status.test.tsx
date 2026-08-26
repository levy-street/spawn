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

describe("a terminal blocked on this device's approval", () => {
  // The refusal's code does not survive: once the transport has failed, the
  // next open throws plainly, and that uncoded message is the newest error the
  // banner sees. Reading only that dropped the ceremony and left "Connection
  // failed" in front of someone whose approval was already in flight.
  const STALE = {
    code: "transport_open",
    message: "Terminal transport is in a failed state.",
    retryable: true,
  };

  test("keeps the ceremony and says what is actually being waited on", async () => {
    await render(
      <ThemeProvider>
        <ConnectionStateOverlay
          awaitingApproval
          error={STALE}
          hasEverBeenReady={false}
          onDeviceTrust={jest.fn()}
          onRetry={jest.fn()}
          state="failed"
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("Waiting for approval")).toBeOnTheScreen();
    expect(screen.getByText(/reconnects on its own/i)).toBeOnTheScreen();
    expect(screen.getByText("Approve this device")).toBeOnTheScreen();
    expect(screen.queryByText("Connection failed")).toBeNull();
  });

  test("an ordinary failure is still an ordinary failure", async () => {
    await render(
      <ThemeProvider>
        <ConnectionStateOverlay
          error={STALE}
          hasEverBeenReady={false}
          onDeviceTrust={jest.fn()}
          onRetry={jest.fn()}
          state="failed"
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("Connection failed")).toBeOnTheScreen();
    expect(screen.getByText(STALE.message)).toBeOnTheScreen();
    expect(screen.queryByText("Approve this device")).toBeNull();
  });
});
