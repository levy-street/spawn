"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FolderOpen, MoreHorizontal, Pencil, Server, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { HostAgentsPanel } from "@/components/hosts/HostAgentsPanel";
import { AgentIcon, agentDisplayName } from "@/components/icons/AgentIcon";
import { AppShell } from "@/components/nav/AppShell";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SessionStatusDot } from "@/components/ui/status";
import { ApiError, hosts, sessions } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  BrowserHostPinError,
  browserHostPinServerOrigin,
  loadBrowserHostPin,
  resolveActiveBrowserHostPin,
  revokeBrowserHostPin,
} from "@/lib/browser-host-pins";
import { relativeTime, sessionActivityDetail, sessionTitle } from "@/lib/sessions";

class HostDeletionFlowError extends Error {
  constructor(
    message: string,
    readonly localTombstoneWritten: boolean,
  ) {
    super(message);
    this.name = "HostDeletionFlowError";
  }
}

export default function HostDetailPage() {
  return (
    <AuthGate>
      <AppShell>
        <HostDetail />
      </AppShell>
    </AuthGate>
  );
}

function HostDetail() {
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [localDeletionPending, setLocalDeletionPending] = useState(false);

  const hostQ = useQuery({
    queryKey: ["host", id],
    queryFn: () => hosts.get(id as string),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
  const sessionsQ = useQuery({
    queryKey: ["sessions", { host_id: id }],
    queryFn: () => sessions.list({ host_id: id as string }),
    enabled: Boolean(id),
    refetchInterval: 5_000,
  });
  const host = hostQ.data;

  const renameM = useMutation({
    mutationFn: (name: string) => hosts.rename(id as string, name),
    onSuccess: () => {
      setEditingName(false);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["host", id] });
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : String(caught)),
  });
  const removeM = useMutation({
    mutationFn: async () => {
      if (!host || !user) {
        throw new HostDeletionFlowError(
          "Authenticated host identity is unavailable; deletion was blocked",
          false,
        );
      }
      const targetHostId = id as string;
      if (host.id !== targetHostId) {
        throw new HostDeletionFlowError(
          "Host API response ID does not exactly match the route and DELETE target",
          false,
        );
      }
      let localTombstoneWritten = false;
      try {
        if (host.host_public_key && host.host_key_fingerprint) {
          try {
            await revokeBrowserHostPin({
              accountId: user.id,
              origin: browserHostPinServerOrigin(),
              targetHostId,
              claimedHostId: host.id,
              claimedHostPublicKey: host.host_public_key,
              claimedHostFingerprint: host.host_key_fingerprint,
            });
            localTombstoneWritten = true;
          } catch (caught) {
            const nothingToRevoke =
              caught instanceof BrowserHostPinError &&
              ["revoked_pin", "missing_pin", "null_key", "null_fingerprint"].includes(caught.code);
            if (!nothingToRevoke) throw caught;
          }
        }
        setLocalDeletionPending(true);
        await hosts.remove(targetHostId);
      } catch (caught) {
        throw new HostDeletionFlowError(
          caught instanceof Error ? caught.message : String(caught),
          localTombstoneWritten,
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      openSettings("hosts");
      router.push("/");
    },
    onError: (caught) => {
      if (caught instanceof HostDeletionFlowError && caught.localTombstoneWritten) {
        setLocalDeletionPending(true);
        setError(
          `Local host trust is revoked, but server deletion did not complete: ${caught.message}. Retry server deletion; the local tombstone will remain.`,
        );
        return;
      }
      setError(
        `Host deletion was blocked before any server delete: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    },
  });

  useEffect(() => {
    const hostPublicKey = host?.host_public_key;
    const hostFingerprint = host?.host_key_fingerprint;
    if (!host || !user || !id || !hostPublicKey || !hostFingerprint) return;
    let cancelled = false;
    void (async () => {
      try {
        if (host.id !== id) throw new Error("Host API response ID does not match this route");
        try {
          await resolveActiveBrowserHostPin({
            accountId: user.id,
            origin: browserHostPinServerOrigin(),
            hostId: id,
            claimedHostPublicKey: hostPublicKey,
            claimedHostFingerprint: hostFingerprint,
          });
        } catch (caught) {
          if (!(caught instanceof BrowserHostPinError) || caught.code !== "revoked_pin") {
            throw caught;
          }
        }
        const pin = await loadBrowserHostPin({
          accountId: user.id,
          origin: browserHostPinServerOrigin(),
          hostPublicKey,
          hostFingerprint,
        });
        if (pin === null || !pin.hostIds.includes(id)) {
          throw new Error("No exact local Host-ID-to-key binding exists for this route");
        }
        if (!cancelled) setLocalDeletionPending(pin.state === "revoked");
      } catch (caught) {
        if (!cancelled) {
          setLocalDeletionPending(false);
          setError(
            `Local host trust status is unavailable: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, id, user]);

  const submitRename = () => {
    const next = draftName.trim();
    if (!next || !host || next === host.name) {
      setEditingName(false);
      return;
    }
    renameM.mutate(next);
  };

  const requestRemove = async () => {
    if (!host) return;
    const accepted = await confirm({
      title: `Remove ${host.name}?`,
      body: "Its daemon token will be revoked. Existing session processes on that machine may continue locally, but spawn will no longer connect to them.",
      confirmLabel: localDeletionPending ? "Retry deletion" : "Remove host",
      destructive: true,
    });
    if (accepted) removeM.mutate();
  };

  if (!id) return null;

  return (
    <main className="mx-auto w-full max-w-4xl p-4 @md/shell:p-6">
      <header className="mb-6 flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Back to hosts settings"
          onClick={() => openSettings("hosts")}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted text-muted-foreground">
          <Server className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {editingName ? (
            <Input
              aria-label="Host name"
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.currentTarget.value)}
              onBlur={submitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitRename();
                if (event.key === "Escape") setEditingName(false);
              }}
              className="h-8 max-w-56"
              disabled={renameM.isPending}
            />
          ) : (
            <button
              type="button"
              className="truncate rounded-md px-1 text-base font-semibold tracking-tight hover:bg-accent/50"
              title="Rename host"
              onClick={() => {
                if (!host) return;
                setDraftName(host.name);
                setEditingName(true);
              }}
            >
              {host?.name ?? "…"}
            </button>
          )}
          {host && (
            <Badge variant={host.status === "online" ? "success" : "outline"}>{host.status}</Badge>
          )}
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link href={`/hosts/${id}/files`}>
            <FolderOpen className="size-4" aria-hidden />
            <span className="hidden sm:inline">Files</span>
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
              aria-label="Host actions"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          )}
        >
          <DropdownMenuItem
            onSelect={() => {
              if (!host) return;
              setDraftName(host.name);
              setEditingName(true);
            }}
          >
            <Pencil className="size-4" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => void requestRemove()}>
            <Trash2 className="size-4" aria-hidden />
            {localDeletionPending ? "Retry server deletion" : "Remove host"}
          </DropdownMenuItem>
        </DropdownMenu>
      </header>

      {error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {hostQ.error && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load host: {String(hostQ.error)}
        </p>
      )}
      {hostQ.isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      )}

      {host && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-border p-4 text-sm @lg/shell:grid-cols-4">
            <Fact label="System" value={`${host.os ?? "?"}/${host.arch ?? "?"}`} />
            <Fact label="Daemon" value={host.version ?? "unknown"} />
            <Fact label="Sessions" value={String(host.session_count)} />
            <Fact
              label="Connection"
              value={
                host.status === "online"
                  ? `online · heartbeat ${relativeTime(host.last_seen_at) ?? "now"}`
                  : `offline · last seen ${relativeTime(host.last_seen_at) ?? "never"}`
              }
            />
            <Fact label="Host identity" value={host.host_key_algorithm ?? "legacy unpaired"} />
            <Fact label="Fingerprint" value={host.host_key_fingerprint ?? "not pinned"} mono />
          </dl>

          <HostAgentsPanel host={host} />

          <section
            className="overflow-hidden rounded-xl border border-border"
            aria-labelledby="host-sessions-title"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <h2 id="host-sessions-title" className="text-sm font-medium">
                Sessions
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {sessionsQ.data?.length ?? 0}
                </span>
              </h2>
            </div>
            {sessionsQ.isLoading && <Skeleton className="m-4 h-12 w-[calc(100%-2rem)]" />}
            {sessionsQ.error && (
              <p className="px-4 py-3 text-sm text-destructive">{String(sessionsQ.error)}</p>
            )}
            {!sessionsQ.isLoading && !sessionsQ.error && sessionsQ.data?.length === 0 && (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                No sessions are running on this host.
              </p>
            )}
            <ul className="divide-y divide-border">
              {(sessionsQ.data ?? []).map((session) => (
                <li key={session.id}>
                  <Link
                    href={`/sessions/${session.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
                  >
                    <span className="relative shrink-0">
                      <AgentIcon command={session.foreground_command} size={28} />
                      <SessionStatusDot
                        session={session}
                        className="absolute -bottom-0.5 -right-0.5"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {sessionTitle(session)}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {agentDisplayName(session.foreground_command)} · {session.cwd}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
                      {sessionActivityDetail(session)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </main>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={`mt-0.5 truncate ${mono ? "font-mono text-xs leading-5" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
