import { act, fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { onlineHost } from "@/components/hosts/__tests__/fixtures";
import {
  SETUP_STALLED_HINTS,
  SetupChecklist,
  setupChecklistState,
} from "@/components/onboarding/setup-checklist";
import type { SetupClaimStatus } from "@/data/api/schemas/setup";
import { ThemeProvider } from "@/theme";

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  return <ThemeProvider>{children}</ThemeProvider>;
}

function claim(status: SetupClaimStatus["status"]): SetupClaimStatus {
  const ready = status === "ready" || status === "approved";
  return {
    status,
    approval_ref: ready ? "approval-ref-123" : null,
    host_name: ready ? onlineHost.name : null,
    os: ready ? onlineHost.os : null,
    host_key_fingerprint: ready ? "SHA256:host" : null,
    host_id: status === "approved" ? onlineHost.id : null,
    error: null,
    expires_at: "2026-08-25T01:00:00Z",
  };
}

describe("setup claim checklist", () => {
  afterEach(() => jest.useRealTimers());

  it("maps the claim state machine and exact host id to all four steps", () => {
    expect(
      setupChecklistState({ commandCopied: false, claim: claim("pending"), hosts: [] }),
    ).toEqual({ completed: [false, false, false, false], waitingIndex: 0 });
    expect(setupChecklistState({ commandCopied: true, claim: claim("ready"), hosts: [] })).toEqual({
      completed: [true, true, false, false],
      waitingIndex: 2,
    });
    expect(
      setupChecklistState({ commandCopied: true, claim: claim("approved"), hosts: [] }),
    ).toEqual({ completed: [true, true, true, false], waitingIndex: 3 });
    expect(
      setupChecklistState({
        commandCopied: true,
        claim: claim("approved"),
        hosts: [{ ...onlineHost, id: "33333333-3333-4333-8333-333333333333" }, onlineHost],
      }),
    ).toEqual({ completed: [true, true, true, true], waitingIndex: null });
  });

  it.each([
    { status: "pending" as const, hint: SETUP_STALLED_HINTS[0], commandCopied: true },
    { status: "ready" as const, hint: SETUP_STALLED_HINTS[1], commandCopied: true },
    { status: "approved" as const, hint: SETUP_STALLED_HINTS[2], commandCopied: true },
  ])("shows elapsed time and the $status stalled hint", async ({ status, hint, commandCopied }) => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const onExit = jest.fn();
    const screen = await render(
      <SetupChecklist
        claim={claim(status)}
        commandCopied={commandCopied}
        hosts={[]}
        onEnterCode={jest.fn()}
        onExit={onExit}
      />,
      { wrapper },
    );

    await act(async () => jest.advanceTimersByTime(30_000));
    expect(screen.getByText("Elapsed 0:30")).toBeOnTheScreen();
    expect(screen.queryByText(hint)).toBeNull();

    await act(async () => jest.advanceTimersByTime(30_000));
    expect(screen.getByText(hint)).toBeOnTheScreen();
    if (status !== "approved") {
      expect(screen.getByRole("button", { name: "Enter pairing code" })).toBeOnTheScreen();
    } else {
      await fireEvent.press(screen.getByRole("button", { name: "Finish later" }));
      expect(onExit).toHaveBeenCalledTimes(1);
    }
    await screen.unmount();
  });
});
