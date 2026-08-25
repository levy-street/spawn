import { api } from "@/data/api/client";
import { type Release, ReleaseSchema } from "@/data/api/schemas/release";

export function getRelease(): Promise<Release> {
  return api("/api/release", { auth: false, schema: ReleaseSchema });
}
