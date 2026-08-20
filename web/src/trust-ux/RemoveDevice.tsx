"use client";

import { Button, DialogCard, IconAlert } from "./bits";

export interface OrphanVM {
  name: string;
  /** Protecting a computer first needs it reachable; offline ones can't be saved in time. */
  online: boolean;
}

export interface RemoveDeviceDialogProps {
  deviceName: string;
  isThisDevice?: boolean;
  /** Computers only this device can unlock (R5). Removing it strands them. */
  orphans?: OrphanVM[];
  recoveryOn: boolean;
  onRemove?: () => void;
  onCancel?: () => void;
  onTurnOnRecovery?: () => void;
}

/**
 * Revocation, in one breath: instant, everywhere, permanent (P3 + R1 + R10).
 * If the device is some computer's only way in, the dialog says which (R5) and
 * steers to recovery first — but never blocks. The passkey-protects-it promise
 * is only made for computers that are online: an offline computer can't be
 * healed before the removal lands.
 */
export function RemoveDeviceDialog({
  deviceName,
  isThisDevice = false,
  orphans = [],
  recoveryOn,
  onRemove,
  onCancel,
  onTurnOnRecovery,
}: RemoveDeviceDialogProps) {
  const online = orphans.filter((o) => o.online).map((o) => o.name);
  const offline = orphans.filter((o) => !o.online).map((o) => o.name);
  const orphaned = orphans.length > 0;
  const parts: string[] = [];
  if (online.length > 0) {
    const one = online.length === 1;
    parts.push(
      `${formatList(online)} ${one ? "trusts" : "trust"} only this device.${
        recoveryOn
          ? ` You'll confirm with your passkey so ${one ? "it stays" : "they stay"} reachable.`
          : ` Remove it and ${
              one
                ? "it must be set up again from its terminal"
                : "they must be set up again from their terminals"
            } — or turn on recovery first.`
      }`,
    );
  }
  if (offline.length > 0) {
    const one = offline.length === 1;
    parts.push(
      `${formatList(offline)} ${one ? "is" : "are"} offline and only ${
        one ? "trusts" : "trust"
      } this device — after removal ${
        one ? "it must be set up again from its terminal" : "they must be set up again"
      }.`,
    );
  }
  const orphanText = parts.join(" ");
  return (
    <DialogCard>
      <h2 className="text-base font-medium tracking-tight text-zinc-100">Remove {deviceName}?</h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        It loses access to every computer — instantly and permanently. To use it again, you'd link
        it as a new device.
      </p>
      {isThisDevice && (
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          You're using this device right now. You'll be signed out.
        </p>
      )}
      {orphaned && (
        <div className="mt-3 flex gap-2.5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
          <IconAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <p className="text-sm leading-relaxed text-amber-200/90">{orphanText}</p>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {online.length > 0 && !recoveryOn ? (
          <>
            <Button full onClick={onTurnOnRecovery}>
              Turn on recovery first
            </Button>
            <Button full variant="danger" onClick={onRemove}>
              Remove anyway
            </Button>
          </>
        ) : (
          <Button full variant="danger" onClick={onRemove}>
            Remove
          </Button>
        )}
        <Button full variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </DialogCard>
  );
}

function formatList(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
