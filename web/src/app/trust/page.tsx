"use client";

import { useEffect } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { openSettings } from "@/components/settings/settings-dialog-store";

/**
 * Device trust lives in the settings modal now; this route stays as the
 * stable deep link and opens that tab over this (empty) shell. The dialog
 * navigates to the dashboard when it closes.
 */
function TrustRedirect() {
  useEffect(() => {
    openSettings("trust");
  }, []);
  return null;
}

export default function TrustPage() {
  return (
    <AuthGate>
      <AppShell>
        <TrustRedirect />
      </AppShell>
    </AuthGate>
  );
}
