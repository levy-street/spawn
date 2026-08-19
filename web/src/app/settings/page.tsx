"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { openSettings, type SettingsTab } from "@/components/settings/settings-dialog-store";

const TAB_KEYS: SettingsTab[] = ["account", "appearance", "devices", "trust", "skills"];

/**
 * Settings lives in the app-wide modal now. This route stays as the stable
 * deep link ("open Settings → Browser devices" instructions, bookmarks, old
 * copies of the approval callout): it opens the modal over this (empty)
 * shell. Navigating away happens when the dialog CLOSES — navigating here
 * would remount the dialog mid-interaction. `?tab=` picks a section; the
 * default is the device list, which is what nearly every external pointer
 * to /settings means.
 */
function SettingsRedirect() {
  const params = useSearchParams();
  useEffect(() => {
    const requested = params.get("tab") as SettingsTab | null;
    openSettings(requested !== null && TAB_KEYS.includes(requested) ? requested : "devices");
  }, [params]);
  return null;
}

export default function SettingsPage() {
  return (
    <AuthGate>
      <AppShell>
        <Suspense fallback={null}>
          <SettingsRedirect />
        </Suspense>
      </AppShell>
    </AuthGate>
  );
}
