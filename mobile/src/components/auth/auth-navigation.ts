import { type Href, useRouter } from "expo-router";
import { useCallback } from "react";

/**
 * The rail's back control. A pushed account screen pops the way any native
 * screen does; one opened cold from a link has nothing behind it, so it falls
 * back to the screen it would have been pushed from rather than dead-ending.
 */
export function useAuthBack(fallback: Href = "/login"): () => void {
  const router = useRouter();
  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(fallback);
  }, [fallback, router]);
}
