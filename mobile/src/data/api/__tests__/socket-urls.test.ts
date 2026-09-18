jest.mock("@/data/api/config", () => ({
  getBaseUrl: jest.fn(async () => "https://spawn.example.com"),
}));

import {
  buildAlertsSocketUrl,
  buildBrowserSocketUrl,
  buildHostSocketUrl,
} from "@/data/api/socket-urls";

it("builds a browser signalling URL without leaking the token", async () => {
  await expect(buildBrowserSocketUrl("session/id")).resolves.toBe(
    "wss://spawn.example.com/ws/browser?session_id=session%2Fid",
  );
});

it("builds a host signalling URL without leaking the token", async () => {
  await expect(buildHostSocketUrl("host-id")).resolves.toBe(
    "wss://spawn.example.com/ws/host?host_id=host-id&rtc_version=2",
  );
});

it("builds the singleton alerts URL", async () => {
  await expect(buildAlertsSocketUrl()).resolves.toBe("wss://spawn.example.com/ws/alerts");
});
