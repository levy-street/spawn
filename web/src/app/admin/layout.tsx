"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { PageSpinner } from "@/components/ui/spinner";
import { useAuth } from "@/lib/auth";

/**
 * The admin area's chrome and its client-side guard.
 *
 * The guard here is convenience, not security: it stops a non-admin from
 * staring at empty tables. Every admin API answers 404 to non-admins, so a
 * user who bypasses this UI learns nothing and can do nothing.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AdminChrome>{children}</AdminChrome>
    </AuthGate>
  );
}

function AdminChrome({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <PageSpinner label="Loading account" />;

  if (user !== null && !user.is_admin) {
    return (
      <div className="flex min-h-vv items-center justify-center px-4">
        <div className="max-w-sm space-y-3 text-center">
          <p className="text-sm font-medium">Nothing here</p>
          <p className="text-sm text-muted-foreground">
            This account does not administer this deployment.
          </p>
          <Link className="text-sm underline" href="/">
            Back to SPAWN D
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-vv pad-safe-top pad-safe-bottom">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">SPAWN D</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              admin
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="truncate">{user?.email}</span>
            <Link className="underline" href="/">
              Exit admin
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
