import {
  AuthConfigOutSchema,
  MeResponseSchema,
  TokenResponseSchema,
} from "@/data/api/schemas/auth";

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-31T03:12:01.123456+00:00";

const legacyUser = {
  id: UUID,
  email: "owner@example.com",
  created_at: NOW,
  email_verified_at: null,
  is_admin: false,
};

const billing = {
  enabled: true,
  tier: "coven",
  tier_name: "Coven",
  host_limit: 3,
  host_count: 3,
  over_limit: false,
  status: "active",
  current_period_end: "2026-09-24T00:00:00+00:00",
  cancel_at_period_end: false,
};

describe("the plan block never breaks launch", () => {
  // The single most important assertion in the mobile billing set. `/api/me`
  // gates app launch: `useAuthBootstrap` reports `loading` while its data is
  // undefined and `AuthGate` holds a full-screen overlay until it resolves, so
  // a schema this response cannot satisfy bricks the app rather than a screen.
  // A self-hosted server, or one older than this build, sends no plan block.
  test("a /api/me response with no billing fields still parses", () => {
    const parsed = MeResponseSchema.parse({ user: legacyUser });
    expect(parsed.user.billing).toBeNull();
  });

  test("an explicit null plan block parses to null", () => {
    const parsed = MeResponseSchema.parse({ user: { ...legacyUser, billing: null } });
    expect(parsed.user.billing).toBeNull();
  });

  test("a partial plan block fills its own defaults rather than failing", () => {
    const parsed = MeResponseSchema.parse({ user: { ...legacyUser, billing: { enabled: true } } });
    expect(parsed.user.billing).toEqual({
      enabled: true,
      tier: "free",
      tier_name: "Free",
      host_limit: null,
      host_count: 0,
      over_limit: false,
      status: null,
      current_period_end: null,
      cancel_at_period_end: false,
    });
  });

  // Both sign-in paths seed the me-cache straight from the token response, so a
  // plan block carried on `/api/me` but dropped here would leave a stale value
  // in place until the first refetch.
  test("the token response carries the same plan block", () => {
    const parsed = TokenResponseSchema.parse({
      access_token: "token",
      user: { ...legacyUser, billing },
    });
    expect(parsed.user.billing?.tier_name).toBe("Coven");
    expect(parsed.user.billing?.host_limit).toBe(3);
  });
});

describe("the advertised billing capability", () => {
  // A self-hosted server that has never heard of billing must not trip a schema
  // mismatch on the endpoint the login and onboarding surfaces read.
  test("an auth config with no billing block defaults to off", () => {
    const parsed = AuthConfigOutSchema.parse({
      providers: [],
      email_verification_required: false,
      invite_only: false,
    });
    expect(parsed.billing).toEqual({
      enabled: false,
      free_host_limit: 1,
      mobile_upgrade_link: false,
    });
  });

  test("the off-platform upgrade link is off unless the server turns it on", () => {
    const off = AuthConfigOutSchema.parse({
      providers: [],
      email_verification_required: false,
      invite_only: false,
      billing: { enabled: true, free_host_limit: 1 },
    });
    expect(off.billing.mobile_upgrade_link).toBe(false);
  });

  // The server's block carries a `tiers` array with prices in it. The surest
  // way to keep a price out of this binary is never to parse one into it.
  test("prices sent by the server are dropped, not carried", () => {
    const parsed = AuthConfigOutSchema.parse({
      providers: [],
      email_verification_required: false,
      invite_only: false,
      billing: {
        enabled: true,
        free_host_limit: 1,
        mobile_upgrade_link: false,
        tiers: [{ key: "coven", name: "Coven", price_cents: 500, host_limit: 3 }],
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("price_cents");
    expect(JSON.stringify(parsed)).not.toContain("500");
  });
});
