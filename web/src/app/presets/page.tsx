"use client";

import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { PresetsManager } from "@/components/presets/PresetsManager";

export default function PresetsPage() {
  return (
    <AuthGate>
      <AppShell>
        <div className="mx-auto w-full max-w-2xl p-4 @container/settings @md/shell:p-6">
          <header className="mb-5">
            <h1 className="text-xl font-semibold tracking-tight">Presets</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Reusable agent commands and their installers.
            </p>
          </header>
          <PresetsManager />
        </div>
      </AppShell>
    </AuthGate>
  );
}
