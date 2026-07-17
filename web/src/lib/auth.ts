"use client";

import { type QueryClient, useQuery } from "@tanstack/react-query";
import { ApiError, auth, type User } from "@/lib/api";
import { establishBrowserTrustSession, invalidateBrowserTrust } from "@/lib/browser-trust-events";

/**
 * `useAuth()` resolves the current user from `/api/me`. The server uses
 * HTTP-only session cookies, so this is just a fetch with `credentials:
 * "include"`.
 */
export function useAuth() {
  const q = useQuery<{ user: User } | null>({
    queryKey: ["me"],
    queryFn: async ({ signal }) => {
      try {
        return await auth.me(signal);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 30_000,
  });

  return {
    user: q.data?.user ?? null,
    loading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
}

/** Commit a new cookie-authenticated account without retaining old-account cache. */
export function commitAuthenticatedUser(queryClient: QueryClient, user: User): void {
  invalidateBrowserTrust("account_change");
  const oldAccountPredicate = (query: { queryKey: readonly unknown[] }) =>
    query.queryKey[0] !== "me";
  void queryClient.cancelQueries({ predicate: oldAccountPredicate });
  queryClient.removeQueries({ predicate: oldAccountPredicate });
  queryClient.setQueryData(["me"], { user });
  establishBrowserTrustSession(user.id);
  void queryClient.invalidateQueries({ queryKey: ["me"] });
}

export async function logout() {
  invalidateBrowserTrust("logout");
  await auth.logout();
  if (typeof window !== "undefined") window.location.assign("/login");
}
