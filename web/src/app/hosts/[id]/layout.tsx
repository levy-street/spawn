"use client";

import type { ReactNode } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { HostCockpit } from "@/components/hosts/cockpit/host-cockpit";
import { AppShell } from "@/components/nav/AppShell";

/**
 * Every section of a host's page — Overview, Files, Sessions, Access — is its
 * own address under /hosts/[id], and this layout is the frame they share. As a
 * layout it stays mounted while you move between them, so the shell, the
 * header and the host's connection status carry over instead of reloading.
 */
export default function HostLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AppShell mainClassName="overflow-hidden">
        <HostCockpit>{children}</HostCockpit>
      </AppShell>
    </AuthGate>
  );
}
