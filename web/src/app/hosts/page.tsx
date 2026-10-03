"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Plus, Server } from "lucide-react";
import { useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { Stat } from "@/components/hosts/fleet-parts";
import { HostCard } from "@/components/hosts/host-card";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { hosts, sessions } from "@/lib/api";
import { formatBytes, summarizeFleet, summaryLine } from "@/lib/fleet";

/**
 * Hosts at full resolution: every computer you have possessed, its capacity,
 * and what is on it. The sidebar strip's label, its "All hosts" row and its
 * rail icon all land here, and so does `/legion` from before the rename.
 *
 * Exact figures are on for every card that is on screen while this tab is in
 * front (`HostCard`, `useInView`). They used to wait behind a "Go live" switch
 * because each one cost its own WebRTC connection; now each is a channel on
 * the connection this device already holds to that host, so the switch only
 * hid the numbers people opened the page to read.
 */
export default function HostsPage() {
  return (
    <AuthGate>
      <AppShell>
        <HostsBody />
      </AppShell>
    </AuthGate>
  );
}

function HostsBody() {
  const [possessOpen, setPossessOpen] = useState(false);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, refetchInterval: 15_000 });
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    refetchInterval: 5_000,
  });

  const summary = summarizeFleet(hostsQ.data ?? [], sessionsQ.data ?? []);
  const memory = formatBytes(summary.memoryBytes);
  const loading = hostsQ.isLoading;
  // A list that never arrived is not an empty account: there is nothing to
  // count, so the page says the load failed and offers to try again rather
  // than "No hosts yet." (the phone's Hosts tab does the same). A refetch
  // that fails after a good load keeps the hosts it already has.
  const failed = hostsQ.isError && hostsQ.data === undefined;
  // With nothing possessed the empty state says it once; a summary line and a
  // row of zeros above it would only say it again.
  const empty = !loading && !failed && summary.hosts === 0;
  const counted = !empty && !failed;

  return (
    // The shell's <main> is `overflow-hidden` on desktop, so a page taller than
    // the viewport carries its own scroller — otherwise it is clipped, and the
    // sidebar rides up with the document instead of staying put.
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Hosts</h1>
            {counted && (
              <p className="mt-0.5 text-sm text-muted-foreground">
                {loading ? "Counting your hosts…" : summaryLine(summary)}
              </p>
            )}
          </div>
          <Button type="button" size="sm" onClick={() => setPossessOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Possess a host
          </Button>
        </header>

        {counted && (
          <section
            aria-label="Totals across your hosts"
            className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-3 lg:grid-cols-5"
          >
            <Stat value={`${summary.hostsOnline}/${summary.hosts}`} label="hosts online" />
            {summary.cores > 0 && <Stat value={summary.cores} label="cores" />}
            {memory && <Stat value={memory} label="memory" />}
            <Stat value={summary.sessions} label="live sessions" />
            <Stat value={summary.attention} label="need you" accent={summary.attention > 0} />
          </section>
        )}

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : failed ? (
          <EmptyState
            className="rounded-xl border border-dashed border-border"
            icon={<AlertCircle />}
            title="Hosts unavailable"
            body={`Failed to load hosts: ${
              hostsQ.error instanceof Error ? hostsQ.error.message : "Something went wrong."
            }`}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={hostsQ.isFetching}
                onClick={() => void hostsQ.refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : empty ? (
          <EmptyState
            className="rounded-xl border border-dashed border-border"
            icon={<Server />}
            title="No hosts yet."
            body={
              <>
                A host is a computer your agents run on. Install SPAWN D on it, then run{" "}
                <code className="font-mono text-xs">spawnd possess</code> there.
              </>
            }
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPossessOpen(true)}
              >
                <Plus className="size-4" aria-hidden />
                Possess a host
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {summary.rows.map((row) => (
              <HostCard key={row.host.id} row={row} />
            ))}
            {/* The empty rack slot, at page scale. Same argument as the strip's:
             * host count is the number that makes every other figure here worth
             * looking at, so the surface that shows it should ask for one more. */}
            <button
              type="button"
              onClick={() => setPossessOpen(true)}
              className="group/slot flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <Plus
                className="size-5 transition-transform duration-150 group-hover/slot:rotate-90"
                aria-hidden
              />
              <span className="text-sm">Possess a host</span>
            </button>
          </div>
        )}

        {summary.rows.length > 0 && (
          // Said once, quietly, because it is the actual differentiator and
          // not decoration: the numbers on these cards never reach the control
          // plane at all.
          <p className="text-xs leading-5 text-muted-foreground">
            Exact figures travel straight from each host to this device. The spawnd server only ever
            sees a five-level reading every thirty seconds.
          </p>
        )}

        <Dialog open={possessOpen} onOpenChange={setPossessOpen}>
          <DialogContent size="lg">
            <DialogHeader>
              <DialogTitle>Possess a host</DialogTitle>
              <DialogDescription>
                Install SPAWN D on the computer, run{" "}
                <code className="font-mono text-xs">spawnd possess</code> there, and keep this
                window open until it comes online.
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-y-auto px-4 pb-4">
              <ConnectHostSection frameless />
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
