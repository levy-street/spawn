import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart, queryString } from "@/data/api/endpoints/helpers";
import {
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
