"use client";

/**
 * Reset passkey trust — the root revocation (DESIGN.md §5.5).
 * For suspected passkey compromise only. Every consequence named before a
 * typed confirmation; the reset runs under a passkey unlock, so devices are
 * re-backed by the successor immediately, while hosts backed only by the
 * passkey are orphaned (§4.1 rotation: the ratcheted anchors die with it).
 */

import { useState } from "react";
import { Btn, Card } from "./bits";

export interface ResetPasskeyTrustDialogProps {
  /** Hosts whose ONLY backing is the passkey — orphaned by the reset. */
  orphanedHostNames: string[];
  deviceCount: number;
  onConfirmReset: () => void;
  onCancel: () => void;
}

export function ResetPasskeyTrustDialog({
  orphanedHostNames,
  deviceCount,
  onConfirmReset,
  onCancel,
}: ResetPasskeyTrustDialogProps) {
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim().toLowerCase() === "reset";

  return (
    <Card tone="danger">
      <h3 className="font-semibold text-neutral-900">Reset passkey trust</h3>
      <p className="mt-1 text-sm text-neutral-700">
        Only for suspected passkey compromise — for example, if you no longer trust where your
        passkeys are synced. This retires everything your passkey has vouched for and starts fresh.
      </p>

      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-neutral-700">
        {orphanedHostNames.length > 0 ? (
          <li className="text-red-800">
            Hosts backed only by your passkey become unreachable until paired again at the machine:{" "}
            <span className="font-medium">{orphanedHostNames.join(", ")}</span>.
          </li>
        ) : (
          <li>No hosts rely only on the passkey, so none become unreachable.</li>
        )}
        <li>
          Your {deviceCount} {deviceCount === 1 ? "device stays" : "devices stay"} in the account
          and are re-backed by the new passkey trust immediately.
        </li>
        <li>The old passkey trust can never be restored.</li>
        <li>
          This does not remove any device. If you suspect a device, remove it first — resetting
          passkey trust without removing a compromised device protects nothing.
        </li>
      </ul>

      <label className="mt-3 block text-sm text-neutral-800">
        Type <span className="font-mono font-medium">reset</span> to confirm.
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-sm"
          placeholder="reset"
        />
      </label>

      <div className="mt-3 flex gap-2">
        <Btn kind="danger" onClick={onConfirmReset} disabled={!confirmed}>
          Reset passkey trust
        </Btn>
        <Btn kind="quiet" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </Card>
  );
}
