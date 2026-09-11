import * as SecureStore from "expo-secure-store";
import { authToken } from "@/data/api/auth-token";
import { setBaseUrl } from "@/data/api/config";

const secureValues = new Map<string, string>();
let originSequence = 0;

function responseWithCookie(cookie: string | null): Response {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === "set-cookie" ? cookie : null),
    } as Headers,
  } as Response;
}

function jwtWithExpiry(exp: number): string {
  const payload = globalThis
    .btoa(JSON.stringify({ sub: "user:test", kind: "access", exp }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${payload}.signature`;
}

beforeEach(async () => {
  secureValues.clear();
  jest
    .mocked(SecureStore.getItemAsync)
    .mockImplementation(async (key) => secureValues.get(key) ?? null);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    secureValues.set(key, value);
  });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    secureValues.delete(key);
  });
  originSequence += 1;
  await setBaseUrl(`https://api-${originSequence}.spawn.test`);
  await authToken.clear();
  jest.clearAllMocks();
});

describe("authToken.captureFromResponse", () => {
  const token = "header.payload.signature==";

  test.each([
    ["a single cookie", `spawn_session=${token}; Path=/; HttpOnly`],
    ["a cookie header with leading whitespace", `   spawn_session=${token}; Path=/`],
    [
      "folded cookies with an Expires comma",
      `other=value; Expires=Wed, 21 Oct 2030 07:28:00 GMT, spawn_session=${token}; Path=/`,
    ],
    [
      "the session cookie after another cookie",
      `other=value; Path=/,spawn_session=${token}; Secure`,
    ],
    ["a folded cookie after the session cookie", `spawn_session=${token}, other=value; Path=/`],
  ])("captures %s", async (_label, header) => {
    await expect(authToken.captureFromResponse(responseWithCookie(header))).resolves.toEqual(
      expect.objectContaining({ token }),
    );
    await expect(authToken.get()).resolves.toBe(token);
  });

  it("returns null for a missing header", async () => {
    await expect(authToken.captureFromResponse(responseWithCookie(null))).resolves.toBeNull();
  });

  it("does not confuse cookie attributes for a token", async () => {
    const header = "Path=/; HttpOnly; SameSite=lax; Max-Age=2592000; Secure";
    await expect(authToken.captureFromResponse(responseWithCookie(header))).resolves.toBeNull();
    await expect(authToken.get()).resolves.toBeNull();
  });

  it("does not capture a similarly named cookie", async () => {
    await expect(
      authToken.captureFromResponse(responseWithCookie("not_spawn_session=value; Path=/")),
    ).resolves.toBeNull();
  });
});

describe("authToken storage", () => {
  it("caches an unexpired token without rereading SecureStore", async () => {
    const token = jwtWithExpiry(Math.floor(Date.now() / 1000) + 3_600);
    await authToken.set(token);
    await expect(authToken.get()).resolves.toBe(token);
    await expect(authToken.get()).resolves.toBe(token);
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  });

  it("removes a token after its hard expiry", async () => {
    const token = jwtWithExpiry(Math.floor(Date.now() / 1000) - 1);
    await authToken.set(token);
    await expect(authToken.get()).resolves.toBeNull();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps tokens isolated by server origin", async () => {
    await authToken.set("server-a-token");
    await setBaseUrl("https://server-b.spawn.test");
    await expect(authToken.get()).resolves.toBeNull();
    await authToken.set("server-b-token");
    await setBaseUrl(`https://api-${originSequence}.spawn.test`);
    await expect(authToken.get()).resolves.toBe("server-a-token");
  });

  it("clears both memory and secure persistence", async () => {
    await authToken.set("token");
    await authToken.clear();
    await expect(authToken.get()).resolves.toBeNull();
    expect(secureValues.size).toBe(0);
  });
});
