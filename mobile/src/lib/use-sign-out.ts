import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";

import { useConnectionStore } from "@/data/stores/connection";

/** The complete local sign-out path for screens outside the profile drawer. */
export function useSignOut(): { signOut: () => Promise<void>; signingOut: boolean } {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = useCallback(async (): Promise<void> => {
    if (signingOut) return;
    setSigningOut(true);
    // Push registration is native-only and expensive to initialize. Load the
    // logout endpoint when this action is actually used, not when every setup
    // or approval screen renders.
    await import("@/data/api/endpoints/auth").then(({ logOut }) => logOut()).catch(() => undefined);
    useConnectionStore.getState().reset();
    queryClient.clear();
    router.replace("/login");
  }, [queryClient, router, signingOut]);

  return { signOut, signingOut };
}
