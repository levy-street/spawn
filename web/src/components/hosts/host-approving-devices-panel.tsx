"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Laptop } from "lucide-react";
import { ApiError, browserDevices, trust } from "@/lib/api";
import { hostPinCapacityWarning } from "@/lib/host-pin-hygiene";

export function HostApprovingDevicesPanel({ hostId }: { hostId: string }) {
  const status = useQuery({
    queryKey: ["trust", "host-pins", hostId],
    queryFn: () => trust.hostPinStatus(hostId),
    refetchInterval: 15_000,
  });
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: () => browserDevices.list(),
  });

  // A server old enough not to expose this route keeps the pre-Phase-D host
  // page. Existing old servers return the legacy string array, normalized by
  // api.ts, so they still get the list without capacity/delivery metadata.
  if (status.error instanceof ApiError && status.error.status === 404) return null;

  const warning = hostPinCapacityWarning(status.data?.capacity ?? null);
  const deviceName = (deviceId: string): string =>
    devices.data?.find((device) => device.id === deviceId)?.label ?? "Unnamed device";

  return (
    <section
      className="overflow-hidden rounded-xl border border-border"
      aria-labelledby="host-approving-devices-title"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 id="host-approving-devices-title" className="text-sm font-medium">
          Approving devices
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {status.data?.capacity?.used ?? status.data?.pins.length ?? 0}
            {status.data?.capacity ? ` of ${status.data.capacity.max}` : ""}
          </span>
        </h2>
      </div>
      {warning !== null && (
        <div
          className="flex items-start gap-2 border-b border-border bg-amber-500/5 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
          role="status"
          data-testid="host-pin-capacity-warning"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{warning}</p>
        </div>
      )}
      {status.isLoading && <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>}
      {status.error && !(status.error instanceof ApiError && status.error.status === 404) && (
        <p className="px-4 py-3 text-sm text-destructive">Could not load approving devices.</p>
      )}
      {!status.isLoading && !status.error && status.data?.pins.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No devices have approved this host yet.
        </p>
      )}
      <ul className="divide-y divide-border">
        {(status.data?.pins ?? []).map((pin) => (
          <li
            key={pin.browser_device_id}
            className="flex items-center gap-3 px-4 py-3"
            data-testid="host-approving-device"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Laptop className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {deviceName(pin.browser_device_id)}
            </span>
            {!pin.delivered && (
              <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                Not delivered
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
