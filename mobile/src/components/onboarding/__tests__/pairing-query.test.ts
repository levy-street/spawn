import { PAIRING_CEREMONY_TTL_MS } from "@/components/onboarding/pairing-countdown";
import { ApiError } from "@/data/api/client";
import type {
  BrowserDeviceOut,
  DeviceApproveRequest,
  DeviceApproveResponse,
} from "@/data/api/schemas/devices";
import {
  approvePendingPairing,
  lookupPendingPairing,
  type PendingPairingCeremony,
  toPairingFailure,
} from "@/data/queries/pairing";
import { createHostPinStore, formatHostFingerprint } from "@/data/trust/host-pins";
import { decodeBase64UrlExact } from "@/lib/crypto/bytes";
import type { ApprovalTranscript } from "@/lib/crypto/transcripts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const HOST_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const PHONE_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const PHONE_ID = "22222222-2222-4222-8222-222222222222";

const PHONE: BrowserDeviceOut = {
  id: PHONE_ID,
  key_algorithm: "ed25519",
  public_key: PHONE_KEY,
  label: "spawn on iPhone",
  created_at: "2026-08-22T00:00:00Z",
  revoked_at: null,
};

const CEREMONY: PendingPairingCeremony = {
  identifier: { approval_ref: "ref-QZ4K7HMT" },
  accountId: ACCOUNT_ID,
  serverOrigin: "https://spawn.example.com",
  hostName: "Studio Mac",
  approvalNonce: NONCE,
  hostPublicKey: HOST_KEY,
  hostFingerprint: formatHostFingerprint(HOST_KEY),
  expiresAtMs: 10_000,
  pinState: "new",
  linkVerifiedHostKey: null,
};

function emptyPinStore() {
  return createHostPinStore({
    load: jest.fn(async () => []),
    save: jest.fn(async () => undefined),
    deleteAccount: jest.fn(async () => undefined),
  });
}

describe("pairing query orchestration", () => {
  it("looks up an approval ref, verifies the host fingerprint, and starts a bounded review", async () => {
    const getPendingDevice = jest.fn(async () => ({
      host_name: "Studio Mac",
      approval_nonce: NONCE,
      host_key_algorithm: "ed25519" as const,
      host_public_key: HOST_KEY,
      host_key_fingerprint: formatHostFingerprint(HOST_KEY),
    }));

    const ceremony = await lookupPendingPairing({
      approvalRef: "ref-QZ4K7HMT",
      accountId: ACCOUNT_ID,
      serverOrigin: "https://spawn.example.com",
      nowMs: 1_000,
      dependencies: {
        getPendingDevice,
        openHostPinStore: async () => emptyPinStore(),
      },
    });

    expect(getPendingDevice).toHaveBeenCalledWith({ approval_ref: "ref-QZ4K7HMT" });
    expect(ceremony.hostFingerprint).toBe(formatHostFingerprint(HOST_KEY));
    expect(ceremony.pinState).toBe("new");
    expect(ceremony.expiresAtMs).toBe(1_000 + PAIRING_CEREMONY_TTL_MS);
  });

  it("pre-fills the same fingerprint review through pending approval_ref", async () => {
    const getPendingDevice = jest.fn(async () => ({
      host_name: "Studio Mac",
      approval_nonce: NONCE,
      host_key_algorithm: "ed25519" as const,
      host_public_key: HOST_KEY,
      host_key_fingerprint: formatHostFingerprint(HOST_KEY),
    }));

    const ceremony = await lookupPendingPairing({
      approvalRef: "approval-ref-123",
      accountId: ACCOUNT_ID,
      serverOrigin: "https://spawn.example.com",
      linkHostKey: HOST_KEY,
      dependencies: {
        getPendingDevice,
        openHostPinStore: async () => emptyPinStore(),
      },
    });

    expect(getPendingDevice).toHaveBeenCalledWith({ approval_ref: "approval-ref-123" });
    expect(ceremony).toMatchObject({
      identifier: { approval_ref: "approval-ref-123" },
      hostName: "Studio Mac",
      hostFingerprint: formatHostFingerprint(HOST_KEY),
      linkVerifiedHostKey: HOST_KEY,
    });
  });

  it("terminally refuses an approval ref whose fragment key does not match pending", async () => {
    await expect(
      lookupPendingPairing({
        approvalRef: "approval-ref-123",
        accountId: ACCOUNT_ID,
        serverOrigin: "https://spawn.example.com",
        linkHostKey: PHONE_KEY,
        dependencies: {
          getPendingDevice: async () => ({
            host_name: "Studio Mac",
            approval_nonce: NONCE,
            host_key_algorithm: "ed25519",
            host_public_key: HOST_KEY,
            host_key_fingerprint: formatHostFingerprint(HOST_KEY),
          }),
          openHostPinStore: async () => emptyPinStore(),
        },
      }),
    ).rejects.toMatchObject({ failure: { kind: "link-identity-mismatch" } });
  });

  it("fails closed when the claimed host fingerprint is different", async () => {
    const lookup = lookupPendingPairing({
      approvalRef: "ref-QZ4K7HMT",
      accountId: ACCOUNT_ID,
      serverOrigin: "https://spawn.example.com",
      dependencies: {
        getPendingDevice: async () => ({
          host_name: "Studio Mac",
          approval_nonce: NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: HOST_KEY,
          host_key_fingerprint: "SHA256:substituted",
        }),
        openHostPinStore: async () => emptyPinStore(),
      },
    });

    await expect(lookup).rejects.toMatchObject({
      failure: { kind: "fingerprint-mismatch" },
    });
  });

  it("maps protocol expiry and approval-not-found responses distinctly", () => {
    expect(toPairingFailure(new ApiError(400, "bad_request", "approval expired"))).toEqual({
      kind: "pairing-expired",
    });
    expect(toPairingFailure(new ApiError(404, "not_found", "unknown approval"))).toEqual({
      kind: "approval-not-found",
    });
  });

  it("persists the exact host pin before signing and posting approval", async () => {
    const events: string[] = [];
    const store = createHostPinStore({
      load: jest.fn(async () => []),
      save: jest.fn(async () => {
        events.push("pin");
      }),
      deleteAccount: jest.fn(async () => undefined),
    });
    let posted: DeviceApproveRequest | null = null;
    const approveDevicePairing = jest.fn(
      async (body: DeviceApproveRequest): Promise<DeviceApproveResponse> => {
        events.push("api");
        posted = body;
        return {
          host_name: CEREMONY.hostName,
          approval_nonce: CEREMONY.approvalNonce,
          host_key_algorithm: "ed25519",
          host_public_key: CEREMONY.hostPublicKey,
          host_key_fingerprint: CEREMONY.hostFingerprint,
          browser_device_id: PHONE.id,
          browser_key_algorithm: "ed25519",
          browser_public_key: PHONE.public_key,
          browser_key_fingerprint: formatHostFingerprint(PHONE.public_key),
          host_id: null,
        };
      },
    );
    const signApproval = jest.fn(async (_input: ApprovalTranscript) => {
      events.push("sign");
      return new Uint8Array(64);
    });

    await expect(
      approvePendingPairing({
        ceremony: CEREMONY,
        phone: PHONE,
        allowRevokedPin: false,
        nowMs: 1_000,
        dependencies: {
          openHostPinStore: async () => store,
          approveDevicePairing,
          identity: {
            publicKey: async () => decodeBase64UrlExact(PHONE_KEY, 32),
            signApproval,
          },
          setDeviceIdentityAccount: jest.fn(),
        },
      }),
    ).resolves.toMatchObject({ hostName: "Studio Mac", hostId: null });

    expect(events).toEqual(["pin", "sign", "api"]);
    expect(posted).toMatchObject({
      approval_ref: "ref-QZ4K7HMT",
      host_public_key: HOST_KEY,
      browser_public_key: PHONE_KEY,
    });
  });

  it("retains a safe local pin and reports incomplete server approval", async () => {
    const store = createHostPinStore({
      load: jest.fn(async () => []),
      save: jest.fn(async () => undefined),
      deleteAccount: jest.fn(async () => undefined),
    });

    await expect(
      approvePendingPairing({
        ceremony: CEREMONY,
        phone: PHONE,
        allowRevokedPin: false,
        nowMs: 1_000,
        dependencies: {
          openHostPinStore: async () => store,
          approveDevicePairing: async () => {
            throw new ApiError(503, "unavailable", "Server unavailable");
          },
          identity: {
            publicKey: async () => decodeBase64UrlExact(PHONE_KEY, 32),
            signApproval: async () => new Uint8Array(64),
          },
          setDeviceIdentityAccount: jest.fn(),
        },
      }),
    ).rejects.toMatchObject({ failure: { kind: "approval-incomplete" } });
  });
});
