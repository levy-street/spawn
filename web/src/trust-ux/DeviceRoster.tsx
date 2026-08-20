"use client";

/**
 * The device roster (DESIGN.md §4.2) — the R4 detection surface.
 * Every device that can reach the account's hosts, with provenance sentences,
 * status pills, sole-key warnings, and an always-visible Remove.
 */

import { Btn, Card, Pill, SectionTitle } from "./bits";
import type { DeviceId, TrustDevice } from "./types";

export interface DeviceRosterProps {
  devices: TrustDevice[];
  passkeyActive: boolean;
  onLinkDevice: () => void;
  onRemoveDevice: (id: DeviceId) => void;
}

function provenanceSentence(d: TrustDevice): string {
  switch (d.provenance.kind) {
    case "first-device":
      return `First device on the account — added ${d.addedAt}`;
    case "linked":
      return `Linked ${d.provenance.at} — approved by ${d.provenance.byDeviceName}`;
    case "restored-by-passkey":
      return `Restored with your passkey ${d.provenance.at}`;
  }
}

function DeviceRow({
  device,
  passkeyActive,
  onRemove,
}: {
  device: TrustDevice;
  passkeyActive: boolean;
  onRemove: (id: DeviceId) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-neutral-100 py-3 first:border-t-0">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-neutral-900">{device.name}</span>
          <span className="text-xs text-neutral-400">{device.platform}</span>
          {device.isThisDevice ? <Pill tone="neutral">This device</Pill> : null}
          {device.backedByPasskey ? (
            <Pill tone="ok">Backed by your passkey</Pill>
          ) : device.vouchedForBy ? (
            <Pill tone={passkeyActive ? "warn" : "neutral"}>
              Vouched for by {device.vouchedForBy.deviceName}
            </Pill>
          ) : null}
        </div>
        <p className="text-xs text-neutral-500">
          {provenanceSentence(device)}
          {device.lastSeenAt ? ` · Last seen ${device.lastSeenAt}` : ""}
        </p>
        {!device.backedByPasskey && device.vouchedForBy && passkeyActive ? (
          <p className="text-xs text-amber-700">
            Will be backed by your passkey after your next passkey use.
          </p>
        ) : null}
        {device.soleKeyForHosts.length > 0 ? (
          <p className="text-xs text-amber-700">Only key to: {device.soleKeyForHosts.join(", ")}</p>
        ) : null}
      </div>
      <Btn kind="danger-quiet" onClick={() => onRemove(device.id)}>
        Remove
      </Btn>
    </div>
  );
}

export function DeviceRoster({
  devices,
  passkeyActive,
  onLinkDevice,
  onRemoveDevice,
}: DeviceRosterProps) {
  return (
    <Card>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <SectionTitle>Devices</SectionTitle>
          <p className="mt-1 text-sm text-neutral-500">
            Every device that can reach your hosts is on this list. If you see one you don&apos;t
            recognize, remove it.
          </p>
        </div>
        <Btn kind="primary" onClick={onLinkDevice}>
          Link a device
        </Btn>
      </div>
      <div>
        {devices.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            passkeyActive={passkeyActive}
            onRemove={onRemoveDevice}
          />
        ))}
      </div>
    </Card>
  );
}
