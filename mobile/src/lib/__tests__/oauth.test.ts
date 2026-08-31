import { createHash } from "node:crypto";

import { exchangeOAuthCode, getOAuthStartUrl } from "@/data/api/endpoints/auth";
import { NATIVE_REDIRECT_URI, readCallbackCode, signInWithProvider } from "@/lib/oauth";

jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));
// jest-expo's expo-crypto stub hands back zeroed buffers, which would make a
// PKCE assertion prove nothing. Use the real primitives so the binding between
// the challenge sent out and the verifier redeemed is actually tested.
jest.mock("expo-crypto", () => {
  const nodeCrypto = require("node:crypto");
  return {
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    getRandomValues: (array: Uint8Array) => nodeCrypto.randomFillSync(array),
    digest: async (_algorithm: string, data: Uint8Array) =>
      nodeCrypto.createHash("sha256").update(Buffer.from(data)).digest().buffer,
  };
});
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
      invite: null,
      codeChallenge: expect.any(String),
    });
    // The redirect passed to the web view must match the one the URL was built
    // with, or the session never closes on the callback.
    expect(browser.openAuthSessionAsync).toHaveBeenCalledWith(
      "https://spawnd.dev/api/auth/oauth/google/start",
      NATIVE_REDIRECT_URI,
    );
    expect(exchangeOAuthCode).toHaveBeenCalledWith({
      code: "one-time-code",
      code_verifier: expect.any(String),
    });
    expect(outcome).toEqual({ status: "signed-in", token });
  });

  it("redeems with the verifier that opens the challenge it sent", async () => {
    const browser = {
      openAuthSessionAsync: jest.fn().mockResolvedValue({
        type: "success",
        url: "spawn://auth/oauth?code=one-time-code",
      }),
    };
    jest.mocked(exchangeOAuthCode).mockResolvedValue(token);

    await signInWithProvider("google", { browser });

    const codeChallenge = jest.mocked(getOAuthStartUrl).mock.calls[0]?.[1]?.codeChallenge;
    const verifier = jest.mocked(exchangeOAuthCode).mock.calls[0]?.[0]?.code_verifier;
    // Only the challenge crossed the network on the way out; the verifier is
    // what proves this app is the one that asked. An attacker who lures a code
    // from their own sign-in onto this device has neither.
    expect(verifier).toBeDefined();
    expect(verifier).not.toEqual(codeChallenge);
    expect(codeChallenge).toEqual(
      createHash("sha256")
        .update(verifier ?? "", "ascii")
        .digest("base64url"),
    );
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

  it("carries an invite so a closed deployment can admit the account", async () => {
    const browser = {
      openAuthSessionAsync: jest.fn().mockResolvedValue({
        type: "success",
        url: "spawn://auth/oauth?code=one-time-code",
      }),
    };
    jest.mocked(exchangeOAuthCode).mockResolvedValue(token);

    await signInWithProvider("google", { browser, invite: "an-invite-code" });

    expect(getOAuthStartUrl).toHaveBeenCalledWith("google", {
      redirectUri: NATIVE_REDIRECT_URI,
      invite: "an-invite-code",
      codeChallenge: expect.any(String),
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
