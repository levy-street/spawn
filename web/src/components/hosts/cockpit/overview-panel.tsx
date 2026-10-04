"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderOpen, Plus } from "lucide-react";
import Link from "next/link";
import type { ComponentType } from "react";
import { useOpenHostFolder } from "@/components/files/use-open-host-folder";
import { CapacityBar } from "@/components/hosts/fleet-parts";
import { HostAgentsPanel } from "@/components/hosts/HostAgentsPanel";
import { HostHealthPanel } from "@/components/hosts/host-health-panel";
import { useHostOffers } from "@/components/hosts/use-host-offers";
import { HostUpdateBadge } from "@/components/release/HostUpdateDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHostCapacity } from "@/hooks/useHostCapacity";
import { useInView } from "@/hooks/useInView";
import { type Host, type Session, sessions, workspaces } from "@/lib/api";
import { bucketFill, bucketOf, capacityLabel, formatBytes, formatDuration } from "@/lib/fleet";
import {
  folderSubtitle,
  memoryFigure as formatMemoryFigure,
  hostFolders,
  hostTabHref,
  possessedLabel,
  runningHere,
} from "@/lib/host-cockpit";
import type { HostOfferSlotId } from "@/lib/host-offers";
import { formatHostPlatform } from "@/lib/host-platform";
import { displayPath, HOST_HOME } from "@/lib/places";
import { sessionHref } from "@/lib/sessions";
import { HOST_IDENTITY_BLOCKED_REASON } from "@/lib/signed-rtc-trust";
import { CockpitSection, Fact } from "./cockpit-section";
import { useHostCockpit } from "./host-cockpit";
import { HostSessionRow } from "./host-session-row";
import { OpenHereMenu } from "./open-here-menu";
import { UnfinishedMoves } from "./unfinished-moves";

/** Windows "Running here" lists before deferring to the Sessions tab. */
const RUNNING_SHOWN = 6;

/**
 * The Overview sections a host earns by advertising their capability family
 * (lib/host-offers.ts) — its conversations, its unfinished moves, its Claude
 * accounts, its boxes — keyed by slot. A slot's view lands here in the same
 * change that adds it to SHIPPED_HOST_OFFERS; Unfinished moves (M6) is the
 * first, as on the phone.
 */
const OVERVIEW_PANELS: Partial<Record<HostOfferSlotId, ComponentType<{ host: Host }>>> = {
  moves: UnfinishedMoves,
};

/**
 * A host at a glance: how hard it is working right now, what the machine is,
 * what runs on it and where, and which agents it has.
 */
export function HostOverview() {
  const { hostId, host, hostQuery, identityBlocked, openHostUpdate } = useHostCockpit();
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    staleTime: 5_000,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 30_000,
  });
  const offers = useHostOffers(hostId);

  if (hostQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 @md/shell:p-6">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (!host) return null;

  const all = sessionsQ.data ?? [];
  const running = runningHere(all, hostId, Number.POSITIVE_INFINITY);
  const online = host.status === "online";
  // Nothing on this page reaches the host while its identity is in question.
  const windowBlocked = identityBlocked
    ? HOST_IDENTITY_BLOCKED_REASON
    : online
      ? null
      : `${host.name} is offline.`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 @md/shell:p-6 @4xl/shell:grid-cols-2">
        {!online && (
          <div className="@4xl/shell:col-span-2">
            <HostHealthPanel host={host} />
          </div>
        )}
        {online && <RightNow host={host} reachable={!identityBlocked} />}
        <Machine host={host} onUpdate={openHostUpdate} />
        <RunningHere
          host={host}
          sessions={running.slice(0, RUNNING_SHOWN)}
          live={running.length}
          href={(session) => sessionHref(session.id, workspacesQ.data ?? [])}
          loading={sessionsQ.isLoading}
        />
        <Folders
          host={host}
          sessions={all}
          browsable={!identityBlocked}
          windowBlocked={windowBlocked}
        />
        <div className="@4xl/shell:col-span-2">
          <HostAgentsPanel host={host} />
        </div>
        {offers.panels.map((slot) => {
          const Panel = OVERVIEW_PANELS[slot.id];
          return Panel ? <Panel key={slot.id} host={host} /> : null;
        })}
      </div>
    </div>
  );
}

/**
 * Exact load, straight from the host over this device's own connection to
 * it, every three seconds while this section is on screen in a visible tab.
 * The server never sees these numbers; it holds a five-level reading from
 * the heartbeat, which is what shows until the first exact one arrives.
 */
function RightNow({ host, reachable }: { host: Host; reachable: boolean }) {
  const [ref, inView] = useInView<HTMLElement>();
  const capacity = useHostCapacity(host.id, inView && reachable);
  const sample = capacity.sample;
  const cpu = sample ? Math.round(sample.cpu_percent) : null;
  const memoryShare =
    sample && sample.memory_total_bytes > 0
      ? (sample.memory_used_bytes / sample.memory_total_bytes) * 100
      : null;
  const memoryBucket = memoryShare !== null ? bucketOf(memoryShare) : host.mem_bucket;
  const memoryFigure = sample
    ? formatMemoryFigure(sample.memory_used_bytes, sample.memory_total_bytes)
    : null;
  return (
    <section
      ref={ref}
      className="overflow-hidden rounded-xl border border-border"
      aria-labelledby="host-right-now-title"
    >
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 id="host-right-now-title" className="text-sm font-medium">
          Right now
        </h2>
        {capacity.live && (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            live
          </span>
        )}
      </div>
      <div className="space-y-3 p-4">
        {(cpu !== null || host.cpu_bucket !== null) && (
          <CapacityBar
            label="CPU"
            size="md"
            fill={cpu !== null ? cpu / 100 : bucketFill(host.cpu_bucket)}
            caption={cpu !== null ? `${cpu}%` : (capacityLabel(host.cpu_bucket) ?? undefined)}
          />
        )}
        {(memoryShare !== null || host.mem_bucket !== null) && (
          <CapacityBar
            label="MEM"
            size="md"
            fill={memoryShare !== null ? memoryShare / 100 : bucketFill(memoryBucket)}
            caption={
              memoryShare !== null
                ? `${Math.round(memoryShare)}%`
                : (capacityLabel(host.mem_bucket) ?? undefined)
            }
          />
        )}
        {sample && (
          // Exact figures only where exact figures arrived: the bars already
          // say what the heartbeat's five-level reading knows. Each is read
          // whole, wrapping in a narrow column rather than cut short.
          <dl className="grid grid-cols-3 gap-x-6 gap-y-3 text-sm">
            <Fact label="Memory" value={memoryFigure ?? "—"} wrap />
            <Fact
              label="Load"
              value={sample.load_one != null ? sample.load_one.toFixed(2) : "—"}
              wrap
            />
            <Fact
              label="Up"
              value={sample.uptime_seconds > 0 ? formatDuration(sample.uptime_seconds) : "—"}
              wrap
            />
          </dl>
        )}
        {!sample &&
          host.cpu_bucket === null &&
          host.mem_bucket === null &&
          !capacity.unavailable && (
            // Nothing known yet, and maybe never from here (this device not
            // approved, the connection down): say what the figures wait on.
            <p className="text-xs leading-5 text-muted-foreground">
              Live figures appear here while SPAWN D can reach {host.name}.
            </p>
          )}
        {capacity.unavailable && (
          // Named rather than hidden: a host that deliberately reports
          // nothing is a decision its owner made.
          <p className="text-xs leading-5 text-muted-foreground">
            This host does not report live capacity.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * What the machine is — system, CPU, cores, memory, GPU — then what SPAWN D
 * on it is, and since when it has been yours; the phone lists them the same.
 */
function Machine({ host, onUpdate }: { host: Host; onUpdate: () => void }) {
  const cores = host.cpu_cores
    ? host.cpu_physical_cores && host.cpu_physical_cores !== host.cpu_cores
      ? `${host.cpu_physical_cores} cores · ${host.cpu_cores} threads`
      : `${host.cpu_cores} ${host.cpu_cores === 1 ? "core" : "cores"}`
    : null;
  const possessed = possessedLabel(host.created_at);
  return (
    <CockpitSection id="host-machine" title="Machine">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 text-sm">
        <Fact label="System" value={formatHostPlatform(host)} />
        {host.cpu_model && <Fact label="CPU" value={host.cpu_model} />}
        {cores && <Fact label="Cores" value={cores} />}
        {host.memory_bytes !== null && (
          <Fact label="Memory" value={formatBytes(host.memory_bytes) ?? "—"} />
        )}
        {host.gpu && <Fact label="GPU" value={host.gpu} />}
        <Fact
          label="SPAWN D"
          value={
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="truncate">{host.version ?? "unknown"}</span>
              {(host.update.state === "available" || host.update.state === "updating") && (
                <button type="button" onClick={onUpdate}>
                  <HostUpdateBadge host={host} />
                </button>
              )}
            </span>
          }
        />
      </dl>
      {possessed && (
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {possessed}
        </p>
      )}
    </CockpitSection>
  );
}

function RunningHere({
  host,
  sessions: shown,
  live,
  href,
  loading,
}: {
  host: Host;
  sessions: Session[];
  /** Every live window here, of which `sessions` is the first few. */
  live: number;
  href: (session: Session) => string;
  loading: boolean;
}) {
  return (
    <CockpitSection
      id="host-running"
      title="Running here"
      count={live}
      action={
        <Link
          href={hostTabHref(host.id, "sessions")}
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          All sessions
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      {loading && <Skeleton className="m-4 h-12 w-[calc(100%-2rem)]" />}
      {!loading && shown.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">Nothing is running here.</p>
      )}
      <ul className="divide-y divide-border">
        {shown.map((session) => (
          <HostSessionRow key={session.id} session={session} href={href(session)} />
        ))}
      </ul>
    </CockpitSection>
  );
}

/**
 * Where work happens on this host — the folders its live windows run in, and
 * home — each one click from the file browser and from a new window there.
 * A folder is handed to Files in memory (`useOpenHostFolder`), never put in
 * the address: a host path is protected content.
 */
function Folders({
  host,
  sessions: all,
  browsable,
  windowBlocked,
}: {
  host: Host;
  sessions: Session[];
  /** False while the host's identity is in question: Files is shut. */
  browsable: boolean;
  windowBlocked: string | null;
}) {
  const folders = hostFolders(all, host.id);
  const openHostFolder = useOpenHostFolder();
  return (
    <CockpitSection id="host-folders" title="Folders">
      <ul className="divide-y divide-border">
        {folders.map((folder) => {
          const label = displayPath(folder.cwd);
          const name = (
            <>
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">{label}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {folderSubtitle(folder)}
                </span>
              </span>
            </>
          );
          return (
            <li key={folder.cwd} className="flex items-center gap-1 pr-2">
              {browsable ? (
                <button
                  type="button"
                  onClick={() =>
                    openHostFolder(host.id, folder.cwd === HOST_HOME ? null : folder.cwd)
                  }
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/40"
                  title={`Open ${label} in Files`}
                >
                  {name}
                </button>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5">{name}</span>
              )}
              <OpenHereMenu
                host={host}
                cwd={folder.cwd}
                disabledReason={windowBlocked}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    aria-label={`Open a window in ${label}`}
                  >
                    <Plus className="size-4" aria-hidden />
                  </Button>
                }
              />
            </li>
          );
        })}
      </ul>
    </CockpitSection>
  );
}
