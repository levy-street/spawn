"use client";

/**
 * Security overview strip (DESIGN.md §4.1): passkey state, counts, and every
 * outstanding warning with its remedy one tap away.
 */

import { Btn, Card, Dot, Muted } from "./bits";
import type { PasskeyStatus, TrustWarning } from "./types";

export interface SecurityOverviewProps {
  passkey: PasskeyStatus;
  deviceCount: number;
  hostCount: number;
  warnings: TrustWarning[];
  onCreatePasskey: () => void;
  onResetPasskeyTrust: () => void;
  /** Remedy tap for a warning row (parent routes to the right flow). */
  onWarningAction: (warning: TrustWarning) => void;
}

function warningKey(w: TrustWarning): string {
  switch (w.kind) {
    case "sole-key-host":
      return `sole-key-host:${w.hostName}`;
    case "new-device-nudge":
      return `new-device-nudge:${w.deviceName}`;
    default:
      return w.kind;
  }
}

function WarningRow({
  warning,
  onAction,
}: {
  warning: TrustWarning;
  onAction: (w: TrustWarning) => void;
}) {
  let text: string;
  let action: string | null;
  let tone: "warn" | "danger" | "neutral" = "warn";
  switch (warning.kind) {
    case "no-passkey":
      text =
        "No passkey. If you lose your devices, the only way back is at each machine's keyboard.";
      action = "Create passkey";
      tone = "danger";
      break;
    case "single-device-no-passkey":
      text =
        "This is your only device and you have no passkey. Losing it locks you out of every host.";
      action = "Create passkey";
      tone = "danger";
      break;
    case "sole-key-host":
      text = `${warning.hostName} trusts only ${warning.deviceName}. If that device is lost or removed, ${warning.hostName} must be paired again at the machine.`;
      action = "Back it with your passkey";
      break;
    case "awaiting-passkey-backup":
      text = `${warning.deviceCount} ${
        warning.deviceCount === 1 ? "device" : "devices"
      } will be backed by your passkey the next time you use it.`;
      action = null; // automatic — nothing to approve (DESIGN.md §1)
      tone = "neutral";
      break;
    case "new-device-nudge":
      text = `A device was added on ${warning.addedAt}: ${warning.deviceName}. Not you? Remove it.`;
      action = "Review devices";
      break;
  }
  return (
    <div className="flex items-start justify-between gap-3 border-t border-neutral-100 py-2 first:border-t-0">
      <div className="flex items-start gap-2">
        <span className="mt-1.5">
          <Dot tone={tone} />
        </span>
        <p className="text-sm text-neutral-700">{text}</p>
      </div>
      {action ? (
        <Btn kind="quiet" onClick={() => onAction(warning)}>
          {action}
        </Btn>
      ) : null}
    </div>
  );
}

export function SecurityOverview({
  passkey,
  deviceCount,
  hostCount,
  warnings,
  onCreatePasskey,
  onResetPasskeyTrust,
  onWarningAction,
}: SecurityOverviewProps) {
  return (
    <div className="space-y-3">
      {passkey.state === "active" ? (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Dot tone="ok" />
                <h3 className="font-semibold text-neutral-900">Passkey</h3>
              </div>
              <p className="mt-1 text-sm text-neutral-700">
                Backing {deviceCount} {deviceCount === 1 ? "device" : "devices"} and {hostCount}{" "}
                {hostCount === 1 ? "host" : "hosts"}. Created {passkey.createdAt}.
              </p>
              <button
                type="button"
                onClick={onResetPasskeyTrust}
                className="mt-2 text-xs text-neutral-400 underline hover:text-neutral-600"
              >
                Advanced: reset passkey trust
              </button>
            </div>
          </div>
        </Card>
      ) : (
        <Card tone="danger">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Dot tone="danger" />
                <h3 className="font-semibold text-neutral-900">No passkey</h3>
              </div>
              <p className="mt-1 text-sm text-neutral-700">
                If you lose your devices, the only way back is at each machine&apos;s keyboard. A
                passkey backs every device and host automatically.
              </p>
            </div>
            <Btn kind="primary" onClick={onCreatePasskey}>
              Create passkey
            </Btn>
          </div>
        </Card>
      )}

      {warnings.length > 0 ? (
        <Card tone="warn">
          <div>
            {warnings.map((w) => (
              <WarningRow key={warningKey(w)} warning={w} onAction={onWarningAction} />
            ))}
          </div>
        </Card>
      ) : passkey.state === "active" ? (
        <Muted>Everything is backed by your passkey.</Muted>
      ) : null}
    </div>
  );
}
