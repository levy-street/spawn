"use client";

import Link from "next/link";
import { CapacityBar, LegionDot, RunningLabel } from "@/components/legion/legion-parts";
import { HostUpdateBadge } from "@/components/release/HostUpdateDialog";
import { useHostCapacity } from "@/hooks/useHostCapacity";
import {
  bucketFill,
  bucketOf,
  capacityLabel,
  formatDuration,
  type LegionHostRow,
  specLine,
} from "@/lib/legion";
import { cn } from "@/lib/utils";

/**
 * One machine, at full resolution.
 *
 * Two sources, deliberately: the meter and the counts come from the host list
 * the whole app already polls, and the exact figures beside them come straight
 * from the daemon over `spawn.host.ctl` when `live` is on. A card whose host
 * cannot be reached, or whose daemon has telemetry switched off, simply keeps
 * the coarse reading and says nothing further — it never shows an empty gauge,
 * because "idle" and "not reported" must not look the same.
 */
export function LegionHostCard({
  row,
  /** Open a direct channel to this host for exact, per-second figures. */
  live,
}: {
  row: LegionHostRow;
  live: boolean;
}) {
  const host = row.host;
  const online = host.status === "online";
  const capacity = useHostCapacity(host.id, live && online);
  const spec = specLine({
    cpu_cores: capacity.spec?.cpu_cores ?? host.cpu_cores,
    memory_bytes: capacity.spec?.memory_bytes ?? host.memory_bytes,
    gpu: capacity.spec?.gpu ?? host.gpu,
  });

  // The exact sample wins when there is one; otherwise the heartbeat's bucket.
  const cpu = capacity.sample ? bucketOf(capacity.sample.cpu_percent) : row.cpuBucket;
  const memoryPercent = capacity.sample
    ? memoryShare(capacity.sample.memory_used_bytes, capacity.sample.memory_total_bytes)
    : null;
  const memory = memoryPercent !== null ? bucketOf(memoryPercent) : row.memBucket;

  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-card p-4",
        row.attention > 0 && "border-warning/40",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <LegionDot tone={row.tone} label={row.tone} pulse={row.tone === "active"} />
        <Link
          href={`/hosts/${host.id}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
        >
          {host.name}
        </Link>
        <HostUpdateBadge host={host} />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          {online ? host.os || "online" : "offline"}
        </span>
      </header>

      {spec && <p className="font-mono text-[10.5px] text-muted-foreground">{spec}</p>}

      {online && (cpu !== null || memory !== null) && (
        <div className="flex flex-col gap-2">
          <Gauge
            label="CPU"
            bucket={cpu}
            // An exact percentage only where one actually arrived. Everywhere
            // else the bucket gets a word, because a percentage computed from
            // a five-level reading would be invented precision.
            exact={capacity.sample ? Math.round(capacity.sample.cpu_percent) : null}
          />
          <Gauge
            label="MEM"
            bucket={memory}
            exact={memoryPercent !== null ? Math.round(memoryPercent) : null}
          />
        </div>
      )}

      {online && capacity.sample && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {capacity.sample?.load_one != null && (
            <span className="font-mono text-[10px] text-muted-foreground">
              load {capacity.sample.load_one.toFixed(2)}
            </span>
          )}
          {capacity.sample && capacity.sample.uptime_seconds > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              up {formatDuration(capacity.sample.uptime_seconds)}
            </span>
          )}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2.5">
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {row.live} {row.live === 1 ? "session" : "sessions"}
        </span>
        {row.attention > 0 && (
          <span className="font-mono text-[10px] text-warning">{row.attention} need you</span>
        )}
        <RunningLabel running={row.running} className="min-w-0 flex-1 text-right" />
      </footer>

      {live && online && capacity.unavailable && (
        // Named rather than hidden: a host that deliberately reports nothing is
        // a decision its owner made, and the panel should say so once.
        <p className="text-[10.5px] leading-4 text-muted-foreground">
          This host does not report live capacity.
        </p>
      )}
    </article>
  );
}

function Gauge({
  label,
  bucket,
  exact,
}: {
  label: string;
  bucket: number | null;
  /** Whole percent from a live sample, or null when only a bucket is known. */
  exact: number | null;
}) {
  if (bucket === null && exact === null) return null;
  return (
    <CapacityBar
      label={label}
      size="md"
      fill={exact !== null ? exact / 100 : bucketFill(bucket)}
      caption={exact !== null ? `${exact}%` : (capacityLabel(bucket) ?? undefined)}
    />
  );
}

function memoryShare(used: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return (used / total) * 100;
}
