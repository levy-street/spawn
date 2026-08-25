import { useMutation, useQuery } from "@tanstack/react-query";

import { createSetupClaim, getSetupClaim } from "@/data/api/endpoints/setup";
import { qk } from "@/data/queryKeys";

export const SETUP_CLAIM_POLL_MS = 2_000;

export function useCreateSetupClaimMutation() {
  return useMutation({ mutationFn: createSetupClaim });
}

export function useSetupClaimQuery(token: string | null, enabled: boolean) {
  return useQuery({
    queryKey: qk.setupClaim(token ?? "pending"),
    queryFn: () => {
      if (token === null) throw new Error("Setup claim is not ready");
      return getSetupClaim(token);
    },
    enabled: token !== null && enabled,
    refetchInterval: ({ state }) => {
      const status = state.data?.status;
      return status === "approved" || status === "failed" ? false : SETUP_CLAIM_POLL_MS;
    },
    retry: false,
  });
}
