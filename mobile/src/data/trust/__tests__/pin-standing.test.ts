import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { AccountEndorsementRecord } from "@/data/api/schemas/trust";
import { pinStanding } from "@/data/trust/chain-reach";
import {
  type DeviceTrustProbeApi,
  invalidateDeviceHostTrust,
  probeDeviceHostTrustResult,
} from "@/data/trust/device-trust";

// #138: the account's approval and one host's confirmation of it are two
// different states. The pins arrive here exactly as the server sends them —
// only the HTTP client is replaced — so the real endpoint and schema decide
// what reaches the probe.

const HOST_ID = "b3ae000c-1da3-4c6c-aeda-23a37ecb01ac";
const PHONE_ID = "aa03db41-655e-450f-95fe-96464416292a";
const LAPTOP_ID = "b6b3d3d0-4d8b-4f53-9b1f-3a0d9b6f1e21";
// encodeBase64Url of 32 zero bytes: the phone's own key below.
const PHONE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LAPTOP_KEY = "q3Z8V7mT2xQ9bN4cR6sW1yE5uI0oP8aS3dF7gH2jK4l";
const REMOVED_AT = "2026-11-15T00:00:00Z";

type Reason = "pin_limit" | "invalid_chain" | "other";

let mockPins: unknown = [];
jest.mock("@/data/api/client", () => ({
  api: jest.fn(async (path: string, init: { schema?: { parse: (value: unknown) => unknown } }) => {
    if (!path.endsWith("/pins")) throw new Error(`unexpected request ${path}`);
    return init.schema ? init.schema.parse(mockPins) : mockPins;
  }),
}));

function servePins(...pins: Array<{ id: string; reason: Reason | null }>): void {
  mockPins = {
    pins: pins.map(({ id, reason }) => ({
      browser_device_id: id,
      delivered: reason === null,
      undelivered_reason: reason,
    })),
    capacity: { used: pins.length, max: 32 },
  };
}

function device(id: string, publicKey: string, revokedAt: string | null = null): BrowserDeviceOut {
  return {
    id,
    label: null,
    key_algorithm: "ed25519",
    public_key: publicKey,
    created_at: "2026-08-22T05:48:37Z",
    revoked_at: revokedAt,
  } as BrowserDeviceOut;
}

const laptopEndorsesPhone: AccountEndorsementRecord = {
  endorser_device_id: LAPTOP_ID,
  endorser_public_key: LAPTOP_KEY,
  endorsed_device_id: PHONE_ID,
  endorsed_public_key: PHONE_KEY,
  signature: "sig",
  created_at: "2026-08-24T05:48:37Z",
};

/** Everything but the pins, injected; the pins go through the real endpoint. */
function probeApi(
  options: { laptopRemoved?: boolean; phoneRemoved?: boolean; chains?: boolean } = {},
): Partial<DeviceTrustProbeApi> {
  return {
    publicKey: async () => new Uint8Array(32),
    listBrowserDevices: async () => [
      device(PHONE_ID, PHONE_KEY, options.phoneRemoved ? REMOVED_AT : null),
      device(LAPTOP_ID, LAPTOP_KEY, options.laptopRemoved ? REMOVED_AT : null),
    ],
    listAccountEndorsements: async () => [laptopEndorsesPhone],
    getHost: async () =>
      ({ id: HOST_ID, supports_account_chains: options.chains ?? true }) as never,
    nowMs: () => 1_000,
  };
}

describe("pinStanding", () => {
  const pin = (reason: Reason | null, delivered = reason === null) => ({
    delivered,
    undelivered_reason: reason,
  });

  it("decides every reason the server can record on its own", () => {
    expect(pinStanding(pin(null))).toBe("confirmed");
    // A host whose reconcile could not run nacks every pin it was sent,
    // the ones it already holds and still admits included.
    expect(pinStanding(pin("other"))).toBe("unconfirmed");
    // Verified, then no room: the approval stands, the host is full.
    expect(pinStanding(pin("pin_limit"))).toBe("unconfirmed");
    // The host checked the approval and could not verify it.
    expect(pinStanding(pin("invalid_chain"))).toBe("rejected");
    expect(pinStanding(pin("invalid_chain", true))).toBe("rejected");
    expect(pinStanding(pin(null, false))).toBe("unconfirmed");
  });
});

describe("the host probe against a host that has not confirmed an approval (#138)", () => {
  beforeEach(() => invalidateDeviceHostTrust());

  it.each(["other", "pin_limit"] as const)(
    "REGRESSION: a phone whose only chain runs through an unconfirmed pin (%s) is approved",
    async (reason) => {
      servePins({ id: LAPTOP_ID, reason });
      await expect(probeDeviceHostTrustResult(HOST_ID, probeApi())).resolves.toEqual({
        status: "trusted",
        directlyPinned: false,
        // The host's own state, kept for the per-host questions.
        confirmed: false,
      });
    },
  );

  it("REGRESSION: a phone whose own pin is unconfirmed is approved, and carries its chain", async () => {
    servePins({ id: PHONE_ID, reason: "other" });
    await expect(probeDeviceHostTrustResult(HOST_ID, probeApi())).resolves.toEqual({
      status: "trusted",
      directlyPinned: false,
      confirmed: false,
    });
  });

  it("an unconfirmed own pin does not hide a confirmed chain", async () => {
    mockPins = {
      pins: [
        { browser_device_id: PHONE_ID, delivered: false, undelivered_reason: "other" },
        { browser_device_id: LAPTOP_ID, delivered: true, undelivered_reason: null },
      ],
      capacity: { used: 2, max: 32 },
    };
    await expect(probeDeviceHostTrustResult(HOST_ID, probeApi())).resolves.toEqual({
      status: "trusted",
      directlyPinned: false,
      confirmed: true,
    });
  });

  it("a confirmed way to the host stays confirmed", async () => {
    servePins({ id: LAPTOP_ID, reason: null });
    await expect(probeDeviceHostTrustResult(HOST_ID, probeApi())).resolves.toEqual({
      status: "trusted",
      directlyPinned: false,
      confirmed: true,
    });
  });

  it("a pin the host could not verify approves nothing", async () => {
    servePins({ id: LAPTOP_ID, reason: "invalid_chain" });
    await expect(probeDeviceHostTrustResult(HOST_ID, probeApi())).resolves.toMatchObject({
      status: "untrusted",
    });
    invalidateDeviceHostTrust();
    servePins({ id: PHONE_ID, reason: "invalid_chain" });
    await expect(probeDeviceHostTrustResult(HOST_ID, probeApi())).resolves.toMatchObject({
      status: "untrusted",
    });
  });

  it("a phone nobody approved still gets the sheet", async () => {
    servePins({ id: LAPTOP_ID, reason: "other" });
    await expect(
      probeDeviceHostTrustResult(HOST_ID, {
        ...probeApi(),
        listAccountEndorsements: async () => [],
      }),
    ).resolves.toMatchObject({ status: "untrusted" });
  });

  it("removal still ends approval, whatever a pin's delivery state says", async () => {
    // A removed approver's stale row seeds nothing below it.
    servePins({ id: LAPTOP_ID, reason: "other" });
    await expect(
      probeDeviceHostTrustResult(HOST_ID, probeApi({ laptopRemoved: true })),
    ).resolves.toMatchObject({ status: "untrusted" });
    // Not even with the host's confirmation.
    invalidateDeviceHostTrust();
    servePins({ id: LAPTOP_ID, reason: null });
    await expect(
      probeDeviceHostTrustResult(HOST_ID, probeApi({ laptopRemoved: true })),
    ).resolves.toMatchObject({ status: "untrusted" });
    // And a removed phone keeps nothing, its own pin included.
    invalidateDeviceHostTrust();
    servePins({ id: PHONE_ID, reason: "other" });
    await expect(
      probeDeviceHostTrustResult(HOST_ID, probeApi({ phoneRemoved: true })),
    ).resolves.toMatchObject({ status: "untrusted" });
  });

  it("toward a host that ignores chains, only the phone's own pin counts", async () => {
    servePins({ id: LAPTOP_ID, reason: "other" });
    await expect(
      probeDeviceHostTrustResult(HOST_ID, probeApi({ chains: false })),
    ).resolves.toMatchObject({ status: "untrusted" });
    invalidateDeviceHostTrust();
    servePins({ id: PHONE_ID, reason: "pin_limit" });
    await expect(
      probeDeviceHostTrustResult(HOST_ID, probeApi({ chains: false })),
    ).resolves.toMatchObject({ status: "trusted", confirmed: false });
  });
});
