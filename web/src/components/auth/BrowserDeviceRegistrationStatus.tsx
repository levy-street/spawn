"use client";

import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import {
  describeBrowserDeviceRegistrationFailure,
  useBrowserDeviceRegistration,
} from "@/lib/browser-device-registration";

export function BrowserDeviceRegistrationStatus() {
  const { user } = useAuth();
  const registration = useBrowserDeviceRegistration(user?.id);

  if (!user || registration.isLoading || registration.data?.status === "ready") return null;

  if (registration.isError) {
    // The same failure line for every cause taught readers to ignore it, and
    // offered a retry to browsers no retry could ever help. Say what happened,
    // and offer the button only where pressing it could change the answer.
    const failure = describeBrowserDeviceRegistrationFailure(registration.error);
    return (
      <div className="border-destructive/50 border-b bg-destructive/10 px-4 py-3" role="alert">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            {failure.reason} Identity-dependent connections are disabled; account recovery and
            revocation remain available.
            {failure.remedy === null ? "" : ` ${failure.remedy}`}
          </p>
          <div className="flex gap-2">
            {failure.canRetry ? (
              <Button size="sm" variant="secondary" onClick={() => void registration.refetch()}>
                Retry registration
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => openSettings("access")}>
              Open Access settings
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // "revoked" no longer parks: registration replaces a removed key seamlessly,
  // so the only sticky non-ready state is a local deletion that needs help.
  if (registration.data?.status !== "cleanup_pending") return null;
  return (
    <div className="border-warning/40 border-b bg-warning-soft px-4 py-3" role="alert">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          This device was removed, but deleting its old local key failed. Nothing can use that key
          anymore; retry from Access settings to finish cleaning up.
        </p>
        <Button size="sm" variant="outline" onClick={() => openSettings("access")}>
          Open Access settings
        </Button>
      </div>
    </div>
  );
}
