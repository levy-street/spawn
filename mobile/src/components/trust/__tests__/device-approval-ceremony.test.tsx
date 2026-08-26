import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react-native";

import {
  APPROVED_DWELL_MS,
  DeviceApprovalCeremony,
} from "@/components/trust/device-approval-ceremony";
import { ThemeProvider } from "@/theme";

const HOST_ID = "00000000-0000-4000-8000-00000000aaaa";
const PHONE_ID = "00000000-0000-4000-8000-00000000bbbb";
// A real curve point, so formatHostFingerprint derives rather than throws.
const PHONE_KEY = "XOCTsSKj9-Z7qRynE70szG_DNBeHiLzEBOCG1clQbz8";

const mockRequestApproval = jest.fn(async (_deviceId: string) => ({}));
jest.mock("@/data/api/endpoints/trust", () => ({
  requestDeviceApproval: (deviceId: string) => mockRequestApproval(deviceId),
  listPairings: async () => [],
  listAccountEndorsements: async () => [],
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

let mockCeremonies: Record<string, unknown>[] = [];
jest.mock("@/data/trust/ceremony", () => ({
  useDeviceCeremony: () => ({
    ceremonies: mockCeremonies,
    error: null,
    start: jest.fn(),
    starting: false,
    submitDigits: jest.fn(),
    cancel: jest.fn(),
    dismiss: jest.fn(),
  }),
}));

async function renderCeremony(onRequestClose: () => void = jest.fn()) {
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
          onRequestClose={onRequestClose}
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
    mockCeremonies = [];
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
    // No fingerprint to compare: the approval is the number check now.
    expect(screen.queryByText(/^SHA256:/)).toBeNull();
    expect(screen.getByText("Ask again")).toBeOnTheScreen();
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

  test("a matched number is never contradicted while the host catches up", async () => {
    // The number check is what admits this device; the host probe only
    // notices, a poll later. Showing "has not approved this device" in that
    // gap flashes a refusal at someone who just finished the ceremony — so the
    // hero waits instead of warning.
    mockCeremonies = [
      {
        pairingId: "00000000-0000-4000-8000-00000000dddd",
        role: "new-device",
        peerDeviceId: "other-device",
        phase: "done",
        number: "9728",
        triesLeft: 3,
        entryError: null,
      },
    ];
    await renderCeremony();
    expect(screen.getByText("Finishing up")).toBeOnTheScreen();
    expect(screen.getByText(/picking up the approval/i)).toBeOnTheScreen();
    expect(screen.queryByText(/has not approved this device/i)).toBeNull();
    expect(screen.queryByText(/waiting on your say-so/i)).toBeNull();
    // The ceremony's own result still stands, with its way out.
    expect(screen.getByText("Approved")).toBeOnTheScreen();
  });

  test("approved closes itself, after long enough to read", async () => {
    // The surface underneath is already reconnecting; leaving the sheet up
    // makes the operator dismiss a dialog whose only news is that they can.
    jest.useFakeTimers();
    const onRequestClose = jest.fn();
    mockTrust = "trusted";
    await renderCeremony(onRequestClose);
    expect(onRequestClose).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(APPROVED_DWELL_MS);
    });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  test("a ceremony still running is never closed out from under the operator", async () => {
    jest.useFakeTimers();
    const onRequestClose = jest.fn();
    await renderCeremony(onRequestClose);
    await act(async () => {
      jest.advanceTimersByTime(APPROVED_DWELL_MS * 5);
    });
    expect(onRequestClose).not.toHaveBeenCalled();
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
