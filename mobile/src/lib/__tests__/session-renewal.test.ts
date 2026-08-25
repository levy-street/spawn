import { sessionTokenNeedsRenewal } from "@/data/api/auth-token";
import { ApiError } from "@/data/api/client";
import { renewSessionIfNeeded } from "@/lib/session-renewal";

function sessionJwt(issuedAt: number, expiresAt: number): string {
  const payload = globalThis
    .btoa(JSON.stringify({ iat: issuedAt, exp: expiresAt, kind: "access" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${payload}.signature`;
}

describe("mobile session half-life renewal", () => {
  afterEach(() => jest.useRealTimers());

  it("triggers at half-life on a foreground check and stores the returned token", async () => {
    jest.useFakeTimers();
    const issuedAt = Date.parse("2026-08-01T00:00:00Z") / 1_000;
    const expiresAt = Date.parse("2026-08-31T00:00:00Z") / 1_000;
    const token = sessionJwt(issuedAt, expiresAt);
    const renew = jest.fn(async () => ({ access_token: "fresh-session" }));
    const storeToken = jest.fn(async () => undefined);

    jest.setSystemTime(new Date("2026-08-15T23:59:59Z"));
    expect(sessionTokenNeedsRenewal(token)).toBe(false);
    await expect(
      renewSessionIfNeeded({
        getToken: async () => token,
        renew,
        storeToken,
        nowSeconds: () => Date.now() / 1_000,
      }),
    ).resolves.toBe("not-needed");

    jest.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    await expect(
      renewSessionIfNeeded({
        getToken: async () => token,
        renew,
        storeToken,
        nowSeconds: () => Date.now() / 1_000,
      }),
    ).resolves.toBe("renewed");
    expect(renew).toHaveBeenCalledTimes(1);
    expect(storeToken).toHaveBeenCalledWith("fresh-session");
  });

  it("ignores the renewal endpoint on an older server", async () => {
    const now = 2_000;
    const token = sessionJwt(1_000, 2_500);
    await expect(
      renewSessionIfNeeded({
        getToken: async () => token,
        renew: async () => {
          throw new ApiError(404, "http_404", "not found");
        },
        storeToken: jest.fn(async () => undefined),
        nowSeconds: () => now,
      }),
    ).resolves.toBe("unsupported");
  });
});
