"use client";

import { AuthGate } from "@/components/auth/AuthGate";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { AppShell } from "@/components/nav/AppShell";

export default function DevicePage() {
  return (
    <AuthGate>
      <AppShell>
        <main className="mx-auto w-full max-w-xl p-4 @md/shell:p-6">
          <ConnectHostSection />
        </main>
      </AppShell>
    </AuthGate>
  );
}
