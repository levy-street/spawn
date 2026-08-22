import type { ProfileOut } from "@/data/api/schemas/legion";

export function formatProfileMemory(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  const gigabytes = bytes / 1024 ** 3;
  return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
}

export function formatProfileDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

export function profileStatsLine(profile: ProfileOut): string {
  const parts = [
    `${profile.totals.hosts} ${profile.totals.hosts === 1 ? "host" : "hosts"}`,
    ...(profile.totals.cores > 0 ? [`${profile.totals.cores} cores`] : []),
    ...(profile.totals.memory_bytes > 0 ? [formatProfileMemory(profile.totals.memory_bytes)] : []),
    `${profile.agents.reduce((total, agent) => total + agent.count, 0)} agent runs`,
  ];
  return `${parts.join(" · ")} — spawnd`;
}
