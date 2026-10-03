import type { TransportState } from "@/terminal/transport/types";

export type HostLiveTone = "active" | "warning" | "offline";

export interface HostLiveStatus {
  tone: HostLiveTone;
  label: string;
  problem: string | null;
  reconnecting: boolean;
}

/**
 * What a host's dot says, from what this device can actually reach rather
 * than only what the server last heard. The browser reads its connection the
 * same way (web/src/lib/host-live-status.ts). The server's word decides
 * offline; this device's connection decides whether an online host is
 * reachable from here right now.
 */
export function hostLiveStatus(
  host: { name: string; status: string },
  connection: { state: TransportState | null; problem: string | null; seenReady: boolean },
): HostLiveStatus {
  if (host.status !== "online") {
    return {
      tone: "offline",
      label: `${host.name} is offline`,
      problem: null,
      reconnecting: false,
    };
  }
  if (connection.problem) {
    return {
      tone: "warning",
      label: connection.problem,
      problem: connection.problem,
      reconnecting: true,
    };
  }
  if (connection.seenReady && connection.state !== null && connection.state !== "ready") {
    return {
      tone: "warning",
      label: `Reconnecting to ${host.name}…`,
      problem: null,
      reconnecting: true,
    };
  }
  return { tone: "active", label: `Connected to ${host.name}`, problem: null, reconnecting: false };
}
