"use client";

import { useQuery } from "@tanstack/react-query";
import { useDeviceTrustMap } from "@/components/trust/device-endorsement";
import { browserDevices, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";
import { computeTrustRoster } from "@/lib/trust-roster";

/**
 * Is THIS browser approved right now? The session gate's own test
 * (docs/TRUST_UX.md §3): the account's records reach this device's registered
 * row from an anchor, or a host pins it. A host that has not confirmed an
 * approval does not make the device unapproved — that is the host's state
 * (#138; `pinStanding` in lib/trust-roster.ts). Shared so the storage notice
 * asks exactly what the gate asks, rather than reading the host trust this
 * browser holds — which outlives the browser's own removal.
 *
 * The queries are the ones the app-wide ceremony host already keeps warm, so a
 * reader adds no requests. `refetchInterval` is for a reader that is itself
 * waiting on the answer (the gate, while its card is up).
 */
export function useCurrentDeviceApproval(options: {
  enabled: boolean;
  refetchInterval?: () => number;
}) {
  const { user } = useAuth();
  const registration = useBrowserDeviceRegistration(user?.id);
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
  });
  const edges = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
  });
  const trustMap = useDeviceTrustMap(options.enabled);

  const currentPublicKey = registration.data?.publicKey ?? null;
  const currentDevice =
    (devices.data ?? []).find((device) => device.public_key === currentPublicKey) ??
    (registration.data?.status === "ready" ? registration.data.device : undefined);

  const roster = computeTrustRoster(devices.data ?? [], edges.data ?? [], trustMap.anchorDeviceIds);
  const ready =
    registration.data?.status === "ready" &&
    trustMap.ready &&
    devices.data !== undefined &&
    edges.data !== undefined;
  const trusted =
    currentDevice !== undefined &&
    ((roster.get(currentDevice.id)?.chainTrusted ?? false) ||
      trustMap.trustedHostIdsFor(currentDevice.id).length > 0);

  return {
    currentDevice,
    /** Hosts with an identity key: only they refuse an unapproved device. */
    keyedHostCount: trustMap.keyedHosts.length,
    /** Every query behind `trusted` has answered. */
    ready,
    trusted,
  };
}
