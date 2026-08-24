import Constants from "expo-constants";

import { registerPushDevice, unregisterPushDevice } from "@/data/api/endpoints/notifications";
import {
  registerForPushNotifications,
  resetPushRegistration,
  unregisterForPushNotifications,
} from "@/lib/push";

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: {} }, easConfig: null },
}));
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
}));
jest.mock("@/data/api/endpoints/notifications", () => ({
  registerPushDevice: jest.fn(),
  unregisterPushDevice: jest.fn(),
}));

const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

function withProjectId(id: string | undefined): void {
  const constants = Constants as unknown as { expoConfig: unknown; easConfig: unknown };
  constants.expoConfig = { extra: id === undefined ? {} : { eas: { projectId: id } } };
  constants.easConfig = null;
}

function granted(token = TOKEN) {
  return {
    getPermissionsAsync: jest.fn().mockResolvedValue({ status: "granted" }),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ status: "granted" }),
    getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: token }),
  };
}

const DEVICE_ID = "00000000-0000-4000-8000-000000000123";

beforeEach(() => {
  jest.clearAllMocks();
  resetPushRegistration();
  withProjectId("project-abc");
});

describe("registerForPushNotifications", () => {
  it("registers the token this install was issued", async () => {
    const api = granted();
    jest.mocked(registerPushDevice).mockResolvedValue({
      id: "d-1",
      platform: "ios",
      label: null,
      created_at: "2026-08-24T00:00:00Z",
      last_seen_at: "2026-08-24T00:00:00Z",
    });

    const result = await registerForPushNotifications({ api });

    expect(api.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "project-abc" });
    expect(registerPushDevice).toHaveBeenCalledWith({
      token: TOKEN,
      platform: "ios",
      browser_device_id: null,
    });
    expect(result).toEqual({ status: "registered", token: TOKEN });
  });

  it("asks for permission the first time, and registers once it is granted", async () => {
    // Nobody else ever asks; an install that skipped this never got a push.
    const api = {
      getPermissionsAsync: jest.fn().mockResolvedValue({ status: "undetermined" }),
      requestPermissionsAsync: jest.fn().mockResolvedValue({ status: "granted" }),
      getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: TOKEN }),
    };
    (registerPushDevice as jest.Mock).mockResolvedValue({ id: "d1" });
    await expect(registerForPushNotifications({ api })).resolves.toEqual({
      status: "registered",
      token: TOKEN,
    });
    expect(api.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it("respects a refusal at the system prompt", async () => {
    const api = {
      getPermissionsAsync: jest.fn().mockResolvedValue({ status: "undetermined" }),
      requestPermissionsAsync: jest.fn().mockResolvedValue({ status: "denied" }),
      getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: TOKEN }),
    };
    await expect(registerForPushNotifications({ api })).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(api.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it("registers the token against this install's trust identity, once per pairing", async () => {
    const api = granted();
    (registerPushDevice as jest.Mock).mockResolvedValue({ id: "d1" });
    await registerForPushNotifications({ api, browserDeviceId: null });
    expect(registerPushDevice).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: TOKEN, browser_device_id: null }),
    );
    // The identity lands later; the token is re-registered carrying it.
    await registerForPushNotifications({ api, browserDeviceId: DEVICE_ID });
    expect(registerPushDevice).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: TOKEN, browser_device_id: DEVICE_ID }),
    );
    // The same pairing again is a no-op: the server already knows.
    await registerForPushNotifications({ api, browserDeviceId: DEVICE_ID });
    expect(registerPushDevice).toHaveBeenCalledTimes(2);
  });

  it("does nothing in a build with no EAS project to address", async () => {
    withProjectId(undefined);
    const api = granted();

    const result = await registerForPushNotifications({ api });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("EAS project id"),
    });
    // Expo Go has no project id; that is a fact about the build, not a failure
    // worth asking the OS about.
    expect(api.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it("does not ask for a token without permission", async () => {
    const api = {
      getPermissionsAsync: jest.fn().mockResolvedValue({ status: "denied" }),
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn(),
    };

    const result = await registerForPushNotifications({ api });

    expect(result).toMatchObject({ status: "unavailable" });
    expect(api.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it("reports a device the push service will not issue a token for", async () => {
    const api = {
      getPermissionsAsync: jest.fn().mockResolvedValue({ status: "granted" }),
      requestPermissionsAsync: jest.fn(),
      getExpoPushTokenAsync: jest.fn().mockRejectedValue(new Error("simulator")),
    };

    expect(await registerForPushNotifications({ api })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("push token"),
    });
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it("reports a server that refuses the registration", async () => {
    const api = granted();
    jest.mocked(registerPushDevice).mockRejectedValue(new Error("401"));

    expect(await registerForPushNotifications({ api })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("did not accept"),
    });
  });
});

describe("unregisterForPushNotifications", () => {
  it("drops the registration this process made", async () => {
    const api = granted();
    jest.mocked(registerPushDevice).mockResolvedValue({
      id: "d-1",
      platform: "ios",
      label: null,
      created_at: "2026-08-24T00:00:00Z",
      last_seen_at: "2026-08-24T00:00:00Z",
    });
    await registerForPushNotifications({ api });

    await unregisterForPushNotifications();

    expect(unregisterPushDevice).toHaveBeenCalledWith(TOKEN);
  });

  it("says nothing when this install never registered", async () => {
    await unregisterForPushNotifications();
    expect(unregisterPushDevice).not.toHaveBeenCalled();
  });

  it("never lets a failed cleanup block a sign-out", async () => {
    const api = granted();
    jest.mocked(registerPushDevice).mockResolvedValue({
      id: "d-1",
      platform: "ios",
      label: null,
      created_at: "2026-08-24T00:00:00Z",
      last_seen_at: "2026-08-24T00:00:00Z",
    });
    await registerForPushNotifications({ api });
    jest.mocked(unregisterPushDevice).mockRejectedValue(new Error("offline"));

    await expect(unregisterForPushNotifications()).resolves.toBeUndefined();
  });
});
