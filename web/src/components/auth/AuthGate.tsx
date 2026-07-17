"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/lib/auth";

/**
 * Wraps protected pages. If the `me()` call resolves to `null` (401), we
 * redirect to /login. While loading, render a tiny placeholder so we don't
 * flash the page contents to anonymous users.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading, error } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !error && !user) router.replace("/login");
  }, [error, loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-vv items-center justify-center text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="flex min-h-vv items-center justify-center text-sm text-destructive"
        role="alert"
      >
        Authentication is unavailable. Retry before continuing.
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}
