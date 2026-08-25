"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { stashDeviceApproval } from "@/lib/device-approval-stash";

/**
 * Wraps protected pages. If the `me()` call resolves to `null` (401), we
 * redirect to /login. While loading, render a tiny placeholder so we don't
 * flash the page contents to anonymous users.
 *
 * The current path + query is carried as `?next=`. `/device` first stashes its
 * ref and out-of-band `#k=` in tab-scoped sessionStorage: a URL fragment cannot
 * survive an OAuth server redirect, and putting it in `next` would send the
 * host key through that redirect instead of keeping it out-of-band.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      try {
        stashDeviceApproval(window.sessionStorage, window.location.href);
      } catch {
        // Storage can be disabled. The safe fallback is still the URL's
        // identifier and the full-fingerprint compare after login.
      }
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
