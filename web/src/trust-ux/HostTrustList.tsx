"use client";

/**
 * Host trust list (DESIGN.md §4.3): per-host backing status, the R5 pre-warning
 * ("paired with one device only"), orphaned hosts with their remedy, and the
 * precise wording for removals pending on offline hosts (P3).
 */

import { Btn, Card, Dot, Pill, SectionTitle } from "./bits";
import type { HostId, TrustHost } from "./types";

export interface HostTrustListProps {
  hosts: TrustHost[];
  onPairHost: () => void;
  /** Orphaned-host remedy: show the pairing-at-the-machine instructions. */
  onShowPairingInstructions: (id: HostId) => void;
}

function HostRow({
  host,
  onShowPairingInstructions,
}: {
  host: TrustHost;
  onShowPairingInstructions: (id: HostId) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-neutral-100 py-3 first:border-t-0">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Dot tone={host.online ? "ok" : "neutral"} />
          <span className="font-medium text-neutral-900">{host.name}</span>
          <span className="text-xs text-neutral-400">{host.online ? "online" : "offline"}</span>
          {host.status.kind === "backed-by-passkey" ? (
            <Pill tone="ok">Backed by your passkey</Pill>
          ) : host.status.kind === "paired-only" ? (
            <Pill tone="warn">Paired with {host.status.deviceNames.join(", ")} only</Pill>
          ) : (
            <Pill tone="danger">Unreachable — needs pairing at the machine</Pill>
          )}
        </div>
        {host.status.kind === "backed-by-passkey" && host.status.alsoPairedWith.length > 0 ? (
          <p className="text-xs text-neutral-500">
            Also paired with {host.status.alsoPairedWith.join(", ")}.
          </p>
        ) : null}
        {host.status.kind === "paired-only" ? (
          <p className="text-xs text-amber-700">
            If {host.status.deviceNames.length === 1 ? "that device is" : "those devices are"} lost
            or removed, {host.name} must be paired again at the machine.
          </p>
        ) : null}
        {host.status.kind === "orphaned" ? (
          <p className="text-xs text-red-700">
            {host.name} no longer trusts any of your devices (its last key,{" "}
            {host.status.formerDeviceName}, was removed).
          </p>
        ) : null}
        {host.pendingRemovalApplies && !host.online ? (
          <p className="text-xs text-neutral-500">
            A device removal applies when this host next comes online.
          </p>
        ) : null}
      </div>
      {host.status.kind === "orphaned" ? (
        <Btn kind="quiet" onClick={() => onShowPairingInstructions(host.id)}>
          Show pairing instructions
        </Btn>
      ) : null}
    </div>
  );
}

export function HostTrustList({
  hosts,
  onPairHost,
  onShowPairingInstructions,
}: HostTrustListProps) {
  return (
    <Card>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <SectionTitle>Hosts</SectionTitle>
          <p className="mt-1 text-sm text-neutral-500">
            Machines running spawn. Every linked device can reach every host — there are no per-host
            permissions to manage.
          </p>
        </div>
        <Btn kind="primary" onClick={onPairHost}>
          Pair a host
        </Btn>
      </div>
      <div>
        {hosts.map((h) => (
          <HostRow key={h.id} host={h} onShowPairingInstructions={onShowPairingInstructions} />
        ))}
      </div>
    </Card>
  );
}
