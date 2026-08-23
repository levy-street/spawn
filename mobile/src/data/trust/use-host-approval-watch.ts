import { useEffect, useState } from "react";

import {
  type DeviceHostTrust,
  invalidateDeviceHostTrust,
  probeDeviceHostTrust,
} from "@/data/trust/device-trust";

/** Long enough to stay quiet, short enough that an approval made on a laptop
 * lands while the operator is still looking at the phone. */
export const APPROVAL_WATCH_INTERVAL_MS = 3_000;

/**
 * Watches one host's approval of this device from a surface that is already
 * blocked on it. Deliberately plain React rather than a query: the terminal is
 * embedded in several hosts, and none of them should have to supply a
 * QueryClient just to notice an approval landing.
 */
export function useHostApprovalWatch(
  hostId: string | undefined,
  active: boolean,
  intervalMs = APPROVAL_WATCH_INTERVAL_MS,
): DeviceHostTrust {
  const [trust, setTrust] = useState<DeviceHostTrust>("unknown");

  useEffect(() => {
    if (!active || hostId === undefined) {
      setTrust("unknown");
      return;
    }
    let cancelled = false;
    const probe = async (): Promise<void> => {
      // The verdict changes elsewhere, so a memoized one is exactly what a
      // caller watching for a change must not be handed.
      invalidateDeviceHostTrust(hostId);
      const next = await probeDeviceHostTrust(hostId);
      if (!cancelled) setTrust(next);
    };
    void probe();
    const timer = setInterval(() => void probe(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, hostId, intervalMs]);

  return trust;
}
