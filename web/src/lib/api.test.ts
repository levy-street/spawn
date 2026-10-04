import { afterEach, describe, expect, test } from "bun:test";
import { auth, SESSION_STATUSES, SessionSchema, trust, WorkspaceSchema } from "./api";
import { isFilesWidget } from "./grid";

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

describe("parsing what a newer server sends", () => {
  const HOST = "11111111-2222-4333-8444-555555555555";
  const session = (status: string, activity_state = "active") => ({
    id: "00000000-0000-4000-8000-000000000009",
    name: null,
    host_id: HOST,
    host_name: "dream",
    cwd: "/home/me",
    status,
    started_at: "2026-10-03T00:00:00Z",
    exited_at: null,
    exit_code: null,
    activity_state,
    activity_label: "Active",
  });

  test("an unknown session status reads as starting instead of failing the list", () => {
    const list = SessionSchema.array().parse([
      session("running"),
      session("migrating", "migrating"),
    ]);
    expect(list.map((item) => item.status)).toEqual(["running", "starting"]);
    expect(list[1]?.activity_state).toBe("unknown");
    for (const status of SESSION_STATUSES)
      expect(SessionSchema.parse(session(status)).status).toBe(status);
  });

  test("a window being moved reads as moving, status and activity both", () => {
    const moving = SessionSchema.parse(session("moving", "moving"));
    expect(moving.status).toBe("moving");
    expect(moving.activity_state).toBe("moving");
  });

  test("a session status that is not text is still refused", () => {
    expect(() => SessionSchema.parse(session(7 as unknown as string))).toThrow();
  });

  const workspace = (widgets: unknown[]) => ({
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    name: "Workspace 1",
    layout: {
      version: 3,
      active_tab: "t1",
      tabs: [
        {
          id: "t1",
          name: "Tab 1",
          layout: {
            version: 3,
            tiles: widgets.map((widget, index) => ({
              session_id: `00000000-0000-4000-8000-00000000000${index}`,
              x: index * 12,
              y: 0,
              w: 12,
              h: 24,
              widget,
            })),
          },
        },
      ],
    },
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
  });

  test("a widget kind this client does not know parses as an inert pane, kept verbatim", () => {
    const desktop = { kind: "desktop", host_id: HOST, desktop_id: "d1", fallback: { w: 1280 } };
    const files = { kind: "files", host_id: HOST, path: "/srv", show_hidden: true };
    const parsed = WorkspaceSchema.parse(workspace([desktop, files]));
    const [first, second] = parsed.layout.tabs[0]?.layout.tiles ?? [];
    expect(isFilesWidget(first?.widget)).toBe(false);
    expect(first?.widget).toEqual(desktop);
    expect(isFilesWidget(second?.widget)).toBe(true);
    // Saving the layout from here sends both back exactly as they came.
    expect(
      JSON.parse(JSON.stringify(parsed.layout)).tabs[0].layout.tiles.map(
        (tile: { widget: unknown }) => tile.widget,
      ),
    ).toEqual([desktop, files]);
  });

  test("a files widget that is not well formed is still refused", () => {
    expect(() => WorkspaceSchema.parse(workspace([{ kind: "files", host_id: HOST }]))).toThrow();
    expect(() => WorkspaceSchema.parse(workspace([{ host_id: HOST, path: "/" }]))).toThrow();
  });
});
