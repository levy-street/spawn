import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { HostPairingStep, INLINE_APPROVE_LEAD } from "@/components/onboarding/host-pairing-step";
import type { PendingPairingCeremony } from "@/data/queries/pairing";
import { ThemeProvider } from "@/theme";

const mockLookupPendingPairing = jest.fn();
const mockCreateClaimReset = jest.fn();
let mockClaimMintMode: "ready" | "unsupported" = "ready";

jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));

jest.mock("@/data/api/config", () => ({
  ...jest.requireActual("@/data/api/config"),
  getBaseUrl: jest.fn(async () => "https://spawn.example/api"),
}));

jest.mock("@/data/queries/hosts", () => ({
  useHostsQuery: () => ({ data: [], isPending: false, isError: false }),
}));

jest.mock("@/data/queries/setup", () => ({
  useCreateSetupClaimMutation: () => ({
    isError: mockClaimMintMode === "unsupported",
    isPending: false,
    reset: mockCreateClaimReset,
    mutate: (
      _value: undefined,
      callbacks: { onSuccess(value: { token: string }): void; onError(error: unknown): void },
    ) => {
      if (mockClaimMintMode === "ready") callbacks.onSuccess({ token: "t".repeat(43) });
      else {
        const { ApiError } = jest.requireActual(
          "@/data/api/client",
        ) as typeof import("@/data/api/client");
        callbacks.onError(new ApiError(404, "not_found", "Not Found"));
      }
    },
  }),
  useSetupClaimQuery: (token: string | null) => ({
    data:
      token === null
        ? undefined
        : {
            status: "ready",
            approval_ref: "approval-ref-123",
            host_name: "Studio Mac",
            os: "macos",
            host_key_fingerprint: "SHA256:host",
            host_id: null,
            error: null,
            expires_at: "2026-08-25T01:00:00Z",
          },
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

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("HostPairingStep setup claim", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimMintMode = "ready";
    mockLookupPendingPairing.mockResolvedValue(CEREMONY);
  });

  it("pre-fills FingerprintReview from pending approval_ref", async () => {
    const screen = await render(
      <HostPairingStep accountId="11111111-1111-4111-8111-111111111111" />,
      { wrapper },
    );

    await waitFor(() =>
      expect(mockLookupPendingPairing).toHaveBeenCalledWith(
        expect.objectContaining({ approvalRef: "approval-ref-123" }),
      ),
    );
    expect(await screen.findByText(INLINE_APPROVE_LEAD)).toBeOnTheScreen();
    expect(screen.getByRole("checkbox")).toBeOnTheScreen();
    await screen.unmount();
  });

  it("falls back to today's bare command with retry recovery when claims return 404", async () => {
    mockClaimMintMode = "unsupported";
    const screen = await render(
      <HostPairingStep accountId="11111111-1111-4111-8111-111111111111" />,
      { wrapper },
    );

    expect(
      await screen.findByText("curl -fsSL https://spawn.example/install.sh | sh"),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId("setup-checklist")).toBeNull();
    expect(
      screen.getByText(
        "Live setup progress could not start. The install command still works — approve the host from the link its terminal prints.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(mockCreateClaimReset).toHaveBeenCalledTimes(2);
    expect(mockLookupPendingPairing).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
