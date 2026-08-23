import { api } from "@/data/api/client";
import { pathPart } from "@/data/api/endpoints/helpers";
import { type InstallerTarget, InstallerTargetSchema } from "@/data/api/schemas/install";

export function downloadSpawnd(target: InstallerTarget): Promise<ArrayBuffer> {
  return api(`/api/install/spawnd/${pathPart(InstallerTargetSchema.parse(target))}`, {
    auth: false,
    responseType: "arrayBuffer",
  });
}

export function downloadSpawnWorker(target: InstallerTarget): Promise<ArrayBuffer> {
  return api(`/api/install/spawn-worker/${pathPart(InstallerTargetSchema.parse(target))}`, {
    auth: false,
    responseType: "arrayBuffer",
  });
}

export function getInstallScript(): Promise<string> {
  return api("/install.sh", { auth: false, responseType: "text" });
}
