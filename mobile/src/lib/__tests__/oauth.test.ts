import { exchangeOAuthCode, getOAuthStartUrl } from "@/data/api/endpoints/auth";
import { NATIVE_REDIRECT_URI, readCallbackCode, signInWithProvider } from "@/lib/oauth";

jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock("@/data/api/endpoints/auth", () => ({
  getOAuthStartUrl: jest.fn(),
  exchangeOAuthCode: jest.fn(),
}));

const token = {
  access_token: "jwt",
  user: {
    id: "u-1",
    email: "operator@example.com",
    created_at: "2026-08-24T00:00:00Z",
    email_verified_at: null,
    is_admin: false,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getOAuthStartUrl).mockResolvedValue("https://spawnd.dev/api/auth/oauth/google/start");
});

describe("readCallbackCode", () => {
  it("reads the code the server appended", () => {
    expect(readCallbackCode("spawn://auth/oauth?code=abc123")).toEqual({ code: "abc123" });
  });

  it("surfaces a provider error rather than failing silently", () => {
    expect(readCallbackCode("spawn://auth/oauth?error=access_denied")).toEqual({
      error: "access_denied",
    });
  });

  it("treats a callback with neither as a failure", () => {
    expect(readCallbackCode("spawn://auth/oauth")).toMatchObject({
      error: expect.stringContaining("did not include a code"),
    });
  });

  it("does not throw on a malformed URL", () => {
    expect(readCallbackCode("not a url")).toMatchObject({ error: expect.any(String) });
  });
});

describe("signInWithProvider", () => {
  it("asks the server for a native start URL and trades the code for a session", async () => {
    const browser = {
      openAuthSessionAsync: jest.fn().mockResolvedValue({
        type: "success",
        url: "spawn://auth/oauth?code=one-time-code",
      }),
    };
    jest.mocked(exchangeOAuthCode).mockResolvedValue(token);

    const outcome = await signInWithProvider("google", { browser });

    expect(getOAuthStartUrl).toHaveBeenCalledWith("google", {
      redirectUri: NATIVE_REDIRECT_URI,
    });
    // The redirect passed to the web view must match the one the URL was built
    // with, or the session never closes on the callback.
    expect(browser.openAuthSessionAsync).toHaveBeenCalledWith(
      "https://spawnd.dev/api/auth/oauth/google/start",
      NATIVE_REDIRECT_URI,
    );
    expect(exchangeOAuthCode).toHaveBeenCalledWith({ code: "one-time-code" });
    expect(outcome).toEqual({ status: "signed-in", token });
  });

  it.each(["dismiss", "cancel", "locked"])(
    "treats %s as a cancellation, not an error",
    async (type) => {
      const browser = { openAuthSessionAsync: jest.fn().mockResolvedValue({ type }) };
      expect(await signInWithProvider("google", { browser })).toEqual({ status: "cancelled" });
      expect(exchangeOAuthCode).not.toHaveBeenCalled();
    },
  );

  it("reports a provider error carried on the callback", async () => {
    const browser = {
      openAuthSessionAsync: jest.fn().mockResolvedValue({
        type: "success",
        url: "spawn://auth/oauth?error=access_denied",
      }),
    };
    expect(await signInWithProvider("google", { browser })).toEqual({
      status: "failed",
      message: "access_denied",
    });
  });

  it("reports a rejected exchange in the user's terms", async () => {
    const browser = {
      openAuthSessionAsync: jest.fn().mockResolvedValue({
        type: "success",
        url: "spawn://auth/oauth?code=stale",
      }),
    };
    jest
      .mocked(exchangeOAuthCode)
      .mockRejectedValue(new Error("this sign-in code is invalid or has expired"));

    expect(await signInWithProvider("google", { browser })).toEqual({
      status: "failed",
      message: "this sign-in code is invalid or has expired",
    });
  });

  it("survives the web view refusing to open", async () => {
    const browser = {
      openAuthSessionAsync: jest.fn().mockRejectedValue(new Error("no browser")),
    };
    expect(await signInWithProvider("google", { browser })).toEqual({
      status: "failed",
      message: "no browser",
    });
  });
});
