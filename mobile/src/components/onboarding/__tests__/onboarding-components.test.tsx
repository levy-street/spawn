import { act, fireEvent, render } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import type { PropsWithChildren } from "react";
import {
  DEFAULT_INSTALL_COMMAND,
  installTargetsForBaseUrl,
} from "@/components/longtail/public-content";
import { FingerprintReview } from "@/components/onboarding/fingerprint-review";
import { InstallInstructions } from "@/components/onboarding/install-instructions";
import { PairingCountdown } from "@/components/onboarding/pairing-countdown";
import { PairingSuccess } from "@/components/onboarding/pairing-success";
import { FAILURE_COPY, TrustFailureState } from "@/components/onboarding/trust-failure-state";
import {
  type PairingFailureKind,
  type PendingPairingCeremony,
  pairingFailureForProtocolError,
} from "@/data/queries/pairing";
import { presentShareSheet } from "@/lib/share";
import { ThemeProvider } from "@/theme";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

jest.mock("@/lib/share", () => ({
  presentShareSheet: jest.fn(async () => ({ action: "sharedAction" })),
}));

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

const FAILURE_TITLES = {
  "fingerprint-mismatch": "Fingerprints do not match",
  "identity-missing": "Phone identity is missing",
  "identity-revoked": "Phone identity was revoked",
  "identity-storage-unavailable": "Phone identity storage is unavailable",
  "pin-revoked": "This host identity was revoked",
  "pin-storage-unavailable": "Trust storage is unavailable",
  "pairing-expired": "Approval expired",
  "pairing-denied": "Approval was declined",
  "key-conflict": "This machine belongs to another account",
  "pin-conflict": "Earlier approval does not match",
  "pin-limit": "Approval limit reached",
  "link-identity-mismatch": "This host could not be verified",
  "link-identity-malformed": "This host could not be verified",
  "approval-not-found": "Approval not found",
  "host-not-ready": "Host proof is still pending",
  "approval-incomplete": "Server approval did not complete",
  "endorsement-invalid": "Endorsement could not be verified",
  "host-limit": "Host limit reached",
  "pairing-rejected": "Host approval was blocked",
} as const satisfies Record<PairingFailureKind, string>;

const CEREMONY: PendingPairingCeremony = {
  identifier: { approval_ref: "ref-QZ4K7HMT" },
  accountId: "11111111-1111-4111-8111-111111111111",
  serverOrigin: "https://spawn.example.com",
  hostName: "Studio Mac",
  approvalNonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  hostPublicKey: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
  hostFingerprint: "SHA256:host-fingerprint",
  expiresAtMs: 60_000,
  pinState: "new",
  linkVerifiedHostKey: null,
};

describe("onboarding security states", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it.each(Object.entries(FAILURE_TITLES) as [PairingFailureKind, string][])(
    "renders a distinct fail-closed %s state",
    async (kind, title) => {
      const screen = await render(<TrustFailureState failure={{ kind }} onAction={jest.fn()} />, {
        wrapper,
      });

      expect(screen.getByTestId(`trust-failure-${kind}`)).toBeOnTheScreen();
      expect(screen.getByText(title)).toBeOnTheScreen();
      expect(screen.queryByText(/continue anyway/iu)).not.toBeOnTheScreen();
      await screen.unmount();
    },
  );

  it.each([
    [
      "expired",
      "pairing-expired",
      "That approval expired. On the machine, run spawnd possess again.",
    ],
    [
      "denied",
      "pairing-denied",
      "The approval was declined in the browser. Nothing was registered.",
    ],
    [
      "key_conflict",
      "key-conflict",
      [
        "This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.",
        "• To use it under that account: sign in there and approve as usual.",
        "• To hand it to this account: remove the host from the old account's Hosts page first, then run spawnd possess again.",
        "• To keep both accounts on this machine: spawnd possess --new-account",
      ].join("\n"),
    ],
    [
      "pin_conflict",
      "pin-conflict",
      "The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.",
    ],
    [
      "pin_limit",
      "pin-limit",
      "This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.",
    ],
  ] as const)("maps %s to the exact shared failure sentence", (wire, kind, description) => {
    expect(pairingFailureForProtocolError(wire)).toEqual({ kind });
    expect(FAILURE_COPY[kind].description).toBe(description);
  });

  it("copies the exact install command", async () => {
    const screen = await render(<InstallInstructions />, { wrapper });

    await fireEvent.press(screen.getByLabelText("Copy install command"));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(DEFAULT_INSTALL_COMMAND);
    await screen.unmount();
  });

  it("offers the truthful WSL target before native availability", async () => {
    const screen = await render(<InstallInstructions />, { wrapper });

    expect(screen.queryByRole("radio", { name: "Windows" })).toBeNull();
    await fireEvent.press(screen.getByRole("radio", { name: "Windows (WSL)" }));
    expect(screen.getByText("On that computer, paste this into a terminal")).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText("Copy install command"));
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(
      'wsl -- bash -c "curl -fsSL https://spawnd.dev/install.sh | sh"',
    );
    await screen.unmount();
  });

  it("selects native Windows with contextual PowerShell copy", async () => {
    const onCommandCopied = jest.fn();
    const targets = installTargetsForBaseUrl("https://spawn.example/api", true);
    const screen = await render(
      <InstallInstructions onCommandCopied={onCommandCopied} targets={targets} />,
      { wrapper },
    );

    expect(screen.getByText("Choose the computer you're installing on.")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "macOS / Linux" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Windows" })).not.toBeChecked();
    // WSL is the fallback, so a server with a native Windows daemon does not
    // also offer the route through a Linux environment inside Windows.
    expect(screen.queryByRole("radio", { name: "Windows (WSL)" })).toBeNull();

    await fireEvent.press(screen.getByRole("radio", { name: "Windows" }));
    expect(screen.getByText("On that computer, paste this into a terminal")).toBeOnTheScreen();
    expect(screen.getByText("irm https://spawn.example/install.ps1 | iex")).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText("Copy install command"));
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(
      "irm https://spawn.example/install.ps1 | iex",
    );

    await fireEvent.press(screen.getByRole("button", { name: "Share install command" }));
    expect(presentShareSheet).toHaveBeenLastCalledWith({
      message: "irm https://spawn.example/install.ps1 | iex",
    });
    expect(onCommandCopied).toHaveBeenCalledTimes(2);
    await screen.unmount();
  });

  it("counts sharing the command as the first setup action", async () => {
    const onCommandCopied = jest.fn();
    const screen = await render(<InstallInstructions onCommandCopied={onCommandCopied} />, {
      wrapper,
    });

    await fireEvent.press(screen.getByRole("button", { name: "Share install command" }));
    expect(presentShareSheet).toHaveBeenCalledWith({ message: DEFAULT_INSTALL_COMMAND });
    expect(onCommandCopied).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("does not offer manual approval entry after installation", async () => {
    const screen = await render(<InstallInstructions />, { wrapper });

    expect(
      screen.getByText(
        "A host is a computer SPAWN D opens terminals on — usually your own Mac, Linux, or Windows machine.",
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        "When the install finishes it prints a link. Open it on this phone or scan the QR code.",
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Already running SPAWN D for another account on that machine? Run spawnd possess --new-account instead.",
      ),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole("button", { name: ["Enter", "pairing", "code"].join(" ") }),
    ).toBeNull();
    await screen.unmount();
  });

  it("builds all available install targets for the configured server", () => {
    expect(
      installTargetsForBaseUrl("https://spawn.example/api", true).map((target) => target.command),
    ).toEqual([
      "curl -fsSL https://spawn.example/install.sh | sh",
      "irm https://spawn.example/install.ps1 | iex",
    ]);
  });

  it("transitions the countdown into the expired state", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const onExpired = jest.fn();
    const screen = await render(<PairingCountdown deadlineMs={12_000} onExpired={onExpired} />, {
      wrapper,
    });

    expect(screen.getByText("0:02")).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("0:00")).toBeOnTheScreen();
    expect(onExpired).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("requires a deliberate fingerprint confirmation before approval", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const onApprove = jest.fn();
    const screen = await render(
      <FingerprintReview
        approving={false}
        ceremony={CEREMONY}
        onApprove={onApprove}
        onBack={jest.fn()}
        onExpired={jest.fn()}
        onMismatch={jest.fn()}
        phoneFingerprint="SHA256:phone-fingerprint"
      />,
      { wrapper },
    );

    await fireEvent.press(screen.getByRole("button", { name: "Fingerprint matches, approve" }));
    expect(onApprove).not.toHaveBeenCalled();
    await fireEvent.press(
      screen.getByRole("checkbox", {
        name: "I compared the host fingerprint and it matches",
      }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Fingerprint matches, approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("reduces an exact link-carried host-key match to one Approve action", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const onApprove = jest.fn();
    const screen = await render(
      <FingerprintReview
        approving={false}
        ceremony={{ ...CEREMONY, linkVerifiedHostKey: CEREMONY.hostPublicKey }}
        onApprove={onApprove}
        onBack={jest.fn()}
        onExpired={jest.fn()}
        onMismatch={jest.fn()}
        phoneFingerprint="SHA256:phone-fingerprint"
      />,
      { wrapper },
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("The fingerprint does not match")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Approve Studio Mac" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("requires the reciprocal phone fingerprint comparison before completion", async () => {
    const onConfirmed = jest.fn();
    const screen = await render(
      <PairingSuccess
        hostName="Studio Mac"
        onConfirmed={onConfirmed}
        onMismatch={jest.fn()}
        onPairAnother={jest.fn()}
        phoneFingerprint="SHA256:phone-fingerprint"
      />,
      { wrapper },
    );

    await fireEvent.press(screen.getByRole("button", { name: "Comparison complete" }));
    expect(onConfirmed).not.toHaveBeenCalled();
    await fireEvent.press(
      screen.getByRole("checkbox", { name: "The machine shows this phone fingerprint" }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Comparison complete" }));
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Host approved")).toBeOnTheScreen();
  });
});
