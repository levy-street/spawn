"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { loginPathFor } from "@/lib/return-path";

/**
 * Wraps protected pages. If the `me()` call resolves to `null` (401), we
 * redirect to /login. While loading, render a tiny placeholder so we don't
 * flash the page contents to anonymous users.
 *
 * The destination rides along as `?next=`, so arriving at a gated page from
 * a public one (the `/download` -> `/device` handoff, or a pairing link) ends
 * where it was going instead of dumping you on the dashboard with whatever
 * you were carrying — a code, a `?ref=` — silently dropped.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AuthGatePlaceholder />}>
      <AuthGateInner>{children}</AuthGateInner>
    </Suspense>
  );
}

function AuthGatePlaceholder() {
  return (
    <div className="flex min-h-vv items-center justify-center text-sm text-muted-foreground">
      Loading...
    </div>
  );
}

function AuthGateInner({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    if (loading || user) return;
    router.replace(loginPathFor(`${pathname}${search ? `?${search}` : ""}`));
  }, [loading, user, router, pathname, search]);

  if (loading) return <AuthGatePlaceholder />;
  if (!user) return null;
  return <>{children}</>;
}
