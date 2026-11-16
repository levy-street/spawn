import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import {
  type DeviceTrustProbeApi,
  invalidateDeviceHostTrust,
  probeDeviceHostTrust,
  probeDeviceHostTrustResult,
} from "@/data/trust/device-trust";

const HOST_ID = "b3ae000c-1da3-4c6c-aeda-23a37ecb01ac";
const PHONE_ID = "aa03db41-655e-450f-95fe-96464416292a";
// encodeBase64Url of 32 zero bytes; only the round trip matters here.
const PHONE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function phone(overrides: Partial<BrowserDeviceOut> = {}): BrowserDeviceOut {
  return {
    id: PHONE_ID,
    label: "iPhone",
    key_algorithm: "ed25519",
    public_key: PHONE_KEY,
    fingerprint: "SHA256:whatever",
    created_at: "2026-08-22T05:48:37Z",
    revoked_at: null,
    ...overrides,
  } as BrowserDeviceOut;
}

const LAPTOP_ID = "b6b3d3d0-4d8b-4f53-9b1f-3a0d9b6f1e21";

/** The pins route's answer: every pin delivered (confirmed by its host). */
function pins(...ids: string[]) {
  return {
    pins: ids.map((id) => ({ browser_device_id: id, delivered: true, undelivered_reason: null })),
    capacity: null,
  };
}

function probeApi(overrides: Partial<DeviceTrustProbeApi> = {}): Partial<DeviceTrustProbeApi> {
  return {
    publicKey: async () => new Uint8Array(32),
    listBrowserDevices: async () => [phone()],
    getHostPins: async () => pins(PHONE_ID),
    listAccountEndorsements: async () => [],
    getHost: async () => ({ id: HOST_ID, supports_account_chains: true }) as never,
    nowMs: () => 1_000,
    ...overrides,
  };
}

function chainApi(overrides: Partial<DeviceTrustProbeApi> = {}): Partial<DeviceTrustProbeApi> {
  // The host pins the laptop; the laptop account-endorses the phone.
  return probeApi({
    listBrowserDevices: async () => [
      phone(),
      phone({ id: LAPTOP_ID, label: "Chrome on Mac", public_key: "laptop-key" }),
    ],
    getHostPins: async () => pins(LAPTOP_ID),
    listAccountEndorsements: async () => [
      {
        endorser_device_id: LAPTOP_ID,
        endorser_public_key: "laptop-key",
        endorsed_device_id: PHONE_ID,
        endorsed_public_key: PHONE_KEY,
        signature: "sig",
        created_at: "2026-08-24T05:48:37Z",
      },
    ],
    ...overrides,
  });
}

describe("probeDeviceHostTrust", () => {
  beforeEach(() => invalidateDeviceHostTrust());

  it("trusts a registered device the host has pinned", async () => {
    await expect(probeDeviceHostTrust(HOST_ID, probeApi())).resolves.toBe("trusted");
  });

  it("distinguishes a direct pin from chain admission", async () => {
    await expect(probeDeviceHostTrustResult(HOST_ID, probeApi())).resolves.toEqual({
      status: "trusted",
      directlyPinned: true,
      confirmed: true,
    });
    invalidateDeviceHostTrust();
    await expect(probeDeviceHostTrustResult(HOST_ID, chainApi())).resolves.toEqual({
      status: "trusted",
      directlyPinned: false,
      confirmed: true,
    });
  });

  it("distrusts a registered device the host has not pinned", async () => {
    await expect(
      probeDeviceHostTrust(HOST_ID, probeApi({ getHostPins: async () => pins() })),
    ).resolves.toBe("untrusted");
  });

  it("trusts a device that reaches the host's pin through an account chain", async () => {
    await expect(probeDeviceHostTrust(HOST_ID, chainApi())).resolves.toBe("trusted");
  });

  it("ignores the chain toward a host whose daemon does not validate chains", async () => {
    await expect(
      probeDeviceHostTrust(
        HOST_ID,
        chainApi({
          getHost: async () => ({ id: HOST_ID, supports_account_chains: false }) as never,
        }),
      ),
    ).resolves.toBe("untrusted");
  });

  it("distrusts a chain whose anchor the host does not pin", async () => {
    await expect(
      probeDeviceHostTrust(HOST_ID, chainApi({ getHostPins: async () => pins() })),
    ).resolves.toBe("untrusted");
  });

  it("shares the account-wide reads across a burst of probes", async () => {
    const listBrowserDevices = jest.fn(async () => [phone()]);
    const listAccountEndorsements = jest.fn(async () => []);
    const api = probeApi({
      listBrowserDevices,
      listAccountEndorsements,
      getHostPins: async () => pins(),
    });
    await Promise.all([
      probeDeviceHostTrust(HOST_ID, api),
      probeDeviceHostTrust("11111111-1111-4111-8111-111111111111", api),
    ]);
    expect(listBrowserDevices).toHaveBeenCalledTimes(1);
    expect(listAccountEndorsements).toHaveBeenCalledTimes(1);
  });

  it("distrusts an identity the server has no live registration for", async () => {
    await expect(
      probeDeviceHostTrust(HOST_ID, probeApi({ listBrowserDevices: async () => [] })),
    ).resolves.toBe("untrusted");
    invalidateDeviceHostTrust();
    await expect(
      probeDeviceHostTrust(
        HOST_ID,
        probeApi({
          listBrowserDevices: async () => [phone({ revoked_at: "2026-08-22T06:00:00Z" })],
        }),
      ),
    ).resolves.toBe("untrusted");
  });

  it("stays unknown without a local identity or when the probe cannot answer", async () => {
    await expect(
      probeDeviceHostTrust(HOST_ID, probeApi({ publicKey: async () => null })),
    ).resolves.toBe("unknown");
    await expect(
      probeDeviceHostTrust(
        HOST_ID,
        probeApi({
          getHostPins: () => Promise.reject(new Error("offline")),
        }),
      ),
    ).resolves.toBe("unknown");
  });

  it("memoizes a verdict briefly and drops it on invalidation", async () => {
    const getHostPins = jest.fn(async () => pins(PHONE_ID));
    await probeDeviceHostTrust(HOST_ID, probeApi({ getHostPins }));
    await probeDeviceHostTrust(HOST_ID, probeApi({ getHostPins }));
    expect(getHostPins).toHaveBeenCalledTimes(1);

    invalidateDeviceHostTrust(HOST_ID);
    await probeDeviceHostTrust(HOST_ID, probeApi({ getHostPins }));
    expect(getHostPins).toHaveBeenCalledTimes(2);

    // A verdict older than the TTL is re-derived rather than trusted forever.
    await probeDeviceHostTrust(HOST_ID, probeApi({ getHostPins, nowMs: () => 1_000_000 }));
    expect(getHostPins).toHaveBeenCalledTimes(3);
  });

  it("never memoizes an unknown verdict", async () => {
    const getHostPins = jest
      .fn<ReturnType<DeviceTrustProbeApi["getHostPins"]>, [string]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(pins(PHONE_ID));
    await expect(probeDeviceHostTrust(HOST_ID, probeApi({ getHostPins }))).resolves.toBe("unknown");
    await expect(probeDeviceHostTrust(HOST_ID, probeApi({ getHostPins }))).resolves.toBe("trusted");
  });
});
