import { runningAgent } from "@/data/selectors/agent";
import { sessionAttention } from "@/data/selectors/session";
import type {
  AgentDef,
  FleetRollup,
  Host,
  HostCapacitySummary,
  HostPresence,
  Session,
} from "@/data/types/domain";

export function hostPresence(host: Host | null | undefined): HostPresence {
  if (!host) return "unknown";
  return host.status === "online" ? "online" : "offline";
}

export function hostCapacitySummary(host: Host): HostCapacitySummary {
  const online = host.status === "online";
  return {
    online,
    cpuSegments: online ? host.cpu_bucket : null,
    memorySegments: online ? host.mem_bucket : null,
    hasTelemetry: host.capacity_at !== null,
    sessionRows: host.session_count,
  };
}

export interface HostAvailability {
  online: boolean;
  canLaunch: boolean;
  reason: "offline" | null;
}

/** Host telemetry is display-only; online presence is the only launch availability gate. */
export function hostAvailability(host: Host): HostAvailability {
  const online = host.status === "online";
  return { online, canLaunch: online, reason: online ? null : "offline" };
}

export function sortHosts(hosts: readonly Host[]): Host[] {
  return [...hosts].sort((a, b) => {
    const presence = Number(b.status === "online") - Number(a.status === "online");
    return (
      presence ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id)
    );
  });
}

export function sessionsForHost(sessions: readonly Session[], hostId: string): Session[] {
  return sessions
    .filter((session) => session.host_id === hostId)
    .sort(
      (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || a.id.localeCompare(b.id),
    );
}

export function fleetRollup(
  hosts: readonly Host[],
  sessions: readonly Session[],
  agents: readonly AgentDef[],
): FleetRollup {
  const hostIds = new Set(hosts.map((host) => host.id));
  const fleetSessions = sessions.filter((session) => hostIds.has(session.host_id));
  const liveSessions = fleetSessions.filter(
    (session) => session.status !== "exited" && session.status !== "killed",
  );
  return {
    hosts: hosts.length,
    onlineHosts: hosts.filter((host) => host.status === "online").length,
    offlineHosts: hosts.filter((host) => host.status !== "online").length,
    sessionRows: hosts.reduce((total, host) => total + host.session_count, 0),
    liveSessions: liveSessions.length,
    runningAgents: liveSessions.filter(
      (session) => runningAgent(session.foreground_command, agents) !== null,
    ).length,
    attention: fleetSessions.filter((session) => sessionAttention(session) !== null).length,
  };
}
