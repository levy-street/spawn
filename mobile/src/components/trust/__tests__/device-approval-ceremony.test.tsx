import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import {
  APPROVED_DWELL_MS,
  DeviceApprovalCeremony,
} from "@/components/trust/device-approval-ceremony";
import { DeviceIdentityError } from "@/lib/crypto/identity";
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
  return client;
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
    expect(screen.getByText(/waiting for approval/i)).toBeOnTheScreen();
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

  test("a failed registration is said in the reader's terms, with a way to retry", async () => {
    const refetch = jest.fn();
    mockPhoneQuery = {
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: true,
      error: new DeviceIdentityError(
        "IDENTITY_STORAGE_UNAVAILABLE",
        "Device identity could not be stored",
      ),
      refetch,
    };
    const client = await renderCeremony();
    const resetQueries = jest.spyOn(client, "resetQueries");
    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(screen.getByText(/identity storage is unavailable/i)).toBeOnTheScreen();
    // The cause, not the internal sentence that threw.
    expect(screen.getByText(/could not save SPAWN D's identity key/i)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText(/try again/i));
    expect(resetQueries).toHaveBeenCalledWith({
      queryKey: ["browser-device-registration", "00000000-0000-4000-8000-00000000cccc"],
    });
  });

  test("a corrupt identity offers a fresh start instead of a futile retry", async () => {
    mockPhoneQuery = {
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: true,
      error: new DeviceIdentityError("IDENTITY_CORRUPT", "Device identity record is not an object"),
      refetch: jest.fn(),
    };
    await renderCeremony();
    expect(screen.getAllByText(/unreadable/i)).not.toHaveLength(0);
    // Pressing Try again would run the same read into the same damaged record.
    expect(screen.queryByText(/try again/i)).toBeNull();
    expect(screen.getByText(/start fresh on this phone/i)).toBeOnTheScreen();
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
    expect(screen.queryByText(/waiting for approval/i)).toBeNull();
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

  test("a chain-capable host is approved from another screen too, with host connect as fallback", async () => {
    // The knock is answered with an account endorsement, which this device
    // carries to every host anchored on the approving screen (mesh §3) — so
    // the promise holds for chain hosts exactly as for per-host ones.
    mockChainHost = true;
    await renderCeremony();
    expect(mockRequestApproval).toHaveBeenCalledWith(PHONE_ID);
    expect(screen.getByText(/waiting for approval/i)).toBeOnTheScreen();
    expect(screen.getByText(/request is waiting on every screen/i)).toBeOnTheScreen();
    expect(screen.getByText("Connect a host")).toBeOnTheScreen();
  });

  test("explains an automatic tombstone recovery while continuing approval", async () => {
    mockPhoneQuery = {
      data: {
        id: PHONE_ID,
        identityRecovery: "device_key_revoked",
        label: "SPAWN D on iPhone",
        public_key: PHONE_KEY,
        revoked_at: null,
      },
      isPending: false,
      isSuccess: true,
      isError: false,
    };
    await renderCeremony();
    expect(screen.getByText(/old key was revoked.*created a fresh identity/i)).toBeOnTheScreen();
    expect(mockRequestApproval).toHaveBeenCalledWith(PHONE_ID);
  });
});
