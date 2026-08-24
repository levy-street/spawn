import { api } from "@/data/api/client";
import { jsonBody, pathPart } from "@/data/api/endpoints/helpers";
import {
  type PushDeviceOut,
  PushDeviceOutSchema,
  type PushDeviceRegister,
  PushDeviceRegisterSchema,
} from "@/data/api/schemas/notifications";

/** Tell the server where to reach this install while the app is not running. */
export function registerPushDevice(body: PushDeviceRegister): Promise<PushDeviceOut> {
  return api("/api/notifications/devices", {
    method: "POST",
    body: jsonBody(PushDeviceRegisterSchema.parse(body)),
    schema: PushDeviceOutSchema,
  });
}

/** Stop pushing to this install — sign-out, or notifications switched off. */
export function unregisterPushDevice(token: string): Promise<void> {
  return api(`/api/notifications/devices/${pathPart(token)}`, { method: "DELETE" });
}
