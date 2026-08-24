import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { TrustFailureState } from "@/components/onboarding/trust-failure-state";
import { ThemeProvider } from "@/theme";

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

const FAILURE = { kind: "pairing-rejected", detail: "Device registration was rejected" } as const;

describe("a failed host step is not a dead end", () => {
  it("offers a way past a step that will not complete", async () => {
    const onSkip = jest.fn();
    const screen = await render(
      <TrustFailureState failure={FAILURE} onAction={jest.fn()} onSkip={onSkip} />,
      { wrapper },
    );

    await fireEvent.press(screen.getByText("Set this up later"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("keeps the retry action working alongside it", async () => {
    const onAction = jest.fn();
    const screen = await render(
      <TrustFailureState failure={FAILURE} onAction={onAction} onSkip={jest.fn()} />,
      { wrapper },
    );

    await fireEvent.press(screen.getByText("Try again"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("shows no escape where the caller offers none", async () => {
    // The button appears only when a caller actually has somewhere to send
    // you; surfaces with their own navigation out do not need it.
    const screen = await render(<TrustFailureState failure={FAILURE} onAction={jest.fn()} />, {
      wrapper,
    });
    expect(screen.queryByText("Set this up later")).toBeNull();
  });

  it("surfaces the underlying reason, not just the headline", async () => {
    const screen = await render(<TrustFailureState failure={FAILURE} onAction={jest.fn()} />, {
      wrapper,
    });
    expect(screen.getByText("Device registration was rejected")).toBeOnTheScreen();
  });
});
