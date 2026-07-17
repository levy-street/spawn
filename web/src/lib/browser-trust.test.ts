import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { commitAuthenticatedUser } from "./auth";
import type { BrowserDeviceRegistrationState } from "./browser-device-registration";
import {
  type BrowserTrustInputs,
  deriveBrowserTrust,
  refreshBrowserTrustAfterPeerInvalidation,
} from "./browser-trust";
import {
  BrowserTrustInvalidationProtocol,
  establishBrowserTrustSession,
  fanoutBrowserTrustInvalidation,
  getBrowserTrustSessionSnapshot,
  invalidateBrowserTrust,
  MAX_BROWSER_TRUST_INVALIDATION_SENDERS,
  SERVER_BROWSER_TRUST_SESSION_SNAPSHOT,
  subscribeBrowserTrustSession,
} from "./browser-trust-events";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const PUBLIC_KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function protocolId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

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
      source: "local" as const,
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
            source: null,
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

  test("propagates logout, expiry, and auth errors to a second tab without replay", () => {
    const received: string[] = [];
    const tabA = new BrowserTrustInvalidationProtocol(
      "00000000-0000-4000-8000-000000000101",
      () => {},
      () => 1_000,
    );
    const tabB = new BrowserTrustInvalidationProtocol(
      "00000000-0000-4000-8000-000000000102",
      (reason) => {
        received.push(reason);
        invalidateBrowserTrust(reason, { broadcast: false, source: "peer" });
      },
      () => 1_000,
    );

    for (const reason of ["logout", "session_expired", "auth_error"] as const) {
      const message = tabA.create(reason);
      expect(tabB.receive(message)).toBe(true);
      expect(tabB.receive(message)).toBe(false);
      expect(getBrowserTrustSessionSnapshot()).toMatchObject({
        status: "invalidated",
        reason,
        source: "peer",
      });
    }
    expect(received).toEqual(["logout", "session_expired", "auth_error"]);
  });

  test("requires fresh /me and registration reads before a peer account switch re-establishes", async () => {
    const queryClient = new QueryClient();
    const order: string[] = [];
    invalidateBrowserTrust("account_change", { broadcast: false, source: "peer" });

    const restored = await refreshBrowserTrustAfterPeerInvalidation(
      queryClient,
      new AbortController().signal,
      {
        fetchMe: async () => {
          order.push(`me:${getBrowserTrustSessionSnapshot().status}`);
          return {
            user: {
              id: USER_B,
              email: "b@example.com",
              created_at: "2026-07-17T00:00:00Z",
            },
          };
        },
        fetchRegistration: async (_client, userId) => {
          order.push(`registration:${userId}:${getBrowserTrustSessionSnapshot().status}`);
          return {
            ...readyRegistration,
            device: { ...readyRegistration.device, id: "00000000-0000-4000-8000-000000000004" },
          };
        },
      },
    );

    expect(restored).toBe(true);
    expect(order).toEqual(["me:invalidated", `registration:${USER_B}:invalidated`]);
    expect(getBrowserTrustSessionSnapshot()).toMatchObject({
      status: "established",
      ownerUserId: USER_B,
    });

    invalidateBrowserTrust("logout", { broadcast: false, source: "peer" });
    let registrationCalled = false;
    expect(
      await refreshBrowserTrustAfterPeerInvalidation(queryClient, new AbortController().signal, {
        fetchMe: async () => null,
        fetchRegistration: async () => {
          registrationCalled = true;
          return readyRegistration;
        },
      }),
    ).toBe(false);
    expect(registrationCalled).toBe(false);
    expect(getBrowserTrustSessionSnapshot().status).toBe("invalidated");
  });

  test("broadcast revocation still reaches a peer when the durable marker write fails", () => {
    const received: string[] = [];
    const tabA = new BrowserTrustInvalidationProtocol(
      "00000000-0000-4000-8000-000000000103",
      () => {},
      () => 1_000,
    );
    const tabB = new BrowserTrustInvalidationProtocol(
      "00000000-0000-4000-8000-000000000104",
      (reason) => received.push(reason),
      () => 1_000,
    );
    fanoutBrowserTrustInvalidation(tabA.create("registration_revoked"), {
      broadcast: (encoded) => void tabB.receive(encoded),
      store: () => {
        throw new Error("localStorage quota failure");
      },
    });
    expect(received).toEqual(["registration_revoked"]);
  });

  test("retains one sender high-water mark across more than 64 messages", () => {
    let invalidations = 0;
    const sender = new BrowserTrustInvalidationProtocol(
      protocolId(105),
      () => {},
      () => 1_000,
    );
    const receiver = new BrowserTrustInvalidationProtocol(
      protocolId(106),
      () => invalidations++,
      () => 1_000,
    );
    const first = sender.create("unauthorized");
    expect(receiver.receive(first)).toBe(true);
    for (let index = 1; index < 80; index += 1) {
      expect(receiver.receive(sender.create("unauthorized"))).toBe(true);
    }
    expect(receiver.senderSlotCount()).toBe(1);
    expect(receiver.receive(first)).toBe(false);
    expect(invalidations).toBe(80);
  });

  test("rejects out-of-order and exact dual-sink delivery", () => {
    let invalidations = 0;
    const sender = new BrowserTrustInvalidationProtocol(
      protocolId(107),
      () => {},
      () => 1_000,
    );
    const receiver = new BrowserTrustInvalidationProtocol(
      protocolId(108),
      () => invalidations++,
      () => 1_000,
    );
    const sequenceZero = sender.create("logout");
    const sequenceOne = sender.create("logout");
    expect(receiver.receive(sequenceOne)).toBe(true);
    expect(receiver.receive(sequenceZero)).toBe(false);
    expect(receiver.receive(sequenceOne)).toBe(false);

    const next = sender.create("account_change");
    fanoutBrowserTrustInvalidation(next, {
      broadcast: (encoded) => void receiver.receive(encoded),
      store: (encoded) => void receiver.receive(encoded),
    });
    expect(invalidations).toBe(2);
  });

  test("holds the exact sender cap without evicting live replay state", () => {
    let invalidations = 0;
    const receiver = new BrowserTrustInvalidationProtocol(
      protocolId(900),
      () => invalidations++,
      () => 1_000,
    );
    const senders = Array.from(
      { length: MAX_BROWSER_TRUST_INVALIDATION_SENDERS },
      (_, index) =>
        new BrowserTrustInvalidationProtocol(
          protocolId(200 + index),
          () => {},
          () => 1_000,
        ),
    );
    for (const sender of senders) {
      expect(receiver.receive(sender.create("unauthorized"))).toBe(true);
    }
    expect(receiver.senderSlotCount()).toBe(MAX_BROWSER_TRUST_INVALIDATION_SENDERS);

    const capPlusOne = new BrowserTrustInvalidationProtocol(
      protocolId(500),
      () => {},
      () => 1_000,
    );
    expect(receiver.receive(capPlusOne.create("unauthorized"))).toBe(false);
    expect(receiver.senderSlotCount()).toBe(MAX_BROWSER_TRUST_INVALIDATION_SENDERS);
    expect(receiver.receive(senders[0]!.create("logout"))).toBe(true);
    expect(invalidations).toBe(MAX_BROWSER_TRUST_INVALIDATION_SENDERS + 1);
  });

  test("accepts a restarted sender within capacity and reuses only expired slots", () => {
    let now = 1_000;
    const restartReceiver = new BrowserTrustInvalidationProtocol(
      protocolId(905),
      () => {},
      () => now,
    );
    const firstProcess = new BrowserTrustInvalidationProtocol(
      protocolId(601),
      () => {},
      () => now,
    );
    const restartedProcess = new BrowserTrustInvalidationProtocol(
      protocolId(602),
      () => {},
      () => now,
    );
    expect(restartReceiver.receive(firstProcess.create("logout"))).toBe(true);
    expect(restartReceiver.receive(restartedProcess.create("logout"))).toBe(true);
    expect(restartReceiver.senderSlotCount()).toBe(2);

    const receiver = new BrowserTrustInvalidationProtocol(
      protocolId(901),
      () => {},
      () => now,
    );
    const senders = Array.from(
      { length: MAX_BROWSER_TRUST_INVALIDATION_SENDERS },
      (_, index) =>
        new BrowserTrustInvalidationProtocol(
          protocolId(300 + index),
          () => {},
          () => now,
        ),
    );
    const oldEnvelope = senders[0]!.create("logout");
    expect(receiver.receive(oldEnvelope)).toBe(true);
    for (const sender of senders.slice(1)) {
      expect(receiver.receive(sender.create("logout"))).toBe(true);
    }
    const restarted = new BrowserTrustInvalidationProtocol(
      protocolId(600),
      () => {},
      () => now,
    );
    expect(receiver.receive(restarted.create("logout"))).toBe(false);

    now += 5 * 60_000 + 1;
    expect(receiver.receive(oldEnvelope)).toBe(false);
    expect(receiver.senderSlotCount()).toBe(0);
    expect(receiver.receive(restarted.create("logout"))).toBe(true);
    expect(receiver.senderSlotCount()).toBe(1);
    expect(receiver.receive(oldEnvelope)).toBe(false);
  });

  test("retains a future-skewed sender until its envelope can no longer be valid", () => {
    let now = 1_000;
    const sender = new BrowserTrustInvalidationProtocol(
      protocolId(603),
      () => {},
      () => now + 60_000,
    );
    const receiver = new BrowserTrustInvalidationProtocol(
      protocolId(906),
      () => {},
      () => now,
    );
    const envelope = sender.create("logout");
    expect(receiver.receive(envelope)).toBe(true);

    now += 5 * 60_000 + 1;
    expect(receiver.senderSlotCount()).toBe(1);
    expect(receiver.receive(envelope)).toBe(false);

    now += 60_000;
    expect(receiver.senderSlotCount()).toBe(0);
    expect(receiver.receive(envelope)).toBe(false);
  });

  test("rejects old, future, malformed, unknown, and oversized envelopes", () => {
    const now = 1_000_000;
    const receiver = new BrowserTrustInvalidationProtocol(
      protocolId(902),
      () => {},
      () => now,
    );
    const old = new BrowserTrustInvalidationProtocol(
      protocolId(700),
      () => {},
      () => now - 5 * 60_000 - 1,
    );
    const future = new BrowserTrustInvalidationProtocol(
      protocolId(701),
      () => {},
      () => now + 60_001,
    );
    expect(receiver.receive(old.create("logout"))).toBe(false);
    expect(receiver.receive(future.create("logout"))).toBe(false);

    const sender = new BrowserTrustInvalidationProtocol(
      protocolId(702),
      () => {},
      () => now,
    );
    const valid = sender.create("logout");
    const unknown = { ...JSON.parse(valid), extra: true };
    const missing = JSON.parse(valid);
    delete missing.sequence;
    expect(receiver.receive(unknown)).toBe(false);
    expect(receiver.receive(missing)).toBe(false);
    expect(receiver.receive({ ...JSON.parse(valid), senderId: "not-a-uuid" })).toBe(false);
    expect(receiver.receive("x".repeat(513))).toBe(false);
    expect(receiver.receive(valid)).toBe(true);
  });

  test("bounds sequence and timestamp integers without overflow", () => {
    const receiver = new BrowserTrustInvalidationProtocol(
      protocolId(903),
      () => {},
      () => 1_000,
    );
    const finalSequence = new BrowserTrustInvalidationProtocol(
      protocolId(800),
      () => {},
      () => 1_000,
      Number.MAX_SAFE_INTEGER,
    );
    expect(receiver.receive(finalSequence.create("logout"))).toBe(true);
    expect(() => finalSequence.create("logout")).toThrow("sequence exhausted");
    expect(
      () =>
        new BrowserTrustInvalidationProtocol(
          protocolId(801),
          () => {},
          () => 1_000,
          -1,
        ),
    ).toThrow("non-negative safe integer");
    expect(
      () =>
        new BrowserTrustInvalidationProtocol(
          protocolId(802),
          () => {},
          () => 1_000,
          Number.MAX_SAFE_INTEGER + 1,
        ),
    ).toThrow("non-negative safe integer");

    const base = JSON.parse(
      new BrowserTrustInvalidationProtocol(
        protocolId(803),
        () => {},
        () => 1_000,
      ).create("logout"),
    );
    expect(receiver.receive({ ...base, sequence: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(receiver.receive({ ...base, sequence: -1 })).toBe(false);
    expect(receiver.receive({ ...base, sequence: 0.5 })).toBe(false);

    const timestampOverflow = new BrowserTrustInvalidationProtocol(
      protocolId(804),
      () => {},
      () => Number.MAX_SAFE_INTEGER,
    );
    const overflowReceiver = new BrowserTrustInvalidationProtocol(
      protocolId(904),
      () => {},
      () => Number.MAX_SAFE_INTEGER,
    );
    expect(overflowReceiver.receive(timestampOverflow.create("logout"))).toBe(false);
  });
});
