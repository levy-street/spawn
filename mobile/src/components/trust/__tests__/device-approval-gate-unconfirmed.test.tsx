import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import { useDeviceApprovalGate } from "@/components/trust/device-approval-gate";
import { invalidateDeviceHostTrust } from "@/data/trust/device-trust";

// #138, on the phone: the real gate, the real host probe and the real
// endpoints and schemas, with only the HTTP client and the sheet's insides
// replaced. A host that has not confirmed an approval must not put the
// approval sheet in front of a phone the account already approved.

const HOST_ID = "00000000-0000-4000-8000-0000000000aa";
const PHONE_ID = "aa03db41-655e-450f-95fe-96464416292a";
const LAPTOP_ID = "b6b3d3d0-4d8b-4f53-9b1f-3a0d9b6f1e21";
// encodeBase64Url of 32 zero bytes: the phone's own key below.
const PHONE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LAPTOP_KEY = "q3Z8V7mT2xQ9bN4cR6sW1yE5uI0oP8aS3dF7gH2jK4l";

jest.mock("@/lib/crypto/identity", () => ({
  activeDeviceIdentityAccount: () => "00000000-0000-4000-8000-000000000001",
  deviceIdentity: { publicKey: async () => new Uint8Array(32) },
}));

const mockWrites: string[] = [];
let mockEdges: unknown[] = [];
jest.mock("@/data/api/client", () => ({
  api: jest.fn(
    async (
      path: string,
      init: { method?: string; schema?: { parse: (value: unknown) => unknown } } = {},
    ) => {
      if (init.method !== undefined && init.method !== "GET") {
        mockWrites.push(`${init.method} ${path}`);
        return {};
      }
      const parse = (value: unknown) => (init.schema ? init.schema.parse(value) : value);
      if (path === "/api/browser-devices") {
        return parse(
          [
            [PHONE_ID, PHONE_KEY],
            [LAPTOP_ID, LAPTOP_KEY],
          ].map(([id, key]) => ({
            id,
            key_algorithm: "ed25519",
            public_key: key,
            label: null,
            created_at: "2026-08-22T05:48:37Z",
            revoked_at: null,
          })),
        );
      }
      if (path === "/api/trust/account-endorsements") return parse(mockEdges);
      if (path === `/api/trust/hosts/${HOST_ID}/pins`) {
        // The only pinned device's pin, nacked by a host whose reconcile
        // could not run.
        return parse({
          pins: [{ browser_device_id: LAPTOP_ID, delivered: false, undelivered_reason: "other" }],
          capacity: { used: 1, max: 32 },
        });
      }
      // The host row: only its chain support matters to the probe.
      if (path === `/api/hosts/${HOST_ID}`) return { id: HOST_ID, supports_account_chains: true };
      throw new Error(`unexpected request ${path}`);
    },
  ),
}));

jest.mock("@/components/trust/device-approval-overlay", () => ({
  ...(() => {
    const { Text: MockText } = require("react-native") as typeof import("react-native");
    return {
      DeviceApprovalOverlay: ({ visible }: { visible: boolean }) =>
        visible ? <MockText testID="approval-sheet">Approve this device</MockText> : null,
    };
  })(),
}));

const action = jest.fn();

function Harness() {
  const gate = useDeviceApprovalGate();
  return (
    <>
      <Pressable onPress={() => gate.guard(HOST_ID, action)} testID="do-the-thing">
        <Text>Do the thing</Text>
      </Pressable>
      {gate.overlay}
    </>
  );
}

describe("the device approval gate when a host has not confirmed an approval", () => {
  // The probe shares account-wide reads across a one-second burst; each case
  // starts a minute later so it never sees the previous case's account.
  const realNow = Date.now.bind(Date);
  let offsetMs = 0;
  beforeAll(() => {
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    jest.clearAllMocks();
    offsetMs += 60_000;
    mockWrites.length = 0;
    invalidateDeviceHostTrust();
  });

  test("REGRESSION: an approved phone goes straight on, and nobody is asked", async () => {
    mockEdges = [
      {
        endorser_device_id: LAPTOP_ID,
        endorser_public_key: LAPTOP_KEY,
        endorsed_device_id: PHONE_ID,
        endorsed_public_key: PHONE_KEY,
        signature: "sig",
        created_at: "2026-08-24T05:48:37Z",
      },
    ];
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId("do-the-thing"));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("approval-sheet")).toBeNull();
    expect(mockWrites).toEqual([]);
  });

  test("a phone nobody approved is still asked first", async () => {
    mockEdges = [];
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId("do-the-thing"));
    await waitFor(() => expect(screen.getByTestId("approval-sheet")).toBeOnTheScreen());
    expect(action).not.toHaveBeenCalled();
  });
});
