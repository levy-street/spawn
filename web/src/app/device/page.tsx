"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { workspaces } from "@/lib/api";
import { restoreDeviceApproval } from "@/lib/device-approval-stash";

/**
 * Possessing a host (docs/TRUST_UX.md §4): `spawnd possess` opens/prints a
 * link that carries the host's identity key in its URL fragment. This route
 * is the one place that reads it — `autoLoadFromUrl` turns on the invisible
 * out-of-band check, so an exact match reduces the human's part to a single
 * Approve and a mismatch is refused outright.
 */
export default function DevicePage() {
  return (
    <AuthGate>
      <AppShell>
        <DeviceApprovalBody />
      </AppShell>
    </AuthGate>
  );
}

function DeviceApprovalBody() {
  const [restored, setRestored] = useState(false);
  const [approved, setApproved] = useState(false);
  const workspacesQ = useQuery({
    queryKey: ["workspaces", "all"],
    queryFn: async () => {
      const [active, archived] = await Promise.all([
        workspaces.list(),
        workspaces.list({ archived: true }),
      ]);
      return [...active, ...archived];
    },
    retry: 1,
  });

  useEffect(() => {
    const restoredPath = restoreDeviceApproval(window.sessionStorage, window.location.href);
    if (restoredPath) window.history.replaceState(window.history.state, "", restoredPath);
    setRestored(true);
  }, []);

  return (
    <main className="mx-auto w-full max-w-xl space-y-4 p-4 @md/shell:p-6">
      {restored ? (
        <ConnectHostSection
          autoLoadFromUrl
          mintSetupClaim={false}
          onPairingApproved={() => setApproved(true)}
        />
      ) : (
        <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
          Restoring approval…
        </div>
      )}
      {approved && workspacesQ.data?.length === 0 ? (
        <Button asChild className="w-full">
          <Link href="/onboarding">Continue setup</Link>
        </Button>
      ) : null}
    </main>
  );
}
