import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { commitAuthenticatedUser } from "./auth";
import type { BrowserDeviceRegistrationState } from "./browser-device-registration";
import { type BrowserTrustInputs, deriveBrowserTrust } from "./browser-trust";
import {
  establishBrowserTrustSession,
  getBrowserTrustSessionSnapshot,
  invalidateBrowserTrust,
  SERVER_BROWSER_TRUST_SESSION_SNAPSHOT,
  subscribeBrowserTrustSession,
} from "./browser-trust-events";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const PUBLIC_KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const readyRegistration: BrowserDeviceRegistrationState = {
  status: "ready",
  publicKey: PUBLIC_KEY_A,
  device: {
    id: "00000000-0000-4000-8000-000000000003",
    key_algorithm: "ed25519",
    public_key: PUBLIC_KEY_A,
    fingerprint: "SHA256:test",
    created_at: "2026-07-17T00:00:00Z",
    revoked_at: null,
  },
};

function inputs(overrides: Partial<BrowserTrustInputs> = {}): BrowserTrustInputs {
  return {
    userId: USER_A,
    authLoading: false,
    authError: null,
    session: SERVER_BROWSER_TRUST_SESSION_SNAPSHOT,
    registrationData: readyRegistration,
    registrationLoading: false,
    registrationError: null,
    ...overrides,
  };
}

describe("browser trust status", () => {
  test("allows only a stable authenticated owner with a ready registration", () => {
    const trusted = deriveBrowserTrust(inputs());
    expect(trusted).toMatchObject({
      status: "trusted",
      accountOwnerUserId: USER_A,
      browserDeviceId: readyRegistration.status === "ready" ? readyRegistration.device.id : "",
    });

    for (const candidate of [
      inputs({ authLoading: true }),
      inputs({ authError: new Error("me failed") }),
      inputs({ userId: null }),
      inputs({ registrationLoading: true }),
      inputs({ registrationError: new Error("registration failed") }),
      inputs({ registrationData: undefined }),
      inputs({ registrationData: { status: "cleanup_pending", publicKey: PUBLIC_KEY_A } }),
      inputs({ registrationData: { status: "revoked", publicKey: PUBLIC_KEY_A } }),
    ]) {
      expect(deriveBrowserTrust(candidate).status).toBe("blocked");
    }
  });

  test("blocks stale auth data during logout, 401, and account switches", () => {
    const invalidated = {
      serial: 7,
      status: "invalidated" as const,
      ownerUserId: null,
      reason: "unauthorized" as const,
    };
    expect(deriveBrowserTrust(inputs({ session: invalidated }))).toMatchObject({
      status: "blocked",
      reason: "session_invalidated",
    });
    expect(
      deriveBrowserTrust(
        inputs({
          session: {
            serial: 8,
            status: "established",
            ownerUserId: USER_B,
            reason: null,
          },
        }),
      ),
    ).toMatchObject({ status: "blocked", reason: "account_mismatch" });
  });

  test("changes the owner boundary for an in-SPA A to B switch", () => {
    const accountA = deriveBrowserTrust(inputs());
    const accountB = deriveBrowserTrust(
      inputs({
        userId: USER_B,
        registrationData: {
          ...readyRegistration,
          publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          device: {
            ...readyRegistration.device,
            id: "00000000-0000-4000-8000-000000000004",
            public_key: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          },
        },
      }),
    );

    expect(accountA.boundaryKey).not.toBe(accountB.boundaryKey);
    expect(accountB).toMatchObject({ status: "trusted", accountOwnerUserId: USER_B });
  });

  test("publishes synchronous invalidation and explicit session establishment", () => {
    const before = getBrowserTrustSessionSnapshot().serial;
    invalidateBrowserTrust("logout");
    expect(getBrowserTrustSessionSnapshot()).toMatchObject({
      serial: before + 1,
      status: "invalidated",
      reason: "logout",
    });
    establishBrowserTrustSession(USER_B);
    expect(getBrowserTrustSessionSnapshot()).toMatchObject({
      serial: before + 2,
      status: "established",
      ownerUserId: USER_B,
    });
  });

  test("commits an in-SPA A to B switch only after invalidation and drops A cache", () => {
    const queryClient = new QueryClient();
    const userA = { id: USER_A, email: "a@example.com", created_at: "2026-07-17T00:00:00Z" };
    const userB = { id: USER_B, email: "b@example.com", created_at: "2026-07-17T00:00:00Z" };
    queryClient.setQueryData(["me"], { user: userA });
    queryClient.setQueryData(["agents"], [{ id: "owned-by-a" }]);
    const transitions: string[] = [];
    const unsubscribe = subscribeBrowserTrustSession(() => {
      transitions.push(getBrowserTrustSessionSnapshot().status);
    });

    commitAuthenticatedUser(queryClient, userB);
    unsubscribe();

    expect(transitions).toEqual(["invalidated", "established"]);
    expect(queryClient.getQueryData(["agents"])).toBeUndefined();
    expect(queryClient.getQueryData<{ user: typeof userB }>(["me"])).toEqual({ user: userB });
    expect(getBrowserTrustSessionSnapshot()).toMatchObject({
      status: "established",
      ownerUserId: USER_B,
    });
  });
});
