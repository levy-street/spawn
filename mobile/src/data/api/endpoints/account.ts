import { authToken } from "@/data/api/auth-token";
import { api } from "@/data/api/client";
import { jsonBody } from "@/data/api/endpoints/helpers";
import {
  type AccountDeleteRequest,
  AccountDeleteRequestSchema,
  type MeResponse,
  MeResponseSchema,
} from "@/data/api/schemas/auth";

export function getMe(): Promise<MeResponse> {
  return api("/api/me", { schema: MeResponseSchema });
}

export async function deleteAccount(body: AccountDeleteRequest): Promise<void> {
  const credentials = await authToken.snapshot();
  await api<void>("/api/account/delete", {
    method: "POST",
    body: jsonBody(AccountDeleteRequestSchema.parse(body)),
  });
  await authToken.clearIfCurrent(credentials, "identity");
}
