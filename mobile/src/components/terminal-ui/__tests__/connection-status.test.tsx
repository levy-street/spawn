import { fireEvent, render, screen } from "@testing-library/react-native";

import { ConnectionStateOverlay, connectionCopy } from "@/components/terminal-ui/connection-status";
import type { TransportState } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";

const STATES: readonly TransportState[] = [
  "idle",
  "signalling",
  "connecting",
  "ready",
  "reconnecting",
  "closed",
  "failed",
];

describe("connection-state rendering", () => {
  test.each(STATES)("renders an honest %s presentation", async (state) => {
    const copy = connectionCopy(state);
    await render(
      <ThemeProvider>
        <ConnectionStateOverlay hasEverBeenReady={false} onRetry={jest.fn()} state={state} />
      </ThemeProvider>,
    );

    // The header chip is gone: the overlay is the single place a connection
    // reports itself, so there is nothing to say the same thing twice.
    expect(screen.queryByTestId("terminal-connection-chip")).toBeNull();
    if (state === "ready") {
      expect(screen.queryByTestId("connection-state-ready")).not.toBeOnTheScreen();
    } else {
      expect(screen.getAllByText(copy.title)[0]).toBeOnTheScreen();
      expect(screen.getByTestId(`connection-state-${state}`)).toBeOnTheScreen();
    }
  });

  test("shows the retryable reason and retry action", async () => {
    const onRetry = jest.fn();
    await render(
      <ThemeProvider>
        <ConnectionStateOverlay
          error={{ code: "ice", message: "The direct path timed out.", retryable: true }}
          hasEverBeenReady
          onRetry={onRetry}
          state="reconnecting"
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("The direct path timed out.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
