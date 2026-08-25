jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: { version: "0.1.0", extra: { mobileTree: "client-tree" } },
  },
}));

jest.mock("expo-updates", () => ({
  isEnabled: true,
  runtimeVersion: null,
  checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false })),
  fetchUpdateAsync: jest.fn(async () => undefined),
  reloadAsync: jest.fn(async () => undefined),
}));

import { clientMobileTree, decideMobileUpdate, mobileUpdates } from "@/lib/updates";

describe("mobile update decisions", () => {
  it("distinguishes OTA, native runtime, and current releases", () => {
    expect(
      decideMobileUpdate({
        clientTree: "client",
        serverTree: "server",
        clientRuntime: "0.1.0",
        serverRuntime: "0.1.0",
        hard: false,
      }),
    ).toBe("check-ota");
    expect(
      decideMobileUpdate({
        clientTree: "same",
        serverTree: "same",
        clientRuntime: "0.1.0",
        serverRuntime: "0.2.0",
        hard: false,
      }),
    ).toBe("store");
    expect(
      decideMobileUpdate({
        clientTree: "same",
        serverTree: "same",
        clientRuntime: "0.1.0",
        serverRuntime: "0.1.0",
        hard: false,
      }),
    ).toBe("none");
  });

  it("stays quiet for unknown and dirty soft identities", () => {
    for (const [clientTree, serverTree] of [
      [null, "server"],
      ["client", null],
      ["client-dirty", "server"],
      ["client", "server-dirty"],
    ] as const) {
      expect(
        decideMobileUpdate({
          clientTree,
          serverTree,
          clientRuntime: "0.1.0",
          serverRuntime: "0.1.0",
          hard: false,
        }),
      ).toBe("none");
    }
  });

  it("checks OTA after a hard protocol refusal even when trees match", () => {
    expect(
      decideMobileUpdate({
        clientTree: "same",
        serverTree: "same",
        clientRuntime: "0.1.0",
        serverRuntime: "0.1.0",
        hard: true,
      }),
    ).toBe("check-ota");
  });

  it("reads the stamped tree and falls back to the Expo app version runtime", () => {
    expect(clientMobileTree()).toBe("client-tree");
    expect(mobileUpdates.runtimeVersion).toBe("0.1.0");
    expect(mobileUpdates.isEnabled).toBe(false);
  });
});
