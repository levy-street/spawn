"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MoreHorizontal, Pencil, Server, Trash2 } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { leaveSettingsFor } from "@/components/settings/settings-dialog-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { type Host, hosts } from "@/lib/api";

export function HostsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    refetchInterval: 10_000,
  });
  const orderedHosts = [...(hostsQ.data ?? [])].sort((a, b) => {
    if (a.status !== b.status) return a.status === "online" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => hosts.rename(id, name),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  });
  const removeM = useMutation({
    mutationFn: (id: string) => hosts.remove(id),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  });

  const requestRemove = async (host: Host) => {
    const accepted = await confirm({
      title: `Remove ${host.name}?`,
      body: "Its daemon token will be revoked and it will no longer be able to connect.",
      confirmLabel: "Remove host",
      destructive: true,
    });
    if (accepted) removeM.mutate(host.id);
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3" aria-labelledby="settings-hosts-title">
        <div>
          <h2 id="settings-hosts-title" className="text-base font-semibold">
            Hosts
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Machines running the spawnd daemon and the sessions attached to them.
          </p>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {hostsQ.error && (
          <p className="text-sm text-destructive" role="alert">
            Failed to load hosts: {String(hostsQ.error)}
          </p>
        )}
        {hostsQ.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {!hostsQ.isLoading && !hostsQ.error && orderedHosts.length === 0 && (
          <p className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
            No hosts are connected yet.
          </p>
        )}
        <div className="space-y-2">
          {orderedHosts.map((host) => (
            <HostCard
              key={host.id}
              host={host}
              busy={renameM.isPending || removeM.isPending}
              onRename={(name) => renameM.mutate({ id: host.id, name })}
              onRemove={() => void requestRemove(host)}
            />
          ))}
        </div>
      </section>

      <ConnectHostSection
        onHostOnline={() => queryClient.invalidateQueries({ queryKey: ["hosts"] })}
      />
    </div>
  );
}

function HostCard({
  host,
  busy,
  onRename,
  onRemove,
}: {
  host: Host;
  busy: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(host.name);

  useEffect(() => {
    if (!editing) setDraft(host.name);
  }, [editing, host.name]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next && next !== host.name) onRename(next);
    setEditing(false);
  };

  return (
    <Card className="shadow-none">
      <CardContent className="flex items-start gap-3 p-3">
        <span className="relative grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted text-muted-foreground">
          <Server className="size-4.5" aria-hidden />
          <StatusDot
            tone={hostStatusTone(host.status)}
            label={host.status}
            pulse={host.status === "online"}
            className="absolute -bottom-0.5 -right-0.5 border border-card"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {editing ? (
              <form onSubmit={submit} className="min-w-36 flex-1">
                <Input
                  autoFocus
                  aria-label={`Rename ${host.name}`}
                  className="h-8"
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onBlur={() => submit()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(false);
                    }
                  }}
                />
              </form>
            ) : (
              <span className="truncate text-sm font-medium">{host.name}</span>
            )}
            <Badge variant={host.status === "online" ? "success" : "outline"}>{host.status}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {host.os ?? "unknown"}/{host.arch ?? "unknown"} · daemon {host.version ?? "unknown"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {host.session_count} {host.session_count === 1 ? "session" : "sessions"}
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link href={`/hosts/${host.id}`} onClick={() => leaveSettingsFor("hosts")}>
            <ExternalLink className="size-3.5" aria-hidden />
            <span className="hidden @sm/settings:inline">Details</span>
          </Link>
        </Button>
        <DropdownMenu
          renderTrigger={(props) => (
            <Button
              {...props}
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={`${host.name} actions`}
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          )}
        >
          <DropdownMenuItem disabled={busy} onSelect={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={busy} onSelect={onRemove}>
            <Trash2 className="size-4" aria-hidden />
            Remove
          </DropdownMenuItem>
        </DropdownMenu>
      </CardContent>
    </Card>
  );
}
