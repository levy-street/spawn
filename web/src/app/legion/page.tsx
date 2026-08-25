"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Radio, RadioTower } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { LegionHostCard } from "@/components/legion/LegionHostCard";
import { Stat } from "@/components/legion/legion-parts";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { hosts, sessions } from "@/lib/api";
import { formatBytes, summarizeLegion, summaryLine } from "@/lib/legion";

/**
 * The legion at full resolution: every machine, its capacity, and what is on
 * it. The sidebar strip's `+N more` lands here, and so does its rail.
 *
 * This is also where live figures are worth paying for. Each card can open a
 * direct `spawn.host.ctl` channel to its host for exact per-second CPU and
 * memory — connections that cost real setup, which is why they are off by
 * default and why the page turns them off the moment you leave it (the cards
 * unmount and their hooks close the channels).
 */
export default function LegionPage() {
  return (
    <AuthGate>
      <AppShell>
        <LegionBody />
      </AppShell>
    </AuthGate>
  );
}

function LegionBody() {
  const router = useRouter();
  const [liveMetrics, setLiveMetrics] = useState(false);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, refetchInterval: 15_000 });
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    refetchInterval: 5_000,
  });

  const summary = summarizeLegion(hostsQ.data ?? [], sessionsQ.data ?? []);
  const memory = formatBytes(summary.memoryBytes);
  const loading = hostsQ.isLoading;

  return (
    // The shell's <main> is `overflow-hidden` on desktop, so a page taller than
    // the viewport carries its own scroller — otherwise it is clipped, and the
    // sidebar rides up with the document instead of staying put.
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">The legion</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {loading ? "Counting your machines…" : summaryLine(summary)}
            </p>
          </div>
          <Button
            type="button"
            variant={liveMetrics ? "default" : "outline"}
            size="sm"
            aria-pressed={liveMetrics}
            onClick={() => setLiveMetrics((value) => !value)}
          >
            {liveMetrics ? (
              <RadioTower className="size-4" aria-hidden />
            ) : (
              <Radio className="size-4" aria-hidden />
            )}
            {liveMetrics ? "Live" : "Go live"}
          </Button>
        </header>

        <section
          aria-label="Fleet totals"
          className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-3 lg:grid-cols-5"
        >
          <Stat value={`${summary.hostsOnline}/${summary.hosts}`} label="hosts online" />
          {summary.cores > 0 && <Stat value={summary.cores} label="cores possessed" />}
          {memory && <Stat value={memory} label="memory" />}
          <Stat value={summary.sessions} label="live sessions" />
          <Stat value={summary.attention} label="need you" accent={summary.attention > 0} />
        </section>

        {liveMetrics && (
          // Said once, on the surface that does it, because it is the actual
          // differentiator and not a footnote: these numbers never reach the
          // control plane at all.
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
            Live figures come straight from each daemon over its direct channel. They never pass
            through the spawnd server, which only ever sees a five-level reading on the
            thirty-second heartbeat.
          </p>
        )}

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : summary.rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center">
            <p className="text-sm text-muted-foreground">No hosts possessed yet.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => router.push("/device")}
            >
              <Plus className="size-4" aria-hidden />
              Possess a machine
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {summary.rows.map((row) => (
              <LegionHostCard key={row.host.id} row={row} live={liveMetrics} />
            ))}
            {/* The empty rack slot, at page scale. Same argument as the strip's:
             * host count is the number that makes every other figure here worth
             * looking at, so the surface that shows it should ask for one more. */}
            <button
              type="button"
              onClick={() => router.push("/device")}
              className="group/slot flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <Plus
                className="size-5 transition-transform duration-150 group-hover/slot:rotate-90"
                aria-hidden
              />
              <span className="text-sm">Possess another machine</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
