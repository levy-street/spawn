"use client";

import { useQuery } from "@tanstack/react-query";
import { closeAlertSocket } from "@/lib/alert-socket";
import { ApiError, type AuthConfig, auth, type User } from "@/lib/api";
import { DESKTOP_SIGNED_OUT_MARKER, isDesktopShell } from "@/lib/platform";

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
  // Drop the alert stream first: a socket whose cookie has just been revoked
  // would otherwise sit in a reconnect loop against a 1008 until the redirect
  // tears the page down.
  closeAlertSocket();
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
  //
  // Inside the desktop shell that window has no address bar and no back, so
  // the lander is a room with no door. The mark tells the shell this arrival
  // is a sign-out and not a stale link, and it takes the window back to its
  // own sign-in wizard.
  if (typeof window !== "undefined") {
    const signedOut = isDesktopShell(window.navigator.userAgent)
      ? `/?${DESKTOP_SIGNED_OUT_MARKER}`
      : "/";
    window.location.assign(signedOut);
  }
}
