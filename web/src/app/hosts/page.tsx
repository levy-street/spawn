"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Download, FolderOpen, KeySquare, Server } from "lucide-react";
import Link from "next/link";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { relativeTime } from "@/lib/agents";
import { type Host, hosts } from "@/lib/api";

export default function HostsPage() {
  return (
    <AuthGate>
      <AppShell>
        <HostsList />
      </AppShell>
    </AuthGate>
  );
}

function HostsList() {
  const q = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, refetchInterval: 30_000 });
  const sorted = [...(q.data ?? [])].sort((a, b) => {
    if (a.status !== b.status) return a.status === "online" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="mx-auto w-full max-w-3xl p-4 @md/shell:p-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Hosts</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Machines running the spawn daemon.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/device">
              <KeySquare className="size-4" />
              Enter code
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/download">
              <Download className="size-4" />
              Connect a host
            </Link>
          </Button>
        </div>
      </header>

      {q.error && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load hosts: {String(q.error)}
        </p>
      )}

      {q.isLoading && (
        <div className="overflow-hidden rounded-xl border border-border">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-4">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!q.isLoading && !q.error && sorted.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No hosts yet</CardTitle>
            <CardDescription>
              Install <code>spawnd</code> on a machine from the{" "}
              <Link href="/download" className="underline underline-offset-2">
                download page
              </Link>
              , run <code>spawnd login</code>, and approve the device code at{" "}
              <Link href="/device" className="underline underline-offset-2">
                /device
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {sorted.length > 0 && (
        <ul className="overflow-hidden rounded-xl border border-border">
          {sorted.map((host) => (
            <HostRow key={host.id} host={host} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HostRow({ host }: { host: Host }) {
  const lastSeen = relativeTime(host.last_seen_at);
  return (
    <li className="group/hostrow relative border-b border-border last:border-b-0">
      <Link
        href={`/hosts/${host.id}`}
        className="group flex items-center gap-3 px-4 py-3.5 pr-12 transition-colors hover:bg-accent/40"
      >
        <span className="relative grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
          <Server className="size-4" aria-hidden />
          <StatusDot
            tone={hostStatusTone(host.status)}
            label={host.status}
            pulse={host.status === "online"}
            className="absolute -bottom-0.5 -right-0.5 border border-card"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{host.name}</span>
            {host.status === "online" ? (
              <Badge variant="success">online</Badge>
            ) : (
              <Badge variant="outline">offline</Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {host.os ?? "unknown"}/{host.arch ?? "unknown"} · spawnd {host.version ?? "?"}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-xs text-foreground">
            {host.agent_count} agent{host.agent_count === 1 ? "" : "s"}
          </span>
          {lastSeen && (
            <span className="mt-0.5 block text-[11px] text-muted-foreground">seen {lastSeen}</span>
          )}
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
          aria-hidden
        />
      </Link>
      <Link
        href={`/hosts/${host.id}/files`}
        aria-label={`${host.name} files`}
        title="Browse files"
        className="absolute right-9 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/hostrow:opacity-100 [@media(pointer:coarse)]:opacity-100"
      >
        <FolderOpen className="size-4" aria-hidden />
      </Link>
    </li>
  );
}
