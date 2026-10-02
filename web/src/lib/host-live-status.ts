import type { DaemonSnapshot } from "./daemon-connection";

export type HostLiveTone = "active" | "warning" | "offline";

export type HostLiveStatus = {
  tone: HostLiveTone;
  /** Short, for a tooltip or a dot's label. */
  label: string;
  /** Set when the connection needs attention rather than just time. */
  problem: string | null;
  /** True while this device is not connected to a host the server sees online. */
  reconnecting: boolean;
};

/**
 * What a host's dot says, from what this device can actually reach rather
 * than only what the server last heard. The server's word decides offline;
 * this device's connection decides whether an online host is reachable from
 * here right now, which is what a person typing into it needs to know.
 */
export function hostLiveStatus(
  host: { name: string; status: string },
  snapshot: Pick<DaemonSnapshot, "state" | "error"> | null,
): HostLiveStatus {
  if (host.status !== "online") {
    return {
      tone: "offline",
      label: `${host.name} is offline`,
      problem: null,
      reconnecting: false,
    };
  }
  if (!snapshot || snapshot.state === "ready") {
    return {
      tone: "active",
      label: `Connected to ${host.name}`,
      problem: null,
      reconnecting: false,
    };
  }
  if (snapshot.error || snapshot.state === "error" || snapshot.state === "unauthorized") {
    const problem = snapshot.error ?? `Can't reach ${host.name} from this device.`;
    return { tone: "warning", label: problem, problem, reconnecting: true };
  }
  return {
    tone: "warning",
    label: `Reconnecting to ${host.name}…`,
    problem: null,
    reconnecting: true,
  };
}
