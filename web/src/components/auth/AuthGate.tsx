"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/lib/auth";

/**
 * Wraps protected pages. If the `me()` call resolves to `null` (401), we
 * redirect to /login. While loading, render a tiny placeholder so we don't
 * flash the page contents to anonymous users.
 *
 * The current path (with its query) is carried as `?next=` so login can return
 * here afterwards — critical for `/device?ref=…`, whose approval handle would
 * otherwise be lost when a not-yet-signed-in browser is bounced to login.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      const here = window.location.pathname + window.location.search;
      const next = here && here !== "/" ? `?next=${encodeURIComponent(here)}` : "";
      router.replace(`/login${next}`);
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-vv items-center justify-center text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}
