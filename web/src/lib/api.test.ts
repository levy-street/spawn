import { afterEach, describe, expect, test } from "bun:test";
import { auth, trust } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("authenticated API requests", () => {
  test("an ordinary response stays transparent to renewed session-cookie adoption", async () => {
    // In a browser the network stack applies Set-Cookie before fetch resolves;
    // scripts cannot read an HttpOnly cookie. This tiny jar models that native
    // boundary and proves api() neither opts out with omitted credentials nor
    // replaces the response path with its own token handling.
    let sessionCookie = "spawn_session=old";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      const response = jsonResponse(
        {
          user: {
            id: "00000000-0000-4000-8000-000000000001",
            email: "tester@example.com",
            created_at: "2026-08-25T00:00:00Z",
            email_verified_at: null,
            is_admin: false,
          },
        },
        { headers: { "Set-Cookie": "spawn_session=renewed; Path=/; HttpOnly; SameSite=Lax" } },
      );
      sessionCookie = response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? sessionCookie;
      return response;
    }) as typeof fetch;

    await expect(auth.me()).resolves.toMatchObject({ user: { email: "tester@example.com" } });
    expect(sessionCookie).toBe("spawn_session=renewed");
  });

  test("host approval delivery metadata keeps the old array response as its fallback", async () => {
    const delivered = "00000000-0000-4000-8000-000000000011";
    const undelivered = "00000000-0000-4000-8000-000000000012";
    const responses = [
      {
        pins: [
          {
            browser_device_id: delivered,
            delivered: true,
            undelivered_reason: null,
          },
          {
            browser_device_id: undelivered,
            delivered: false,
            undelivered_reason: "invalid_chain",
          },
        ],
        capacity: { used: 29, max: 32 },
      },
      {
        pins: [
          {
            browser_device_id: delivered,
            delivered: true,
            undelivered_reason: null,
          },
          {
            browser_device_id: undelivered,
            delivered: false,
            undelivered_reason: "invalid_chain",
          },
        ],
        capacity: { used: 29, max: 32 },
      },
      [delivered],
    ];
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(responses.shift())) as typeof fetch;

    await expect(trust.hostPinStatus("host-id")).resolves.toMatchObject({
      capacity: { used: 29, max: 32 },
      pins: [
        { browser_device_id: delivered, delivered: true },
        {
          browser_device_id: undelivered,
          delivered: false,
          undelivered_reason: "invalid_chain",
        },
      ],
    });
    await expect(trust.hostPins("host-id")).resolves.toEqual([delivered]);
    await expect(trust.hostPinStatus("host-id")).resolves.toEqual({
      pins: [{ browser_device_id: delivered, delivered: true, undelivered_reason: null }],
      capacity: null,
    });
  });

  test("sign out everywhere posts an empty body and adopts the returned client contract", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ access_token: "fresh-session-token" });
    }) as typeof fetch;

    await expect(auth.signOutEverywhere()).resolves.toEqual({
      access_token: "fresh-session-token",
    });
    expect(requests[0]?.url).toEndWith("/api/auth/sign-out-everywhere");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      credentials: "include",
      body: "{}",
    });
  });
});
