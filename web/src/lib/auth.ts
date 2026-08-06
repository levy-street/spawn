"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError, auth, type User } from "@/lib/api";

/**
 * `useAuth()` resolves the current user from `/api/me`. The server uses
 * HTTP-only session cookies, so this is just a fetch with `credentials:
 * "include"`.
 */
export function useAuth() {
  const q = useQuery<{ user: User } | null>({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await auth.me();
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

export async function logout() {
  try {
    await auth.logout();
  } catch {
    // A failed logout call must never strand the user in the app — the
    // session may already be dead server-side (expired, or the account was
    // just deleted, which clears the cookie itself). Leaving is the point.
  }
  if (typeof window !== "undefined") window.location.assign("/login");
}
