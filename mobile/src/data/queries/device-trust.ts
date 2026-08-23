import { useQuery } from "@tanstack/react-query";

import { listHosts } from "@/data/api/endpoints/hosts";
import type { HostOut } from "@/data/api/schemas/hosts";
import { qk } from "@/data/queryKeys";
import {
  type DeviceHostTrust,
  invalidateDeviceHostTrust,
  probeDeviceHostTrust,
} from "@/data/trust/device-trust";
import { APPROVAL_WATCH_INTERVAL_MS } from "@/data/trust/use-host-approval-watch";

export interface HostApproval {
  host: HostOut;
  trust: DeviceHostTrust;
}

async function probeAll(hosts: readonly HostOut[]): Promise<HostApproval[]> {
  // Approvals arrive from elsewhere, so a memoized verdict is exactly what a
  // caller watching for one must not be given.
  invalidateDeviceHostTrust();
  return Promise.all(
    hosts.map(async (host) => ({ host, trust: await probeDeviceHostTrust(host.id) })),
  );
}

export interface DeviceHostApprovals {
  approvals: readonly HostApproval[];
  approved: readonly HostApproval[];
  awaiting: readonly HostApproval[];
  /** False until at least one probe has resolved, so callers can hold their copy. */
  resolved: boolean;
  refetch: () => void;
}

export function useDeviceHostApprovals(live = false): DeviceHostApprovals {
  const hosts = useQuery({ queryKey: qk.hosts(), queryFn: listHosts, refetchInterval: 10_000 });
  const hostList = hosts.data ?? [];
  const hostIds = hostList.map((host) => host.id);
  const approvalsQuery = useQuery({
    queryKey: qk.deviceHostTrust(hostIds),
    queryFn: () => probeAll(hostList),
    enabled: hostIds.length > 0,
    ...(live ? { refetchInterval: APPROVAL_WATCH_INTERVAL_MS } : {}),
  });
  const approvals = approvalsQuery.data ?? [];
  return {
    approvals,
    approved: approvals.filter((entry) => entry.trust === "trusted"),
    // "unknown" is a probe that could not answer, not a refusal — never present
    // it as something the operator has to go fix.
    awaiting: approvals.filter((entry) => entry.trust === "untrusted"),
    resolved: hostIds.length === 0 || approvalsQuery.data !== undefined,
    refetch: () => void approvalsQuery.refetch(),
  };
}
