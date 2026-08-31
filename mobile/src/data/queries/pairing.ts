import { useQuery } from "@tanstack/react-query";
import { PAIRING_CEREMONY_TTL_MS } from "@/components/onboarding/pairing-countdown";
import { ApiError } from "@/data/api/client";
import {
  approveDevicePairing,
  getPendingDevice,
  listBrowserDevices,
} from "@/data/api/endpoints/devices";
import { listEndorsements } from "@/data/api/endpoints/trust";
import type {
  BrowserDeviceOut,
  DeviceApproveResponse,
  DevicePendingRequest,
  DevicePendingResponse,
} from "@/data/api/schemas/devices";
import type { BrowserEndorsementRecord } from "@/data/api/schemas/trust";
import { qk } from "@/data/queryKeys";
import { acceptVerifiedEndorsement, verifyEndorsementIntroduction } from "@/data/trust/endorsement";
import {
  formatHostFingerprint,
  type HostPin,
  type HostPinStore,
  openHostPinStore,
  PinStoreError,
} from "@/data/trust/host-pins";
import { ensureDeviceRegistered } from "@/data/trust/registration";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import {
  DeviceIdentityError,
  deviceIdentity,
  setDeviceIdentityAccount,
} from "@/lib/crypto/identity";

export type PairingFailureKind =
  | "fingerprint-mismatch"
  | "identity-missing"
  | "identity-revoked"
  | "identity-storage-unavailable"
  | "pin-revoked"
  | "pin-storage-unavailable"
  | "pairing-expired"
  | "pairing-denied"
  | "key-conflict"
  | "pin-conflict"
  | "pin-limit"
  | "link-identity-mismatch"
  | "link-identity-malformed"
  | "approval-not-found"
  | "host-not-ready"
  | "approval-incomplete"
  | "endorsement-invalid"
  | "host-limit"
  | "pairing-rejected";

export interface PairingFailure {
  kind: PairingFailureKind;
  detail?: string;
  /**
   * How many hosts the plan admits, from the server's 402 body — a number, and
   * never the words around it.
   *
   * `TrustFailureState` renders `detail` verbatim, which is exactly why the
   * billing refusal carries a machine code and figures instead: the sentence a
   * person reads is built in `data/selectors/billing.ts`. See docs/BILLING.md
   * §6.1.
   */
  hostLimit?: number | null;
}

export type PairingProtocolError =
  | "expired"
  | "denied"
  | "key_conflict"
  | "pin_conflict"
  | "pin_limit";

export class PairingFlowError extends Error {
  constructor(readonly failure: PairingFailure) {
    super(failure.detail ?? failure.kind);
    this.name = "PairingFlowError";
  }
}

export interface PendingPairingCeremony {
  identifier: DevicePendingRequest;
  accountId: string;
  serverOrigin: string;
  hostName: string;
  approvalNonce: string;
  hostPublicKey: string;
  hostFingerprint: string;
  expiresAtMs: number;
  pinState: "new" | "active" | "revoked";
  linkVerifiedHostKey: string | null;
}

export interface PairingApprovalResult {
  hostId: string | null;
  hostName: string;
  hostPublicKey: string;
}

function pairingFailure(kind: PairingFailureKind, detail?: string): PairingFailure {
  return detail === undefined ? { kind } : { kind, detail };
}

export function pairingFailureForProtocolError(error: PairingProtocolError): PairingFailure {
  if (error === "expired") return pairingFailure("pairing-expired");
  if (error === "denied") return pairingFailure("pairing-denied");
  if (error === "key_conflict") return pairingFailure("key-conflict");
  if (error === "pin_conflict") return pairingFailure("pin-conflict");
  return pairingFailure("pin-limit");
}

/**
 * The host-limit refusal, read as figures rather than as prose.
 *
 * The server answers an over-limit approval with 402 and a body of machine
 * codes and numbers — `{code: "host_limit", tier, host_limit, host_count}` —
 * precisely so no purchase copy can arrive from the server side and be rendered
 * verbatim in a binary that ships through app review. Returns null for anything
 * that is not that refusal.
 */
function hostLimitFromApiError(error: ApiError): PairingFailure | null {
  if (error.status !== 402) return null;
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const body = detail as { code?: unknown; host_limit?: unknown };
  if (body.code !== "host_limit") return null;
  return typeof body.host_limit === "number"
    ? { kind: "host-limit", hostLimit: body.host_limit }
    : { kind: "host-limit" };
}

function protocolErrorFromApiError(error: ApiError): PairingProtocolError | null {
  const detailCandidates =
    typeof error.detail === "object" && error.detail !== null
      ? Object.values(error.detail).filter((value): value is string => typeof value === "string")
      : [];
  const candidates = [
    error.code,
    error.message,
    typeof error.detail === "string" ? error.detail : "",
    ...detailCandidates,
  ].map((value) => value.trim().toLowerCase());
  for (const candidate of candidates) {
    if (candidate === "denied" || candidate.includes("approval was denied")) return "denied";
    if (candidate === "key_conflict" || candidate.includes("key conflict")) return "key_conflict";
    if (candidate === "pin_conflict" || candidate.includes("pin conflict")) return "pin_conflict";
    if (candidate === "pin_limit" || candidate.includes("pin limit")) return "pin_limit";
    if (candidate === "expired" || candidate === "expired_token" || candidate.includes("expired")) {
      return "expired";
    }
  }
  return null;
}

export function toPairingFailure(error: unknown): PairingFailure {
  if (error instanceof PairingFlowError) return error.failure;
  if (error instanceof DeviceIdentityError) {
    if (error.code === "IDENTITY_ABSENT") return pairingFailure("identity-missing");
    return pairingFailure("identity-storage-unavailable");
  }
  if (error instanceof PinStoreError) {
    return error.code === "PIN_STORAGE_UNAVAILABLE"
      ? pairingFailure("pin-storage-unavailable")
      : pairingFailure("pairing-rejected", error.message);
  }
  if (error instanceof ApiError) {
    // Ahead of everything else, so the billing refusal can never fall through
    // to the branch that carries a server sentence onto the screen.
    const hostLimit = hostLimitFromApiError(error);
    if (hostLimit !== null) return hostLimit;
    const protocolError = protocolErrorFromApiError(error);
    if (protocolError !== null) return pairingFailureForProtocolError(protocolError);
    if (error.status === 404) return pairingFailure("approval-not-found");
    if (error.status === 409) return pairingFailure("host-not-ready");
    return pairingFailure("pairing-rejected", error.message);
  }
  return pairingFailure(
    "pairing-rejected",
    error instanceof Error ? error.message : "Pairing could not be completed",
  );
}

export function serverOriginFromBaseUrl(value: string): string {
  return new URL(value).origin;
}

interface LookupDependencies {
  getPendingDevice: typeof getPendingDevice;
  openHostPinStore: typeof openHostPinStore;
}

export async function lookupPendingPairing(input: {
  approvalRef: string;
  linkHostKey?: string | null;
  accountId: string;
  serverOrigin: string;
  nowMs?: number;
  dependencies?: Partial<LookupDependencies>;
}): Promise<PendingPairingCeremony> {
  const dependencies: LookupDependencies = {
    getPendingDevice: input.dependencies?.getPendingDevice ?? getPendingDevice,
    openHostPinStore: input.dependencies?.openHostPinStore ?? openHostPinStore,
  };
  const identifier: DevicePendingRequest = { approval_ref: input.approvalRef };
  let pending: DevicePendingResponse;
  try {
    pending = await dependencies.getPendingDevice(identifier);
  } catch (error) {
    throw new PairingFlowError(toPairingFailure(error));
  }

  let derivedFingerprint: string;
  try {
    derivedFingerprint = formatHostFingerprint(pending.host_public_key);
  } catch {
    throw new PairingFlowError(pairingFailure("fingerprint-mismatch"));
  }
  if (derivedFingerprint !== pending.host_key_fingerprint) {
    throw new PairingFlowError(pairingFailure("fingerprint-mismatch"));
  }
  if (input.linkHostKey !== undefined && input.linkHostKey !== null) {
    if (pending.host_public_key !== input.linkHostKey) {
      throw new PairingFlowError(pairingFailure("link-identity-mismatch"));
    }
  }

  let pinStore: HostPinStore;
  try {
    pinStore = await dependencies.openHostPinStore();
  } catch {
    throw new PairingFlowError(pairingFailure("pin-storage-unavailable"));
  }
  const resolution = await pinStore.resolve({
    accountId: input.accountId,
    serverOrigin: input.serverOrigin,
    presentedHostPublicKey: pending.host_public_key,
    phoneIdentityAvailable: true,
  });
  if (resolution.status === "storage-unavailable") {
    throw new PairingFlowError(pairingFailure("pin-storage-unavailable"));
  }
  if (resolution.status === "identity-missing") {
    throw new PairingFlowError(pairingFailure("identity-missing"));
  }
  if (resolution.status === "host-identity-withheld" || resolution.status === "mismatch") {
    throw new PairingFlowError(pairingFailure("fingerprint-mismatch"));
  }

  return {
    identifier,
    accountId: input.accountId,
    serverOrigin: input.serverOrigin,
    hostName: pending.host_name,
    approvalNonce: pending.approval_nonce,
    hostPublicKey: pending.host_public_key,
    hostFingerprint: derivedFingerprint,
    expiresAtMs: (input.nowMs ?? Date.now()) + PAIRING_CEREMONY_TTL_MS,
    pinState:
      resolution.status === "revoked"
        ? "revoked"
        : resolution.status === "match"
          ? "active"
          : "new",
    linkVerifiedHostKey: input.linkHostKey ?? null,
  };
}

function responseMatchesReview(
  response: DeviceApproveResponse,
  ceremony: PendingPairingCeremony,
  phone: BrowserDeviceOut,
): boolean {
  return (
    response.host_name === ceremony.hostName &&
    response.approval_nonce === ceremony.approvalNonce &&
    response.host_key_algorithm === "ed25519" &&
    response.host_public_key === ceremony.hostPublicKey &&
    response.host_key_fingerprint === ceremony.hostFingerprint &&
    response.browser_device_id === phone.id &&
    response.browser_key_algorithm === "ed25519" &&
    response.browser_public_key === phone.public_key &&
    response.browser_key_fingerprint === formatHostFingerprint(phone.public_key)
  );
}

interface ApprovalDependencies {
  openHostPinStore: typeof openHostPinStore;
  approveDevicePairing: typeof approveDevicePairing;
  identity: Pick<typeof deviceIdentity, "publicKey" | "signApproval">;
  setDeviceIdentityAccount: typeof setDeviceIdentityAccount;
}

export async function approvePendingPairing(input: {
  ceremony: PendingPairingCeremony;
  phone: BrowserDeviceOut;
  allowRevokedPin: boolean;
  nowMs?: number;
  dependencies?: Partial<ApprovalDependencies>;
}): Promise<PairingApprovalResult> {
  if ((input.nowMs ?? Date.now()) >= input.ceremony.expiresAtMs) {
    throw new PairingFlowError(pairingFailure("pairing-expired"));
  }
  if (input.phone.revoked_at !== null) {
    throw new PairingFlowError(pairingFailure("identity-revoked"));
  }

  const dependencies: ApprovalDependencies = {
    openHostPinStore: input.dependencies?.openHostPinStore ?? openHostPinStore,
    approveDevicePairing: input.dependencies?.approveDevicePairing ?? approveDevicePairing,
    identity: input.dependencies?.identity ?? deviceIdentity,
    setDeviceIdentityAccount:
      input.dependencies?.setDeviceIdentityAccount ?? setDeviceIdentityAccount,
  };
  dependencies.setDeviceIdentityAccount(input.ceremony.accountId);
  let signature: Uint8Array | null = null;
  let pinSaved = false;

  try {
    if (
      input.ceremony.linkVerifiedHostKey !== null &&
      input.ceremony.hostPublicKey !== input.ceremony.linkVerifiedHostKey
    ) {
      throw new PairingFlowError(pairingFailure("link-identity-mismatch"));
    }
    const phonePublicKeyBytes = await dependencies.identity.publicKey();
    if (phonePublicKeyBytes === null) {
      throw new PairingFlowError(pairingFailure("identity-missing"));
    }
    const phonePublicKey = encodeBase64Url(phonePublicKeyBytes);
    phonePublicKeyBytes.fill(0);
    if (
      phonePublicKey !== input.phone.public_key ||
      formatHostFingerprint(phonePublicKey) !== formatHostFingerprint(input.phone.public_key)
    ) {
      throw new PairingFlowError(pairingFailure("identity-revoked"));
    }

    const pinStore = await dependencies.openHostPinStore();
    const resolution = await pinStore.resolve({
      accountId: input.ceremony.accountId,
      serverOrigin: input.ceremony.serverOrigin,
      presentedHostPublicKey: input.ceremony.hostPublicKey,
      phoneIdentityAvailable: true,
    });
    if (resolution.status === "storage-unavailable") {
      throw new PairingFlowError(pairingFailure("pin-storage-unavailable"));
    }
    if (resolution.status === "revoked" && !input.allowRevokedPin) {
      throw new PairingFlowError(pairingFailure("pin-revoked"));
    }
    if (resolution.status === "mismatch" || resolution.status === "host-identity-withheld") {
      throw new PairingFlowError(pairingFailure("fingerprint-mismatch"));
    }
    if (resolution.status === "identity-missing") {
      throw new PairingFlowError(pairingFailure("identity-missing"));
    }

    await pinStore.approveExact({
      accountId: input.ceremony.accountId,
      serverOrigin: input.ceremony.serverOrigin,
      hostPublicKey: input.ceremony.hostPublicKey,
    });
    pinSaved = true;

    signature = await dependencies.identity.signApproval({
      accountId: input.ceremony.accountId,
      approvalNonce: input.ceremony.approvalNonce,
      hostPublicKey: input.ceremony.hostPublicKey,
      browserPublicKey: phonePublicKey,
    });
    const response = await dependencies.approveDevicePairing({
      ...input.ceremony.identifier,
      approval_nonce: input.ceremony.approvalNonce,
      host_key_algorithm: "ed25519",
      host_public_key: input.ceremony.hostPublicKey,
      host_key_fingerprint: input.ceremony.hostFingerprint,
      browser_device_id: input.phone.id,
      browser_key_algorithm: "ed25519",
      browser_public_key: phonePublicKey,
      browser_key_fingerprint: formatHostFingerprint(input.phone.public_key),
      signature: encodeBase64Url(signature),
    });
    if (!responseMatchesReview(response, input.ceremony, input.phone)) {
      throw new Error("Approval response no longer matches the reviewed identities");
    }
    if (response.host_id !== null) {
      await pinStore.approveExact({
        accountId: input.ceremony.accountId,
        serverOrigin: input.ceremony.serverOrigin,
        hostPublicKey: input.ceremony.hostPublicKey,
        hostId: response.host_id,
      });
    }
    return {
      hostId: response.host_id,
      hostName: response.host_name,
      hostPublicKey: response.host_public_key,
    };
  } catch (error) {
    if (error instanceof PairingFlowError) throw error;
    if (error instanceof ApiError) {
      const protocolError = protocolErrorFromApiError(error);
      if (protocolError !== null) {
        throw new PairingFlowError(pairingFailureForProtocolError(protocolError));
      }
    }
    if (pinSaved) {
      throw new PairingFlowError(
        pairingFailure(
          "approval-incomplete",
          error instanceof Error ? error.message : "Server approval did not complete",
        ),
      );
    }
    throw new PairingFlowError(toPairingFailure(error));
  } finally {
    signature?.fill(0);
  }
}

export async function acceptPairingEndorsement(input: {
  accountId: string;
  serverOrigin: string;
  phone: BrowserDeviceOut;
  record: BrowserEndorsementRecord;
  expectedEndorserFingerprint: string;
}): Promise<HostPin> {
  try {
    const verified = verifyEndorsementIntroduction(
      {
        accountId: input.accountId,
        serverOrigin: input.serverOrigin,
        hostId: input.record.host_id,
        hostPublicKey: input.record.host_public_key,
        endorserDeviceId: input.record.endorser_device_id,
        endorserPublicKey: input.record.endorser_public_key,
        endorsedDeviceId: input.phone.id,
        endorsedPublicKey: input.phone.public_key,
        signature: input.record.signature,
      },
      input.phone.public_key,
    );
    return await acceptVerifiedEndorsement({
      endorsement: verified,
      expectedEndorserFingerprint: input.expectedEndorserFingerprint,
      pinStore: await openHostPinStore(),
    });
  } catch (error) {
    if (error instanceof PinStoreError) {
      throw new PairingFlowError(toPairingFailure(error));
    }
    throw new PairingFlowError(pairingFailure("endorsement-invalid"));
  }
}

export function useRegisteredPhone(accountId: string | undefined) {
  return useQuery({
    queryKey: qk.browserDeviceRegistration(accountId ?? "pending"),
    queryFn: () => {
      if (accountId === undefined) throw new Error("Account is not ready");
      return ensureDeviceRegistered({ accountId, label: "SPAWN D on iPhone" });
    },
    // Never run against a half-loaded account: a query keyed on "" used to
    // throw before the account arrived and its failure looked real.
    enabled: accountId !== undefined,
    // Registration is idempotent, so one silent retry absorbs a network blip;
    // a real failure still surfaces (and callers must show it, not shrug).
    retry: 1,
  });
}

export function useAccountDevices(enabled: boolean) {
  return useQuery({ queryKey: qk.browserDevices(), queryFn: listBrowserDevices, enabled });
}

export function usePendingEndorsements(accountId: string, phoneId: string | null) {
  return useQuery({
    queryKey: qk.trustIntroductions(accountId, phoneId ?? "pending"),
    queryFn: () => {
      if (phoneId === null) throw new Error("Phone registration is not ready");
      return listEndorsements(phoneId);
    },
    enabled: phoneId !== null,
  });
}
