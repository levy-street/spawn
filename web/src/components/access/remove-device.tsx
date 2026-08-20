"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface OrphanVM {
  name: string;
  /** Protecting a host first needs it reachable; offline ones can't be saved in time. */
  online: boolean;
}

export interface RemoveDeviceDialogProps {
  deviceName: string;
  isThisDevice?: boolean;
  /** Hosts only this device can unlock (R5). Removing it strands them. */
  orphans?: OrphanVM[];
  hasPasskey: boolean;
  busy?: boolean;
  error?: string | null;
  onRemove?: () => void;
  onCancel?: () => void;
  onAddPasskey?: () => void;
}

/**
 * Revocation, in one breath: instant, everywhere, permanent (P3 + R1 + R10).
 * If the device is some host's only way in, the dialog says which (R5) and
 * steers to a passkey first — but never blocks. The passkey-protects-it promise
 * is only made for hosts that are online: an offline host can't be healed
 * before the removal lands.
 */
export function RemoveDeviceDialog({
  deviceName,
  isThisDevice = false,
  orphans = [],
  hasPasskey,
  busy = false,
  error = null,
  onRemove,
  onCancel,
  onAddPasskey,
}: RemoveDeviceDialogProps) {
  const online = orphans.filter((o) => o.online).map((o) => o.name);
  const offline = orphans.filter((o) => !o.online).map((o) => o.name);
  const parts: string[] = [];
  if (online.length > 0) {
    const one = online.length === 1;
    parts.push(
      `${formatList(online)} ${one ? "trusts" : "trust"} only this device.${
        hasPasskey
          ? ` You'll confirm with your passkey so ${one ? "it stays" : "they stay"} reachable.`
          : ` Remove it and ${
              one
                ? "it must be possessed again from its terminal"
                : "they must be possessed again from their terminals"
            } — or add a passkey first.`
      }`,
    );
  }
  if (offline.length > 0) {
    const one = offline.length === 1;
    parts.push(
      `${formatList(offline)} ${one ? "is" : "are"} offline and only ${
        one ? "trusts" : "trust"
      } this device — after removal ${
        one ? "it must be possessed again from its terminal" : "they must be possessed again"
      }.`,
    );
  }
  const orphanText = parts.join(" ");

  return (
    <div data-testid="remove-device-dialog">
      <h2 className="text-base font-medium tracking-tight text-foreground">Remove {deviceName}?</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        It loses access to every host — instantly and permanently. To use it again, you'd approve it
        as a new device.
      </p>
      {isThisDevice && (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          You're using this device right now. It stops working the moment you remove it.
        </p>
      )}
      {orphanText !== "" && (
        <div className="mt-3 flex gap-2.5 rounded-lg border border-amber-600/30 bg-amber-500/5 p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm leading-relaxed text-amber-800 dark:text-amber-200/90">
            {orphanText}
          </p>
        </div>
      )}
      {error !== null && (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {online.length > 0 && !hasPasskey ? (
          <>
            <Button className="w-full" disabled={busy} onClick={onAddPasskey}>
              Add a passkey first
            </Button>
            <Button
              className="w-full"
              variant="destructive"
              disabled={busy}
              data-testid="remove-confirm"
              onClick={onRemove}
            >
              {busy ? "Removing…" : "Remove anyway"}
            </Button>
          </>
        ) : (
          <Button
            className="w-full"
            variant="destructive"
            disabled={busy}
            data-testid="remove-confirm"
            onClick={onRemove}
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        )}
        <Button className="w-full" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function formatList(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
