import { api } from "@/data/api/client";
import { type ProfileOut, ProfileOutSchema } from "@/data/api/schemas/legion";

export function getProfile(): Promise<ProfileOut> {
  return api("/api/profile", { schema: ProfileOutSchema });
}
