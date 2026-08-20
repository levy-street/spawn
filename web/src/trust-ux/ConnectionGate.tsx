"use client";

/**
 * Connection-refused moments (DESIGN.md §5.7): terminal states with a named
 * remedy — never spinners, never auto-retry, never "connection failed".
 * Includes the R1 live-teardown takeover and the session verified chip whose
 * absence is meaningful.
 */

import { Btn, Card, Dot } from "./bits";
import type { ConnectionRefusal, VerifiedBasis } from "./types";

export interface ConnectionGateProps {
  refusal: ConnectionRefusal;
  onUsePasskey: () => void;
  onLinkThisDevice: () => void;
  onShowPairingInstructions: (hostName: string) => void;
  onOpenSecurity: () => void;
}

export function ConnectionGate({
  refusal,
  onUsePasskey,
  onLinkThisDevice,
  onShowPairingInstructions,
  onOpenSecurity,
}: ConnectionGateProps) {
  switch (refusal.kind) {
    case "device-removed":
      return (
        <Card tone="danger">
          <div className="flex items-center gap-2">
            <Dot tone="danger" />
            <h3 className="font-semibold text-neutral-900">This device was removed</h3>
          </div>
          <p className="mt-2 text-sm text-neutral-700">
            It was removed from the account on {refusal.removedAt}, from{" "}
            {refusal.removedByDeviceName}. Removal is permanent — if this was you, or if in doubt,
            there&apos;s nothing to do.
          </p>
          <p className="mt-2 text-sm text-neutral-700">
            To use spawn here again, link this device as new from a trusted device.
          </p>
          <div className="mt-3">
            <Btn kind="primary" onClick={onLinkThisDevice}>
              Link this device as new
            </Btn>
          </div>
        </Card>
      );

    case "session-ended-removed":
      return (
        <Card tone="danger">
          <div className="flex items-center gap-2">
            <Dot tone="danger" />
            <h3 className="font-semibold text-neutral-900">
              Session ended: this device&apos;s access was removed
            </h3>
          </div>
          <p className="mt-2 text-sm text-neutral-700">
            Your access was removed just now, and this session was closed everywhere. This is not a
            network problem, and reconnecting will not work.
          </p>
          <p className="mt-2 text-sm text-neutral-700">
            If you didn&apos;t expect this, your account owner — you, on another device — did it
            deliberately.
          </p>
          <div className="mt-3">
            <Btn kind="quiet" onClick={onLinkThisDevice}>
              Link this device as new
            </Btn>
          </div>
        </Card>
      );

    case "trust-path-broken":
      return (
        <Card tone="warn">
          <div className="flex items-center gap-2">
            <Dot tone="warn" />
            <h3 className="font-semibold text-neutral-900">Trust path broken</h3>
          </div>
          <p className="mt-2 text-sm text-neutral-700">
            This device&apos;s access ran through {refusal.throughDeviceName}, which has been
            removed.
          </p>
          <div className="mt-3 flex gap-2">
            {refusal.passkeyAvailable ? (
              <Btn kind="primary" onClick={onUsePasskey}>
                Use your passkey to re-secure this device
              </Btn>
            ) : (
              <Btn kind="primary" onClick={onLinkThisDevice}>
                Re-link from another trusted device
              </Btn>
            )}
            <Btn kind="quiet" onClick={onOpenSecurity}>
              Open Security
            </Btn>
          </div>
        </Card>
      );

    case "host-orphaned":
      return (
        <Card tone="danger">
          <div className="flex items-center gap-2">
            <Dot tone="danger" />
            <h3 className="font-semibold text-neutral-900">{refusal.hostName} is unreachable</h3>
          </div>
          <p className="mt-2 text-sm text-neutral-700">
            {refusal.hostName} no longer trusts any of your devices. This requires pairing again at
            the machine — no remote fix exists, by design.
          </p>
          <div className="mt-3">
            <Btn kind="primary" onClick={() => onShowPairingInstructions(refusal.hostName)}>
              Show pairing instructions
            </Btn>
          </div>
        </Card>
      );

    case "host-added-elsewhere":
      return (
        <Card tone="warn">
          <div className="flex items-center gap-2">
            <Dot tone="warn" />
            <h3 className="font-semibold text-neutral-900">
              {refusal.hostName} was added from another device
            </h3>
          </div>
          <p className="mt-2 text-sm text-neutral-700">
            Without a passkey, hosts reach your other devices when you re-link. Open spawn on{" "}
            {refusal.pairingDeviceName}, or re-link this device with it.
          </p>
          <div className="mt-3">
            <Btn kind="primary" onClick={onLinkThisDevice}>
              Re-link this device
            </Btn>
          </div>
        </Card>
      );
  }
}

/** The session chip (always present when connected; refusals never coexist with it). */
export function VerifiedChip({ basis }: { basis: VerifiedBasis }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-green-600 px-2 py-0.5 text-xs text-green-700"
      title={
        basis.kind === "passkey" ? "Backed by your passkey" : `Vouched for by ${basis.deviceName}`
      }
    >
      <Dot tone="ok" />
      End-to-end encrypted — verified
    </span>
  );
}
