import { z } from "zod";
import { api } from "@/data/api/client";
import { jsonBody, pathPart } from "@/data/api/endpoints/helpers";
import {
  type BrowserDeviceOut,
  BrowserDeviceOutSchema,
  type BrowserDevicePruneResponse,
  BrowserDevicePruneResponseSchema,
  type BrowserDeviceRegisterRequest,
  BrowserDeviceRegisterRequestSchema,
  type BrowserDeviceRenameRequest,
  BrowserDeviceRenameRequestSchema,
  type BrowserDeviceRevokeRequest,
  BrowserDeviceRevokeRequestSchema,
  type DeviceApproveRequest,
  DeviceApproveRequestSchema,
  type DeviceApproveResponse,
  DeviceApproveResponseSchema,
  type DevicePendingRequest,
  DevicePendingRequestSchema,
  type DevicePendingResponse,
  DevicePendingResponseSchema,
  type DevicePollRequest,
  DevicePollRequestSchema,
  type DevicePollResponse,
  DevicePollResponseSchema,
  type DevicePossessionRequest,
  DevicePossessionRequestSchema,
  type DevicePossessionResponse,
  DevicePossessionResponseSchema,
  type DeviceStartRequest,
  DeviceStartRequestSchema,
  type DeviceStartResponse,
  DeviceStartResponseSchema,
} from "@/data/api/schemas/devices";

export function startDevicePairing(body: DeviceStartRequest): Promise<DeviceStartResponse> {
  return api("/api/auth/device/start", {
    method: "POST",
    auth: false,
    body: jsonBody(DeviceStartRequestSchema.parse(body)),
    schema: DeviceStartResponseSchema,
  });
}

export function proveDevicePossession(
  body: DevicePossessionRequest,
): Promise<DevicePossessionResponse> {
  return api("/api/auth/device/possession", {
    method: "POST",
    auth: false,
    body: jsonBody(DevicePossessionRequestSchema.parse(body)),
    schema: DevicePossessionResponseSchema,
  });
}

export function pollDevicePairing(body: DevicePollRequest): Promise<DevicePollResponse> {
  return api("/api/auth/device/poll", {
    method: "POST",
    auth: false,
    body: jsonBody(DevicePollRequestSchema.parse(body)),
    schema: DevicePollResponseSchema,
  });
}

export function getPendingDevice(body: DevicePendingRequest): Promise<DevicePendingResponse> {
  return api("/api/auth/device/pending", {
    method: "POST",
    body: jsonBody(DevicePendingRequestSchema.parse(body)),
    schema: DevicePendingResponseSchema,
  });
}

export function approveDevicePairing(body: DeviceApproveRequest): Promise<DeviceApproveResponse> {
  return api("/api/auth/device/approve", {
    method: "POST",
    body: jsonBody(DeviceApproveRequestSchema.parse(body)),
    schema: DeviceApproveResponseSchema,
  });
}

export function registerBrowserDevice(
  body: BrowserDeviceRegisterRequest,
): Promise<BrowserDeviceOut> {
  return api("/api/browser-devices/register", {
    method: "POST",
    body: jsonBody(BrowserDeviceRegisterRequestSchema.parse(body)),
    schema: BrowserDeviceOutSchema,
  });
}

export function listBrowserDevices(): Promise<BrowserDeviceOut[]> {
  return api("/api/browser-devices", { schema: z.array(BrowserDeviceOutSchema) });
}

export function pruneBrowserDevices(): Promise<BrowserDevicePruneResponse> {
  return api("/api/browser-devices/prune", {
    method: "POST",
    schema: BrowserDevicePruneResponseSchema,
  });
}

export function revokeBrowserDevice(
  deviceId: string,
  body: BrowserDeviceRevokeRequest,
): Promise<BrowserDeviceOut> {
  return api(`/api/browser-devices/${pathPart(deviceId)}/revoke`, {
    method: "POST",
    body: jsonBody(BrowserDeviceRevokeRequestSchema.parse(body)),
    schema: BrowserDeviceOutSchema,
  });
}

export function renameBrowserDevice(
  deviceId: string,
  body: BrowserDeviceRenameRequest,
): Promise<BrowserDeviceOut> {
  return api(`/api/browser-devices/${pathPart(deviceId)}`, {
    method: "PATCH",
    body: jsonBody(BrowserDeviceRenameRequestSchema.parse(body)),
    schema: BrowserDeviceOutSchema,
  });
}
