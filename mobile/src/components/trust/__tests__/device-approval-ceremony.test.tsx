import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react-native";

import { DeviceApprovalCeremony } from "@/components/trust/device-approval-ceremony";
import { ThemeProvider } from "@/theme";

const HOST_ID = "00000000-0000-4000-8000-00000000aaaa";
const PHONE_ID = "00000000-0000-4000-8000-00000000bbbb";
// A real curve point, so formatHostFingerprint derives rather than throws.
const PHONE_KEY = "XOCTsSKj9-Z7qRynE70szG_DNBeHiLzEBOCG1clQbz8";

const mockRequestApproval = jest.fn(async (_deviceId: string) => ({}));
jest.mock("@/data/api/endpoints/trust", () => ({
  requestDeviceApproval: (deviceId: string) => mockRequestApproval(deviceId),
}));

jest.mock("@/data/queries/settings", () => ({
  useMeSettingsQuery: () => ({
    data: { user: { id: "00000000-0000-4000-8000-00000000cccc" } },
    isPending: false,
  }),
}));

let mockPhoneQuery: Record<string, unknown> = {};
let mockTrust: "trusted" | "untrusted" = "untrusted";
let mockChainHost = false;
jest.mock("@/data/queries/pairing", () => ({
  useRegisteredPhone: () => mockPhoneQuery,
  useAccountDevices: () => ({
    data: [
      { id: PHONE_ID, public_key: PHONE_KEY, revoked_at: null },
      { id: "other-device", public_key: "other-key", revoked_at: null },
    ],
  }),
  usePendingEndorsements: () => ({ data: [], isFetching: false, refetch: jest.fn() }),
  acceptPairingEndorsement: jest.fn(),
  serverOriginFromBaseUrl: () => "https://spawnd.dev",
}));

jest.mock("@/data/queries/device-trust", () => ({
  useDeviceHostApprovals: () => ({
    approvals: [
      {
        host: { id: HOST_ID, name: "office-mac", supports_account_chains: mockChainHost },
        trust: mockTrust,
      },
    ],
    approved: [],
    awaiting: [],
    resolved: true,
    refetch: jest.fn(),
  }),
}));

jest.mock("@/data/api/config", () => ({
  getBaseUrl: async () => "https://spawnd.dev",
}));

async function renderCeremony() {
  // gcTime 0: the cache's garbage timer is an open handle jest waits out.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <DeviceApprovalCeremony
          hostId={HOST_ID}
          onNavigateToPairing={jest.fn()}
          onRequestClose={jest.fn()}
        />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("device approval ceremony", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTrust = "untrusted";
    mockChainHost = false;
    mockPhoneQuery = {
      data: { id: PHONE_ID, label: "spawn on iPhone", public_key: PHONE_KEY, revoked_at: null },
      isPending: false,
      isSuccess: true,
      isError: false,
    };
  });

  test("raises the knock once as soon as the device can be vouched for", async () => {
    await renderCeremony();
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval).toHaveBeenCalledWith(PHONE_ID);
    expect(screen.getByText(/waiting on your say-so/i)).toBeOnTheScreen();
    // The fingerprint is derived locally from the key, never trusted from data.
    expect(screen.getByText(/^SHA256:/)).toBeOnTheScreen();
  });

  test("does not knock for a host that already trusts this device", async () => {
    mockTrust = "trusted";
    await renderCeremony();
    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(screen.getByText(/this device is approved/i)).toBeOnTheScreen();
  });

  test("a failed registration is said out loud, with a way to retry", async () => {
    const refetch = jest.fn();
    mockPhoneQuery = {
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: true,
      error: new Error("Device identity could not be stored"),
      refetch,
    };
    await renderCeremony();
    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(screen.getByText(/no identity yet/i)).toBeOnTheScreen();
    expect(screen.getByText(/Device identity could not be stored/)).toBeOnTheScreen();
  });

  test("a chain-capable host is approved from another screen too, with the code as fallback", async () => {
    // The knock is answered with an account endorsement, which this device
    // carries to every host anchored on the approving screen (mesh §3) — so
    // the promise holds for chain hosts exactly as for per-host ones.
    mockChainHost = true;
    await renderCeremony();
    expect(mockRequestApproval).toHaveBeenCalledWith(PHONE_ID);
    expect(screen.getByText(/waiting on your say-so/i)).toBeOnTheScreen();
    expect(screen.getByText(/prompt is up on every screen/i)).toBeOnTheScreen();
    expect(screen.queryByText(/takes a pairing code/i)).toBeNull();
    expect(screen.getByText("Enter a pairing code")).toBeOnTheScreen();
  });
});
