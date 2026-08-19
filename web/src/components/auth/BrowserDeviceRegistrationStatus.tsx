"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";

export function BrowserDeviceRegistrationStatus() {
  const { user } = useAuth();
  const registration = useBrowserDeviceRegistration(user?.id);

  if (!user || registration.isLoading || registration.data?.status === "ready") return null;

  if (registration.isError) {
    return (
      <div className="border-destructive/50 border-b bg-destructive/10 px-4 py-3" role="alert">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            Browser identity registration failed. Identity-dependent connections are disabled;
            account recovery and revocation remain available.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void registration.refetch()}>
              Retry registration
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/settings">Open device settings</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const cleanupPending = registration.data?.status === "cleanup_pending";
  return (
    <div className="border-warning/40 border-b bg-warning-soft px-4 py-3" role="alert">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          {cleanupPending
            ? "This browser key is revoked on the server, but local key deletion still needs attention."
            : "This browser identity is revoked. Create a replacement explicitly in device settings before using identity-dependent connections."}
        </p>
        <Button asChild size="sm" variant="outline">
          <Link href="/settings">Open device settings</Link>
        </Button>
      </div>
    </div>
  );
}
