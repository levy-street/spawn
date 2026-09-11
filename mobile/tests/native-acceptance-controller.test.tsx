import { waitFor } from "@testing-library/react-native";
import { NativeAcceptanceController } from "../e2e/native-controller";
import { renderWithProviders } from "./render";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const LOCAL_KEY_ID = "33333333-3333-4333-8333-333333333333";

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        nativeAcceptance: {
          token: "t".repeat(32),
          candidateCommit: "candidate",
          sourceClean: true,
        },
      },
    },
  },
}));
jest.mock("@/data/api/config", () => ({ getBaseUrl: async () => "http://127.0.0.1:18100" }));
jest.mock("@/data/api/auth-token", () => ({ authToken: { set: jest.fn(async () => {}) } }));
jest.mock("@/data/api/endpoints/account", () => ({
  getMe: async () => ({ user: { id: "11111111-1111-4111-8111-111111111111" } }),
}));
jest.mock("@/data/api/endpoints/auth", () => ({ logOut: jest.fn() }));
jest.mock("@/data/trust/registration", () => ({
  ensureDeviceRegistered: async () => ({ id: "22222222-2222-4222-8222-222222222222" }),
}));
jest.mock("@/lib/auth-gate", () => ({
  useAuthenticatedAccount: () => ({
    ready: true,
    accountId: "11111111-1111-4111-8111-111111111111",
  }),
}));
jest.mock("@/lib/crypto/identity", () => ({
  deviceIdentity: {
    ensure: async () => ({
      publicKey: new Uint8Array(32).fill(7),
      deviceId: "33333333-3333-4333-8333-333333333333",
    }),
  },
  deviceIdentityGeneration: () => 1,
  setDeviceIdentityAccount: jest.fn(),
}));
jest.mock("@/terminal/HostTransportSurface", () => ({ HostTransportSurface: () => null }));
jest.mock("@/terminal/TerminalSurface", () => ({ TerminalSurface: () => null }));
jest.mock("@/terminal/transport/host-transport-registry", () => ({
  retainHostTransport: jest.fn(),
}));

test("boot endorses and reports the server device row instead of the local key ID", async () => {
  const events: Array<{ type: string; status: string; details: { values: unknown } }> = [];
  const approvals: Array<{ deviceId: string; publicKey: string }> = [];
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    let body: unknown = null;
    let status = 200;
    if (path === "/__acceptance/bootstrap") {
      body = { accountId: ACCOUNT_ID, bearerToken: "fixture-token", candidateCommit: "candidate" };
    } else if (path === "/__acceptance/device") {
      const approval = JSON.parse(String(init?.body));
      approvals.push(approval);
      // The real fixture can only endorse the row returned by registration.
      status = approval.deviceId === SERVER_DEVICE_ID ? 200 : 400;
      body = { approved: status === 200 };
    } else if (path === "/__acceptance/event") {
      events.push(JSON.parse(String(init?.body)));
    } else if (path !== "/__acceptance/command") {
      throw new Error(`Unexpected fixture path: ${path}`);
    }
    return new Response(JSON.stringify(body), { status });
  });
  const view = await renderWithProviders(<NativeAcceptanceController />);
  try {
    await waitFor(() => expect(events.some((event) => event.type === "boot")).toBe(true));
    expect(approvals).toEqual([{ deviceId: SERVER_DEVICE_ID, publicKey: expect.any(String) }]);
    expect(approvals[0]?.deviceId).not.toBe(LOCAL_KEY_ID);
    expect(events.find((event) => event.type === "identity")?.details.values).toEqual(
      expect.objectContaining({ deviceId: SERVER_DEVICE_ID }),
    );
    const boot = events.find((event) => event.type === "boot");
    expect(boot?.status).toBe("passed");
    expect(boot?.details.values).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({ deviceId: SERVER_DEVICE_ID }),
      }),
    );
  } finally {
    await view.unmount();
    view.queryClient.clear();
    fetch.mockRestore();
  }
});
