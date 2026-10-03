import { type HostLiveStatus, hostLiveStatus } from "@/data/selectors/host-live";
import { useConnectionStore } from "@/data/stores/connection";

/** A host's live status for this device, and a way to retry it from there. */
export function useHostLiveStatus(host: { id: string; name: string; status: string }): {
  status: HostLiveStatus;
  retry: (() => void) | null;
} {
  const state = useConnectionStore((current) => current.hostTransports[host.id] ?? null);
  const problem = useConnectionStore((current) => current.hostProblems[host.id] ?? null);
  const seenReady = useConnectionStore((current) => current.hostsSeenReady[host.id] === true);
  const retry = useConnectionStore((current) => current.hostRetries[host.id] ?? null);
  return { status: hostLiveStatus(host, { state, problem, seenReady }), retry };
}
