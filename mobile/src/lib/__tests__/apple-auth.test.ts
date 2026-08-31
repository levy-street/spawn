import { Platform } from "react-native";

import { signInWithApple } from "@/data/api/endpoints/auth";
import { isAppleSignInAvailable, signInWithAppleNatively } from "@/lib/apple-auth";

jest.mock("expo-apple-authentication", () => ({
  isAvailableAsync: jest.fn(),
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
jest.mock("@/data/api/endpoints/auth", () => ({ signInWithApple: jest.fn() }));

const token = {
  access_token: "jwt",
  user: {
    id: "u-1",
    email: "operator@example.com",
    created_at: "2026-08-24T00:00:00Z",
    email_verified_at: null,
    is_admin: false,
    // Null is what a deployment without billing sends, and the shape both
    // sign-in paths seed the me-cache from.
    billing: null,
  },
};

beforeEach(() => jest.clearAllMocks());

describe("isAppleSignInAvailable", () => {
  it("is false off iOS, whatever the module claims", async () => {
    Platform.OS = "android";
    const api = { isAvailableAsync: jest.fn().mockResolvedValue(true) };
    expect(await isAppleSignInAvailable(api)).toBe(false);
    expect(api.isAvailableAsync).not.toHaveBeenCalled();
    Platform.OS = "ios";
  });

  it("defers to the module on iOS", async () => {
    Platform.OS = "ios";
    expect(
      await isAppleSignInAvailable({ isAvailableAsync: jest.fn().mockResolvedValue(true) }),
    ).toBe(true);
    expect(
      await isAppleSignInAvailable({ isAvailableAsync: jest.fn().mockResolvedValue(false) }),
    ).toBe(false);
  });

  it("is false rather than throwing when the check itself fails", async () => {
    Platform.OS = "ios";
    const api = { isAvailableAsync: jest.fn().mockRejectedValue(new Error("no")) };
    expect(await isAppleSignInAvailable(api)).toBe(false);
  });
});

describe("signInWithAppleNatively", () => {
  it("sends the identity token straight up and returns the session", async () => {
    const api = {
      signInAsync: jest.fn().mockResolvedValue({ identityToken: "apple.id.token" }),
    };
    jest.mocked(signInWithApple).mockResolvedValue(token);

    const outcome = await signInWithAppleNatively({ api });

    expect(signInWithApple).toHaveBeenCalledWith({ identity_token: "apple.id.token" });
    expect(outcome).toEqual({ status: "signed-in", token });
  });

  it("asks only for the email, which is the only claim the server stores", async () => {
    const api = {
      signInAsync: jest.fn().mockResolvedValue({ identityToken: "apple.id.token" }),
    };
    jest.mocked(signInWithApple).mockResolvedValue(token);
    await signInWithAppleNatively({ api });

    expect(api.signInAsync).toHaveBeenCalledWith({ requestedScopes: [1] });
  });

  it("treats the user dismissing the sheet as a cancellation", async () => {
    const api = {
      signInAsync: jest.fn().mockRejectedValue({ code: "ERR_REQUEST_CANCELED" }),
    };
    expect(await signInWithAppleNatively({ api })).toEqual({ status: "cancelled" });
    expect(signInWithApple).not.toHaveBeenCalled();
  });

  it("reports a sheet failure that is not a cancellation", async () => {
    const api = { signInAsync: jest.fn().mockRejectedValue(new Error("sheet blew up")) };
    expect(await signInWithAppleNatively({ api })).toEqual({
      status: "failed",
      message: "sheet blew up",
    });
  });

  it("refuses a credential with no identity token", async () => {
    const api = { signInAsync: jest.fn().mockResolvedValue({ identityToken: null }) };
    expect(await signInWithAppleNatively({ api })).toMatchObject({
      status: "failed",
      message: expect.stringContaining("identity token"),
    });
    expect(signInWithApple).not.toHaveBeenCalled();
  });

  it("surfaces the server's own refusal", async () => {
    const api = {
      signInAsync: jest.fn().mockResolvedValue({ identityToken: "apple.id.token" }),
    };
    jest.mocked(signInWithApple).mockRejectedValue(new Error("the Apple token was rejected"));

    expect(await signInWithAppleNatively({ api })).toEqual({
      status: "failed",
      message: "the Apple token was rejected",
    });
  });
});
