"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpCircle,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { useDaemonConnection } from "@/components/hosts/DaemonConnectionsProvider";
import { HostDot } from "@/components/hosts/fleet-parts";
import { HostUpdateBadge, hostNeedsUpdatePrompt } from "@/components/release/HostUpdateDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { type Host, hosts } from "@/lib/api";
import { hostStatusLine, hostTabHref } from "@/lib/host-cockpit";
import { HOST_IDENTITY_BLOCKED_REASON } from "@/lib/signed-rtc-trust";
import { cn } from "@/lib/utils";
import { OpenHereMenu } from "./open-here-menu";

const noop = () => () => {};

/**
 * The top of a host's page, on the shell band: back to Hosts, the host's mark
 * and name (click to rename), the other hosts one click away on the same
 * section, the line saying how this device reaches it, and the two things you
 * do to a host — open a window on it, or manage it (⋯).
 */
export function CockpitHeader({
  hostId,
  host,
  segment,
  identityBlocked,
  renaming,
  onRename,
  onUpdate,
  onRemove,
  removeLabel,
}: {
  hostId: string;
  host: Host | undefined;
  /** The section on screen, so switching hosts keeps it. */
  segment: string;
  identityBlocked: boolean;
  renaming: boolean;
  onRename: (name: string) => Promise<void>;
  onUpdate: () => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 15_000 });
  const others = (hostsQ.data ?? []).filter((item) => item.id !== hostId);
  const connection = useDaemonConnection(hostId);
  const snapshot = useSyncExternalStore(
    connection?.subscribe ?? noop,
    () => connection?.getSnapshot() ?? null,
    () => null,
  );
  const status = host ? hostStatusLine(host, snapshot) : null;

  const startRename = () => {
    if (!host) return;
    setDraft(host.name);
    setEditing(true);
  };
  const submitRename = () => {
    const next = draft.trim();
    if (!next || !host || next === host.name) {
      setEditing(false);
      return;
    }
    onRename(next).then(
      () => setEditing(false),
      // The frame reports the failure; the field stays open to try again.
      () => {},
    );
  };

  /**
   * Back means back — the route you came from. A page opened cold in a fresh
   * tab has nothing to pop, so it goes to the Hosts page rather than leaving
   * the arrow dead.
   */
  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/hosts");
  };

  const windowBlocked = identityBlocked
    ? HOST_IDENTITY_BLOCKED_REASON
    : host && host.status !== "online"
      ? `${host.name} is offline.`
      : null;

  return (
    <header className="flex shrink-0 items-center gap-2 bg-shell px-2 pt-2 @md/shell:px-3 @md/shell:pt-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label="Back"
        onClick={goBack}
      >
        <ArrowLeft className="size-4" aria-hidden />
      </Button>
      <span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground">
        <Server className="size-4" aria-hidden />
        {status && (
          <HostDot
            tone={status.tone}
            label={status.text}
            pulse={status.tone === "warning"}
            className="absolute -right-0.5 -bottom-0.5 ring-2 ring-shell"
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          {editing ? (
            <Input
              aria-label="Host name"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={submitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitRename();
                if (event.key === "Escape") setEditing(false);
              }}
              className="h-7 max-w-56"
              disabled={renaming}
            />
          ) : (
            <h1 className="min-w-0">
              <button
                type="button"
                className="block max-w-full truncate rounded-md px-1 text-base font-semibold tracking-tight hover:bg-accent/50"
                title="Rename host"
                onClick={startRename}
              >
                {host?.name ?? "…"}
              </button>
            </h1>
          )}
          {others.length > 0 && (
            <DropdownMenu
              align="start"
              renderTrigger={(props) => (
                <Button
                  {...props}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 text-muted-foreground"
                  aria-label="Switch host"
                >
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              )}
            >
              <DropdownMenuLabel>Switch host</DropdownMenuLabel>
              {others.map((other) => (
                // The same section on the other host. A folder belongs to the
                // host it was on, so where Files was browsing is left behind.
                <DropdownMenuItem key={other.id} href={hostTabHref(other.id, segment)}>
                  <span aria-hidden className="contents">
                    <StatusDot tone={hostStatusTone(other.status)} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{other.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {other.status === "online" ? "Online" : "Offline"}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenu>
          )}
          {host && (host.update.state === "available" || host.update.state === "updating") && (
            <button type="button" className="shrink-0" onClick={onUpdate}>
              <HostUpdateBadge host={host} />
            </button>
          )}
        </div>
        {status && (
          <div className="flex min-w-0 items-center gap-2 px-1">
            <span
              className={cn(
                "truncate font-mono text-[11px]",
                status.retry && "shrink-0",
                status.tone === "warning" ? "text-warning" : "text-muted-foreground",
              )}
            >
              {status.text}
            </span>
            {status.retry && status.reason && (
              // Beside the Retry that fixes it; the status keeps to its one
              // fixed word.
              <span
                className="min-w-0 truncate text-[11px] text-muted-foreground"
                title={status.reason}
              >
                {status.reason}
              </span>
            )}
            {status.retry && connection && (
              <button
                type="button"
                className="shrink-0 text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
                onClick={() => connection.retry()}
                aria-label={`Retry connection to ${host?.name ?? "this host"}`}
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
      {host && (
        <OpenHereMenu
          host={host}
          disabledReason={windowBlocked}
          className="shrink-0"
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 bg-background"
              aria-label="New window here…"
            >
              <Plus className="size-4" aria-hidden />
              <span className="hidden @md/shell:inline">New window here…</span>
            </Button>
          }
        />
      )}
      <DropdownMenu
        renderTrigger={(props) => (
          <Button
            {...props}
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="Host actions"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        )}
      >
        <DropdownMenuItem onSelect={startRename}>
          <Pencil className="size-4" aria-hidden />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onUpdate}
          // Always listed, so the menu keeps one shape; it does something only
          // when there is an update to install, under way, failed, or a host
          // too old to update itself.
          disabled={!host || !hostNeedsUpdatePrompt(host)}
        >
          <ArrowUpCircle className="size-4" aria-hidden />
          Update SPAWN D…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={onRemove}>
          <Trash2 className="size-4" aria-hidden />
          {removeLabel}
        </DropdownMenuItem>
      </DropdownMenu>
    </header>
  );
}
