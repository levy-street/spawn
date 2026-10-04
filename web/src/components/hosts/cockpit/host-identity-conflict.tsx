"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SIGNED_RTC_REFUSAL_DETAIL, SIGNED_RTC_REFUSAL_NEXT_STEP } from "@/lib/signed-rtc-trust";

/**
 * The host answered with a key this browser never approved for it. The panel
 * names both honest possibilities — the owner's own reinstall, or something
 * impersonating the host — keeps every connection shut, and offers exactly
 * one way out: removal, then a fresh possession from the host's own terminal.
 * There is deliberately no "trust the new identity" control, here or anywhere.
 *
 * It sits above every section of the host's page, because no section works
 * while it is up. The phone's host page shows the same panel in the same words.
 */
export function HostIdentityConflict({
  removing,
  onRemove,
}: {
  removing: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      className="rounded-xl border border-warning/40 bg-warning-soft p-4"
      data-testid="host-identity-conflict"
      role="alert"
    >
      <p className="text-sm font-medium text-foreground">
        This host&apos;s identity changed — connections are blocked
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {SIGNED_RTC_REFUSAL_DETAIL.host_key_substituted}
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {SIGNED_RTC_REFUSAL_NEXT_STEP.host_key_substituted}
      </p>
      <div className="mt-3">
        <Button
          variant="destructive"
          size="sm"
          data-testid="conflict-remove-host"
          disabled={removing}
          onClick={onRemove}
        >
          <Trash2 className="size-4" aria-hidden />
          Remove this host
        </Button>
      </div>
    </div>
  );
}
