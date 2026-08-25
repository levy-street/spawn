import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart, queryString } from "@/data/api/endpoints/helpers";
import {
  type DevicePairingContribute,
  DevicePairingContributeSchema,
  type DevicePairingOut,
  DevicePairingOutSchema,
  type DevicePairingReveal,
  DevicePairingRevealSchema,
  type DevicePairingStart,
  DevicePairingStartSchema,
  type DevicePairingState,
  DevicePairingStateSchema,
} from "@/data/api/schemas/pairing";
import {
  type AccountEndorsementCreate,
  AccountEndorsementCreateSchema,
  type AccountEndorsementOut,
  AccountEndorsementOutSchema,
  type AccountEndorsementRecord,
  AccountEndorsementRecordSchema,
  type BrowserEndorsementCreate,
  BrowserEndorsementCreateSchema,
  type BrowserEndorsementOut,
  BrowserEndorsementOutSchema,
  type BrowserEndorsementRecord,
  BrowserEndorsementRecordSchema,
  type DeviceApprovalRequestOut,
  DeviceApprovalRequestOutSchema,
  type PasskeyCredentialCreate,
  PasskeyCredentialCreateSchema,
  type PasskeyCredentialOut,
  PasskeyCredentialOutSchema,
  type TrustBundleOut,
  TrustBundleOutSchema,
  type TrustBundlePut,
  TrustBundlePutSchema,
} from "@/data/api/schemas/trust";

export function getTrustBundle(): Promise<TrustBundleOut | null> {
  return api("/api/trust/bundle", { schema: TrustBundleOutSchema.nullable() });
}

export function putTrustBundle(body: TrustBundlePut): Promise<TrustBundleOut> {
  return api("/api/trust/bundle", {
    method: "PUT",
    body: jsonBody(TrustBundlePutSchema.parse(body)),
    schema: TrustBundleOutSchema,
  });
}

export function listPasskeys(): Promise<PasskeyCredentialOut[]> {
  return api("/api/trust/passkeys", { schema: z.array(PasskeyCredentialOutSchema) });
}

export function createPasskey(body: PasskeyCredentialCreate): Promise<PasskeyCredentialOut> {
  return api("/api/trust/passkeys", {
    method: "POST",
    body: jsonBody(PasskeyCredentialCreateSchema.parse(body)),
    schema: PasskeyCredentialOutSchema,
  });
}

export function deletePasskey(passkeyId: string): Promise<void> {
  return api(`/api/trust/passkeys/${pathPart(passkeyId)}`, { method: "DELETE" });
}

export function listEndorsements(endorsedDeviceId: string): Promise<BrowserEndorsementRecord[]> {
  return api(`/api/trust/endorsements${queryString({ endorsed_device_id: endorsedDeviceId })}`, {
    schema: z.array(BrowserEndorsementRecordSchema),
  });
}

export function createEndorsement(body: BrowserEndorsementCreate): Promise<BrowserEndorsementOut> {
  return api("/api/trust/endorsements", {
    method: "POST",
    body: jsonBody(BrowserEndorsementCreateSchema.parse(body)),
    schema: BrowserEndorsementOutSchema,
  });
}

/**
 * Every account-scoped endorsement edge whose endpoints are both live, for this
 * device to assemble the carried chain it presents on connect (mesh §3).
 * Server-claimed; the daemon re-verifies each signature.
 */
export function listAccountEndorsements(): Promise<AccountEndorsementRecord[]> {
  return api("/api/trust/account-endorsements", {
    schema: z.array(AccountEndorsementRecordSchema),
  });
}

/**
 * Record this device vouching for another account-wide. The server verifies
 * the signature only to keep malformed rows out; authority is decided by each
 * daemon when the endorsed device carries the edge to it.
 */
export function createAccountEndorsement(
  body: AccountEndorsementCreate,
): Promise<AccountEndorsementOut> {
  return api("/api/trust/account-endorsements", {
    method: "POST",
    body: jsonBody(AccountEndorsementCreateSchema.parse(body)),
    schema: AccountEndorsementOutSchema,
  });
}

/**
 * Raise (or refresh) this device's knock so the account's other devices can
 * offer to admit it. Grants nothing on its own — the pin still comes from an
 * endorsement signed on a device the host already trusts.
 */
export function requestDeviceApproval(browserDeviceId: string): Promise<DeviceApprovalRequestOut> {
  return api("/api/trust/device-approvals", {
    method: "POST",
    body: jsonBody({ browser_device_id: browserDeviceId }),
    schema: DeviceApprovalRequestOutSchema,
  });
}

export function listDeviceApprovals(): Promise<DeviceApprovalRequestOut[]> {
  return api("/api/trust/device-approvals", {
    schema: z.array(DeviceApprovalRequestOutSchema),
  });
}

export function denyDeviceApproval(requestId: string): Promise<DeviceApprovalRequestOut> {
  return api(`/api/trust/device-approvals/${pathPart(requestId)}/deny`, {
    method: "POST",
    schema: DeviceApprovalRequestOutSchema,
  });
}

export function listHostPins(hostId: string): Promise<string[]> {
  return api(`/api/trust/hosts/${pathPart(hostId)}/pins`, { schema: z.array(z.string().uuid()) });
}

// ----- add-device SAS ceremony relay (mesh §4, Appendix A) -----

/** Initiator: open a ceremony toward `joiner_device_id`, committing to a nonce. */
export function startPairing(body: DevicePairingStart): Promise<DevicePairingOut> {
  return api("/api/trust/pairing", {
    method: "POST",
    body: jsonBody(DevicePairingStartSchema.parse(body)),
    schema: DevicePairingOutSchema,
  });
}

/** Live ceremonies involving `deviceId`, as initiator or joiner. */
export function listPairings(deviceId: string): Promise<DevicePairingState[]> {
  return api(`/api/trust/pairing${queryString({ device_id: deviceId })}`, {
    schema: z.array(DevicePairingStateSchema),
  });
}

/** Joiner: its key and fresh nonce, sent before it can learn the opened nonce. */
export function contributePairing(
  pairingId: string,
  body: DevicePairingContribute,
): Promise<DevicePairingState> {
  return api(`/api/trust/pairing/${pathPart(pairingId)}/contribute`, {
    method: "POST",
    body: jsonBody(DevicePairingContributeSchema.parse(body)),
    schema: DevicePairingStateSchema,
  });
}

/** Initiator: open the commitment once the joiner has contributed. */
export function revealPairing(
  pairingId: string,
  body: DevicePairingReveal,
): Promise<DevicePairingState> {
  return api(`/api/trust/pairing/${pathPart(pairingId)}/reveal`, {
    method: "POST",
    body: jsonBody(DevicePairingRevealSchema.parse(body)),
    schema: DevicePairingStateSchema,
  });
}

/** Either side tears the ceremony down: a wrong number, a wrong device. */
export function cancelPairing(pairingId: string): Promise<void> {
  return api(`/api/trust/pairing/${pathPart(pairingId)}`, { method: "DELETE" });
}
