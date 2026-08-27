import type { HostOut } from "@/data/api/schemas/hosts";

export interface HostCapacitySample {
  cpu_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  load_one?: number | null;
  uptime_seconds: number;
}

export interface HostCapacitySpec {
  cpu_cores: number;
  cpu_physical_cores?: number | null;
  cpu_model?: string | null;
  memory_bytes: number;
  gpu?: string | null;
}

export interface HostMetrics {
  sample: HostCapacitySample;
  spec: HostCapacitySpec | null;
}

export type CapacityPresentation =
  | {
      source: "exact";
      cpuPercent: number;
      memoryPercent: number;
      memoryUsedBytes: number;
      memoryTotalBytes: number;
      loadOne: number | null;
      uptimeSeconds: number;
    }
  | { source: "bucketed"; cpuSegments: number; memorySegments: number }
  | { source: "unavailable" };

const CAPACITY_LABELS = ["Idle", "Light", "Working", "Busy", "Heavy", "Pinned"] as const;

function trimmedValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function formatHostOS(value: string | null | undefined): string {
  const trimmed = trimmedValue(value);
  if (trimmed === null) return "Unknown OS";
  switch (trimmed.toLocaleLowerCase()) {
    case "darwin":
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "windows":
      return "Windows";
    default:
      return trimmed;
  }
}

export function formatHostArch(value: string | null | undefined): string {
  const trimmed = trimmedValue(value);
  if (trimmed === null) return "Unknown architecture";
  switch (trimmed.toLocaleLowerCase()) {
    case "aarch64":
    case "arm64":
      return "ARM64";
    case "x86_64":
    case "amd64":
      return "x64";
    default:
      return trimmed;
  }
}

export function formatHostPlatform(host: Pick<HostOut, "arch" | "os">): string {
  return `${formatHostOS(host.os)} · ${formatHostArch(host.arch)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseHostMetrics(value: unknown): HostMetrics | null {
  if (!isRecord(value) || !isRecord(value["sample"])) return null;
  const sample = value["sample"];
  if (
    !finiteNumber(sample["cpu_percent"]) ||
    !finiteNumber(sample["memory_used_bytes"]) ||
    !finiteNumber(sample["memory_total_bytes"]) ||
    sample["memory_total_bytes"] <= 0 ||
    !finiteNumber(sample["uptime_seconds"])
  ) {
    return null;
  }
  const rawLoadOne = sample["load_one"];
  if (rawLoadOne !== undefined && rawLoadOne !== null && !finiteNumber(rawLoadOne)) return null;
  const loadOne = rawLoadOne === undefined || rawLoadOne === null ? null : rawLoadOne;

  let spec: HostCapacitySpec | null = null;
  if (value["spec"] !== undefined && value["spec"] !== null) {
    if (!isRecord(value["spec"])) return null;
    const rawSpec = value["spec"];
    if (!finiteNumber(rawSpec["cpu_cores"]) || !finiteNumber(rawSpec["memory_bytes"])) return null;
    const rawPhysical = rawSpec["cpu_physical_cores"];
    const model = rawSpec["cpu_model"];
    const gpu = rawSpec["gpu"];
    if (rawPhysical !== undefined && rawPhysical !== null && !finiteNumber(rawPhysical)) {
      return null;
    }
    if (
      (model !== undefined && model !== null && typeof model !== "string") ||
      (gpu !== undefined && gpu !== null && typeof gpu !== "string")
    ) {
      return null;
    }
    spec = {
      cpu_cores: rawSpec["cpu_cores"],
      memory_bytes: rawSpec["memory_bytes"],
      ...(rawPhysical === undefined ? {} : { cpu_physical_cores: rawPhysical as number | null }),
      ...(model === undefined ? {} : { cpu_model: model as string | null }),
      ...(gpu === undefined ? {} : { gpu: gpu as string | null }),
    };
  }

  return {
    sample: {
      cpu_percent: sample["cpu_percent"],
      memory_used_bytes: sample["memory_used_bytes"],
      memory_total_bytes: sample["memory_total_bytes"],
      uptime_seconds: sample["uptime_seconds"],
      load_one: loadOne,
    },
    spec,
  };
}

export function capacityPresentation(
  host: HostOut,
  metrics: HostMetrics | null,
): CapacityPresentation {
  if (metrics !== null) {
    const sample = metrics.sample;
    return {
      source: "exact",
      cpuPercent: Math.max(0, Math.min(100, sample.cpu_percent)),
      memoryPercent: Math.max(
        0,
        Math.min(100, (sample.memory_used_bytes / sample.memory_total_bytes) * 100),
      ),
      memoryUsedBytes: sample.memory_used_bytes,
      memoryTotalBytes: sample.memory_total_bytes,
      loadOne: sample.load_one ?? null,
      uptimeSeconds: Math.max(0, sample.uptime_seconds),
    };
  }
  if (host.status === "online" && host.cpu_bucket !== null && host.mem_bucket !== null) {
    return {
      source: "bucketed",
      cpuSegments: host.cpu_bucket,
      memorySegments: host.mem_bucket,
    };
  }
  return { source: "unavailable" };
}

export function capacityLabel(segments: number): string {
  const normalized = Math.max(0, Math.min(5, Math.round(segments)));
  return CAPACITY_LABELS[normalized] ?? CAPACITY_LABELS[0];
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function hostConnectionLabel(host: HostOut, now = Date.now()): string {
  if (host.status === "online") return `online · heartbeat ${relativeSeen(host.last_seen_at, now)}`;
  return `offline · last seen ${relativeSeen(host.last_seen_at, now)}`;
}

export function relativeSeen(value: string | null, now = Date.now()): string {
  if (value === null) return "never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "never";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
