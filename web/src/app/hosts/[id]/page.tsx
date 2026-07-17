"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Server,
  SquarePen,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AuthGate } from "@/components/auth/AuthGate";
import { HostToolsPanel } from "@/components/hosts/HostToolsPanel";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentStatusDot } from "@/components/ui/status";
import { agentActivityDetail, agentCommand, agentTitle, relativeTime } from "@/lib/agents";
import { ApiError, agents, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  BrowserHostPinError,
  browserHostPinServerOrigin,
  loadBrowserHostPin,
  resolveActiveBrowserHostPin,
  revokeBrowserHostPin,
} from "@/lib/browser-host-pins";

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
  const qc = useQueryClient();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [localDeletionPending, setLocalDeletionPending] = useState(false);

  const q = useQuery({
    queryKey: ["host", id],
    queryFn: () => hosts.get(id as string),
    enabled: !!id,
    refetchInterval: 30_000,
  });
  const agentsQ = useQuery({
    queryKey: ["agents", { host_id: id }],
    queryFn: () => agents.list({ host_id: id as string }),
    enabled: !!id,
    refetchInterval: 10_000,
  });

  const renameM = useMutation({
    mutationFn: (name: string) => hosts.rename(id as string, name),
    onSuccess: () => {
      setEditingName(false);
      setError(null);
      qc.invalidateQueries({ queryKey: ["host", id] });
      qc.invalidateQueries({ queryKey: ["hosts"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
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
        await revokeBrowserHostPin({
          accountId: user.id,
          origin: browserHostPinServerOrigin(),
          targetHostId,
          claimedHostId: host.id,
          claimedHostPublicKey: host.host_public_key ?? null,
          claimedHostFingerprint: host.host_key_fingerprint ?? null,
        });
        localTombstoneWritten = true;
        setLocalDeletionPending(true);
        await hosts.remove(targetHostId);
      } catch (err) {
        const message = err instanceof ApiError || err instanceof Error ? err.message : String(err);
        throw new HostDeletionFlowError(message, localTombstoneWritten);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hosts"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      router.push("/hosts");
    },
    onError: (err) => {
      if (err instanceof HostDeletionFlowError && err.localTombstoneWritten) {
        setLocalDeletionPending(true);
        setError(
          `Local host trust is revoked, but server deletion did not complete: ${err.message}. Retry server deletion; the local tombstone will remain.`,
        );
        return;
      }
      setError(
        `Host deletion was blocked before any server DELETE: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  const host = q.data;

  useEffect(() => {
    const hostPublicKey = host?.host_public_key;
    const hostFingerprint = host?.host_key_fingerprint;
    if (!host || !user || !hostPublicKey || !hostFingerprint) return;
    let cancelled = false;
    void (async () => {
      try {
        if (host.id !== id) {
          throw new Error("Host API response ID does not exactly match this route");
        }
        try {
          await resolveActiveBrowserHostPin({
            accountId: user.id,
            origin: browserHostPinServerOrigin(),
            hostId: id,
            claimedHostPublicKey: hostPublicKey,
            claimedHostFingerprint: hostFingerprint,
          });
        } catch (err) {
          // An already-bound tombstone is expected after a failed server
          // DELETE. Confirm its exact binding below without reactivating it.
          if (!(err instanceof BrowserHostPinError) || err.code !== "revoked_pin") throw err;
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
      } catch (err) {
        if (!cancelled) {
          setLocalDeletionPending(false);
          setError(
            `Local host trust status is unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, user, id]);

  const submitRename = () => {
    const next = draftName.trim();
    if (!next || !host || next === host.name) {
      setEditingName(false);
      return;
    }
    renameM.mutate(next);
  };

  if (!id) return null;

  return (
    <div className="mx-auto w-full max-w-3xl p-4 @md/shell:p-6">
      {/* Toolbar */}
      <header className="mb-5 flex items-center gap-2">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="All hosts"
        >
          <Link href="/hosts">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
          <Server className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {editingName ? (
            <Input
              aria-label="Host name"
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") setEditingName(false);
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
          {host &&
            (host.status === "online" ? (
              <Badge variant="success">online</Badge>
            ) : (
              <Badge variant="outline">offline</Badge>
            ))}
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link href={`/hosts/${id}/files`}>
            <FolderOpen className="size-4" />
            <span className="hidden sm:inline">Files</span>
          </Link>
        </Button>
        <Button asChild size="sm" className="shrink-0">
          <Link href={`/agents/new?host=${id}`}>
            <SquarePen className="size-4" />
            <span className="hidden sm:inline">New agent</span>
          </Link>
        </Button>
        <DropdownMenu
          renderTrigger={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Host actions"
            >
              <MoreHorizontal className="size-4" />
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
          <DropdownMenuItem
            destructive
            onSelect={() => {
              if (host && confirm(`Remove host ${host.name}? Its daemon token is revoked.`)) {
                removeM.mutate();
              }
            }}
          >
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
      {localDeletionPending && (
        <p className="mb-3 text-sm text-foreground" role="status">
          This browser retains a revoked host/key tombstone. Server deletion is retryable and server
          disappearance will not clear local trust state.
        </p>
      )}
      {q.error && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load host: {String(q.error)}
        </p>
      )}

      {q.isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      )}

      {host && (
        <div className="space-y-4">
          {/* Facts */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-border p-4 text-sm @md/shell:grid-cols-3 @xl/shell:grid-cols-6">
            <Fact label="System" value={`${host.os ?? "?"}/${host.arch ?? "?"}`} />
            <Fact label="Daemon" value={`spawnd ${host.version ?? "?"}`} />
            <Fact label="Files" value="end-to-end encrypted" />
            <Fact label="Host identity" value={host.host_key_algorithm ?? "legacy unpaired"} />
            <Fact label="Fingerprint" value={host.host_key_fingerprint ?? "not pinned"} mono />
            <Fact
              label="Connection"
              value={
                host.status === "online"
                  ? `wss control link · heartbeat ${relativeTime(host.last_seen_at) ?? "now"}`
                  : `offline · last seen ${relativeTime(host.last_seen_at) ?? "never"}`
              }
            />
          </dl>

          <HostToolsPanel host={host} />

          {/* Agents on this host */}
          <section className="overflow-hidden rounded-xl border border-border">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-medium">
                Agents
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {agentsQ.data?.length ?? 0}
                </span>
              </h2>
            </div>
            {(agentsQ.data?.length ?? 0) === 0 && (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                No agents on this host.{" "}
                <Link href={`/agents/new?host=${id}`} className="underline underline-offset-2">
                  Spawn one
                </Link>
                .
              </div>
            )}
            <ul>
              {(agentsQ.data ?? []).map((agent) => (
                <li key={agent.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={`/agents/${agent.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
                  >
                    <span className="relative shrink-0">
                      <AgentKindIcon agent={agent} />
                      <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {agentTitle(agent)}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {agentCommand(agent)} · {agent.cwd}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {agentActivityDetail(agent)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
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
