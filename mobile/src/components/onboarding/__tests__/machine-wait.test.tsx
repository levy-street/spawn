import { act, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { onlineHost } from "@/components/hosts/__tests__/fixtures";
import { MACHINE_WAIT_STALLED_HINT, MachineWait } from "@/components/onboarding/machine-wait";
import { ThemeProvider } from "@/theme";

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("machine wait", () => {
  afterEach(() => jest.useRealTimers());

  it("shows waiting, elapsed, and the repeat-safe stalled hint", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const screen = await render(<MachineWait host={null} />, { wrapper });

    expect(screen.getByText("Waiting for your machine…")).toBeOnTheScreen();
    expect(screen.queryByTestId("machine-wait-elapsed")).toBeNull();

    await act(async () => jest.advanceTimersByTime(30_000));
    expect(screen.getByText("Elapsed 0:30")).toBeOnTheScreen();
    expect(screen.queryByText(MACHINE_WAIT_STALLED_HINT)).toBeNull();

    await act(async () => jest.advanceTimersByTime(30_000));
    expect(screen.getByText(MACHINE_WAIT_STALLED_HINT)).toBeOnTheScreen();

    await screen.unmount();
  });

  it("reports the machine once it is online", async () => {
    const screen = await render(<MachineWait host={onlineHost} />, { wrapper });

    expect(screen.getByText(`${onlineHost.name} is online.`)).toBeOnTheScreen();
    expect(screen.queryByText("Waiting for your machine…")).toBeNull();

    await screen.unmount();
  });
});
