"use client";

import { AuthGate } from "@/components/auth/AuthGate";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { AppShell } from "@/components/nav/AppShell";

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
        <main className="mx-auto w-full max-w-xl p-4 @md/shell:p-6">
          <ConnectHostSection autoLoadFromUrl />
        </main>
      </AppShell>
    </AuthGate>
  );
}
