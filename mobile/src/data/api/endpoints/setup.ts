import { api } from "@/data/api/client";
import { jsonBody, pathPart } from "@/data/api/endpoints/helpers";
import {
  type SetupClaimCreateResponse,
  SetupClaimCreateResponseSchema,
  type SetupClaimStatus,
  SetupClaimStatusSchema,
} from "@/data/api/schemas/setup";

export function createSetupClaim(): Promise<SetupClaimCreateResponse> {
  return api("/api/setup/claims", {
    method: "POST",
    body: jsonBody({}),
    schema: SetupClaimCreateResponseSchema,
  });
}

export function getSetupClaim(token: string): Promise<SetupClaimStatus> {
  return api(`/api/setup/claims/${pathPart(token)}`, { schema: SetupClaimStatusSchema });
}
