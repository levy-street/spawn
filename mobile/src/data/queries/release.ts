import { useQuery } from "@tanstack/react-query";
import { getRelease } from "@/data/api/endpoints/release";
import { qk } from "@/data/queryKeys";

export function useRelease(enabled = true) {
  return useQuery({
    queryKey: qk.release(),
    queryFn: getRelease,
    enabled,
    staleTime: 0,
  });
}
