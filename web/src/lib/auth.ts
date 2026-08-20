"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError, type AuthConfig, auth, type User } from "@/lib/api";

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

/**
 * `useAuthConfig()` resolves `GET /api/auth/config`: OAuth providers plus the
 * gates the server actually enforces (email verification, invite-only).
 * Public endpoint — safe to call signed out (login/signup/onboarding).
 */
export function useAuthConfig() {
  const q = useQuery<AuthConfig>({
    queryKey: ["auth-config"],
    queryFn: () => auth.config(),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return {
    config: q.data ?? null,
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
  // Out to the lander, not the login form: signing out is leaving, and being
  // dropped straight back onto a password field reads as a failed session
  // rather than a finished one. Signing in again is one nav click away.
  if (typeof window !== "undefined") window.location.assign("/");
}
