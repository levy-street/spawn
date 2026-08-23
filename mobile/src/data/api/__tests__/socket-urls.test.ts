const mockSocketToken: { value: string | null } = { value: "token with spaces" };

jest.mock("@/data/api/auth-token", () => ({
  authToken: {
    get: jest.fn(async () => mockSocketToken.value),
    set: jest.fn(),
    clear: jest.fn(),
    captureFromResponse: jest.fn(),
  },
}));

jest.mock("@/data/api/config", () => ({
  getBaseUrl: jest.fn(async () => "https://spawn.example.com"),
}));

import {
  buildAlertsSocketUrl,
  buildBrowserSocketUrl,
  buildHostSocketUrl,
} from "@/data/api/socket-urls";

beforeEach(() => {
  mockSocketToken.value = "token with spaces";
});

it("builds an authenticated browser signalling URL", async () => {
  await expect(buildBrowserSocketUrl("session/id")).resolves.toBe(
    "wss://spawn.example.com/ws/browser?session_id=session%2Fid&token=token+with+spaces",
  );
});

it("builds an authenticated host signalling URL", async () => {
  await expect(buildHostSocketUrl("host-id")).resolves.toBe(
    "wss://spawn.example.com/ws/host?host_id=host-id&token=token+with+spaces",
  );
});

it("builds the singleton alerts URL", async () => {
  await expect(buildAlertsSocketUrl()).resolves.toBe(
    "wss://spawn.example.com/ws/alerts?token=token+with+spaces",
  );
});

it("rejects URL construction when signed out", async () => {
  mockSocketToken.value = null;
  await expect(buildAlertsSocketUrl()).rejects.toEqual(
    expect.objectContaining({ status: 401, code: "not_authenticated" }),
  );
});
