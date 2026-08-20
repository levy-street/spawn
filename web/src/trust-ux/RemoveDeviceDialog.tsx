"use client";

/**
 * Remove a device (DESIGN.md §5.5) — one dialog, three computed consequence
 * tiers: the always-true facts (instant online / on-reconnect offline, live
 * sessions end, permanent), orphaned hosts (R5, with heal-first as the primary
 * action when a passkey exists), and collateral pre-heal devices (P3'').
 * In the steady state it says, in so many words, that nothing else is affected.
 */

import { useState } from "react";
import { Btn, Card } from "./bits";
import type { RemoveDeviceConsequences, TrustDevice } from "./types";

export interface RemoveDeviceDialogProps {
  device: TrustDevice;
  consequences: RemoveDeviceConsequences;
  passkeyActive: boolean;
  onConfirmRemove: () => void;
  /** Passkey unlock that backs the orphan-risk hosts first, then removes with zero collateral. */
  onBackHostsFirst: () => void;
  onCancel: () => void;
}

export function RemoveDeviceDialog({
  device,
  consequences,
  passkeyActive,
  onConfirmRemove,
  onBackHostsFirst,
  onCancel,
}: RemoveDeviceDialogProps) {
  const [ackOrphans, setAckOrphans] = useState(false);
  const hasOrphans = consequences.orphanedHostNames.length > 0;
  const hasCollateral = consequences.collateralDevices.length > 0;
  const clean = !hasOrphans && !hasCollateral;

  return (
    <Card tone={hasOrphans ? "danger" : "warn"}>
      <h3 className="font-semibold text-neutral-900">Remove {device.name}?</h3>

      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-neutral-700">
        <li>
          Takes effect immediately on every online host
          {consequences.offlineHostCount > 0
            ? ` — ${consequences.offlineHostCount} offline ${
                consequences.offlineHostCount === 1 ? "host applies" : "hosts apply"
              } it the moment they next come online`
            : ""}
          .
        </li>
        {consequences.hasLiveSessions ? (
          <li>Any live session from {device.name} ends now.</li>
        ) : null}
        <li>Permanent. To use {device.name} again you&apos;ll link it as a new device.</li>
        {clean ? <li>No other device or host is affected.</li> : null}
      </ul>

      {hasOrphans ? (
        <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-800">
            {consequences.orphanedHostNames.join(", ")}{" "}
            {consequences.orphanedHostNames.length === 1 ? "trusts" : "trust"} only this device.
          </p>
          <p className="mt-1 text-sm text-red-800">
            Remove it and{" "}
            {consequences.orphanedHostNames.length === 1 ? "that host becomes" : "they become"}{" "}
            unreachable until you pair {consequences.orphanedHostNames.length === 1 ? "it" : "them"}{" "}
            again at the machine.
          </p>
          {passkeyActive ? (
            <div className="mt-2">
              <Btn kind="primary" onClick={onBackHostsFirst}>
                Back hosts with your passkey first
              </Btn>
              <p className="mt-1 text-xs text-red-800">
                One passkey use, then the removal proceeds with nothing orphaned.
              </p>
            </div>
          ) : null}
          <label className="mt-2 flex items-start gap-2 text-sm text-red-900">
            <input
              type="checkbox"
              checked={ackOrphans}
              onChange={(e) => setAckOrphans(e.target.checked)}
              className="mt-0.5"
            />
            I understand {consequences.orphanedHostNames.join(", ")} will need pairing again at the
            machine.
          </label>
        </div>
      ) : null}

      {hasCollateral ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">Also affected:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {consequences.collateralDevices.map((c) => (
              <li key={c.deviceName}>
                {c.deviceName}{" "}
                {c.restoredByNextPasskeyUse
                  ? "will lose access until your next passkey use."
                  : "will lose access. Re-link it from another device."}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-neutral-500">
        If in doubt, remove it — you can always link a device again.
      </p>

      <div className="mt-3 flex gap-2">
        <Btn kind="danger" onClick={onConfirmRemove} disabled={hasOrphans && !ackOrphans}>
          Remove {device.name}
        </Btn>
        <Btn kind="quiet" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </Card>
  );
}
