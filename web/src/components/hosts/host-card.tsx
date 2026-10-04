"use client";

import Link from "next/link";
import { useDaemonConnection } from "@/components/hosts/DaemonConnectionsProvider";
import { CapacityBar, HostDot, RunningLabel } from "@/components/hosts/fleet-parts";
import { HostHealthPanel } from "@/components/hosts/host-health-panel";
import { useHostLiveStatus } from "@/components/hosts/use-host-live-status";
import { HostUpdateBadge } from "@/components/release/HostUpdateDialog";
import { Button } from "@/components/ui/button";
import { useHostCapacity } from "@/hooks/useHostCapacity";
import { useInView } from "@/hooks/useInView";
import {
  bucketFill,
  bucketOf,
  capacityLabel,
  type FleetHostRow,
  formatDuration,
  hostToneLabel,
  specLine,
} from "@/lib/fleet";
import { formatHostPlatform } from "@/lib/host-platform";
import { cn } from "@/lib/utils";

/**
 * One host, at full resolution, on the Hosts page.
 *
 * Two sources, deliberately: the meter and the counts come from the host list
 * the whole app already polls, and the exact figures beside them come straight
 * from the daemon over `spawn.host.ctl` while the card is on screen. A card
 * whose host cannot be reached, or whose daemon has telemetry switched off,
 * simply keeps the coarse reading and says nothing further — it never shows an
 * empty gauge, because "idle" and "not reported" must not look the same.
 */
export function HostCard({ row }: { row: FleetHostRow }) {
  const host = row.host;
  const online = host.status === "online";
  // Exact figures are a channel on the connection this device already holds
  // to the host, so they cost nothing the server sees — but they are a request
  // every few seconds on the host. Only while somebody can see the card: it
  // scrolls out of view or the tab goes to the background, and the channel
  // closes with it.
  const [cardRef, inView] = useInView<HTMLElement>();
  const capacity = useHostCapacity(host.id, inView && online);
  // This device's connection, not only the server's word: a host that is
  // reconnecting says so on its own card, with the way to try again.
  const live = useHostLiveStatus(host);
  const connection = useDaemonConnection(host.id);
  const reconnecting = live?.reconnecting ?? false;
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
      ref={cardRef}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-card p-4",
        row.attention > 0 && "border-warning/40",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <HostDot
          tone={reconnecting ? "warning" : row.tone}
          label={reconnecting && live ? live.label : hostToneLabel(row)}
          pulse={reconnecting || row.tone === "active"}
        />
        <Link
          href={`/hosts/${host.id}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
        >
          {host.name}
        </Link>
        <HostUpdateBadge host={host} />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          {online ? formatHostPlatform(host) : "offline"}
        </span>
      </header>

      {reconnecting && live && (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs leading-5 text-warning">{live.label}</p>
          {connection && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2.5 text-xs"
              onClick={() => connection.retry()}
              aria-label={`Retry connection to ${host.name}`}
            >
              Retry
            </Button>
          )}
        </div>
      )}

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

      {!online && <HostHealthPanel host={host} compact />}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2.5">
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {row.live} {row.live === 1 ? "session" : "sessions"}
        </span>
        {row.attention > 0 && (
          <span className="font-mono text-[10px] text-warning">{row.attention} need you</span>
        )}
        <RunningLabel running={row.running} className="min-w-0 flex-1 text-right" />
      </footer>

      {online && capacity.unavailable && (
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
