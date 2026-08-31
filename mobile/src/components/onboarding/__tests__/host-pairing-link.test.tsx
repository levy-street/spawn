import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import type { PropsWithChildren } from "react";

import { onlineHost } from "@/components/hosts/__tests__/fixtures";
import { HostPairingStep } from "@/components/onboarding/host-pairing-step";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { PendingPairingCeremony } from "@/data/queries/pairing";
import { ThemeProvider } from "@/theme";

const mockLookupPendingPairing = jest.fn();
let mockHosts: HostOut[] = [];

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

jest.mock("@/data/api/config", () => ({
  ...jest.requireActual("@/data/api/config"),
  getBaseUrl: jest.fn(async () => "https://spawn.example/api"),
}));

jest.mock("@/data/queries/hosts", () => ({
  useHostsQuery: () => ({ data: mockHosts, isPending: false, isError: false }),
}));

jest.mock("@/data/queries/release", () => ({
  useRelease: () => ({
    data: { daemon: { targets: { "windows-x86_64": {} } } },
  }),
}));

jest.mock("@/data/queries/pairing", () => ({
  ...jest.requireActual("@/data/queries/pairing"),
  lookupPendingPairing: (...args: unknown[]) => mockLookupPendingPairing(...args),
  useRegisteredPhone: () => ({
    data: {
      id: "22222222-2222-4222-8222-222222222222",
      key_algorithm: "ed25519",
      public_key: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      label: "SPAWN D on iPhone",
      created_at: "2026-08-25T00:00:00Z",
      revoked_at: null,
    },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
  useAccountDevices: () => ({ data: [], isFetching: false }),
  usePendingEndorsements: () => ({ data: [], isFetching: false, refetch: jest.fn() }),
}));

const CEREMONY: PendingPairingCeremony = {
  identifier: { approval_ref: "approval-ref-123" },
  accountId: "11111111-1111-4111-8111-111111111111",
  serverOrigin: "https://spawn.example",
  hostName: "Studio Mac",
  approvalNonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  hostPublicKey: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
  hostFingerprint: "SHA256:host-fingerprint",
  expiresAtMs: Date.now() + 60_000,
  pinState: "new",
  linkVerifiedHostKey: null,
};

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("HostPairingStep link and machine wait", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHosts = [];
    mockLookupPendingPairing.mockResolvedValue(CEREMONY);
  });

  it("reduces a host-key-verified link to one Approve action", async () => {
    mockLookupPendingPairing.mockResolvedValue({
      ...CEREMONY,
      linkVerifiedHostKey: CEREMONY.hostPublicKey,
    });
    const screen = await render(
      <HostPairingStep
        accountId={ACCOUNT_ID}
        initialApprovalRef="approval-ref-123"
        initialHostKey={CEREMONY.hostPublicKey}
      />,
      { wrapper },
    );

    await waitFor(() =>
      expect(mockLookupPendingPairing).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        serverOrigin: "https://spawn.example",
        approvalRef: "approval-ref-123",
        linkHostKey: CEREMONY.hostPublicKey,
      }),
    );
    expect(await screen.findByRole("button", { name: "Approve Studio Mac" })).toBeOnTheScreen();
    expect(screen.queryByRole("checkbox")).toBeNull();

    await screen.unmount();
  });

  it("requires full comparison when the link has no host key", async () => {
    const screen = await render(
      <HostPairingStep accountId={ACCOUNT_ID} initialApprovalRef="approval-ref-123" />,
      { wrapper },
    );

    expect(await screen.findByRole("checkbox")).toBeOnTheScreen();
    expect(mockLookupPendingPairing).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      serverOrigin: "https://spawn.example",
      approvalRef: "approval-ref-123",
    });

    await screen.unmount();
  });

  it("shows the waiting card after copying the plain command", async () => {
    const screen = await render(<HostPairingStep accountId={ACCOUNT_ID} />, { wrapper });

    expect(
      await screen.findByText("curl -fsSL https://spawn.example/install.sh | sh"),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Copy install command" }));

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      "curl -fsSL https://spawn.example/install.sh | sh",
    );
    expect(await screen.findByText("Waiting for your machine…")).toBeOnTheScreen();

    await screen.unmount();
  });

  it("copies the native Windows command from the resolved server origin", async () => {
    const screen = await render(<HostPairingStep accountId={ACCOUNT_ID} />, { wrapper });

    expect(
      await screen.findByText("curl -fsSL https://spawn.example/install.sh | sh"),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("radio", { name: "Windows" }));
    expect(screen.getByText("Open PowerShell on your PC")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Copy install command" }));

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      "irm https://spawn.example/install.ps1 | iex",
    );
    expect(await screen.findByText("Waiting for your machine…")).toBeOnTheScreen();

    await screen.unmount();
  });

  it("shows standalone success only for a host added after the command action", async () => {
    mockHosts = [onlineHost];
    const onExit = jest.fn();
    const screen = await render(<HostPairingStep accountId={ACCOUNT_ID} onExit={onExit} />, {
      wrapper,
    });

    await fireEvent.press(screen.getByRole("button", { name: "Copy install command" }));
    expect(screen.queryByText("Host approved")).toBeNull();

    const newHost = {
      ...onlineHost,
      id: "33333333-3333-4333-8333-333333333333",
      name: "Studio Mac",
    };
    mockHosts = [onlineHost, newHost];
    await screen.rerender(<HostPairingStep accountId={ACCOUNT_ID} onExit={onExit} />);

    expect(await screen.findByText("Host approved")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Studio Mac is connected. It will appear as soon as its daemon comes online.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Connect another host" })).toBeOnTheScreen();

    await screen.unmount();
  });
});
