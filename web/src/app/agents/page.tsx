"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  SquarePen,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentStatusDot } from "@/components/ui/status";
import {
  agentActivityDetail,
  agentActivityLabel,
  agentCommand,
  agentTitle,
  isAgentArchived,
} from "@/lib/agents";
import { type Agent, ApiError, agents } from "@/lib/api";

export default function AgentsPage() {
  return (
    <AuthGate>
      <AppShell>
        <AgentsView />
      </AppShell>
    </AuthGate>
  );
}

function AgentsView() {
  const qc = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["agents", { includeArchived }],
    queryFn: () => agents.list({ include_archived: includeArchived }),
    refetchInterval: 5_000,
  });
  // Terminal previews are no longer fetched through the server. A future
  // endpoint-owned preview can populate this without exposing history.
  const tails: Record<string, string | null> = {};

  const invalidateAgents = () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["hosts"] });
  };
  const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : String(err));

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => agents.rename(id, name),
    onSuccess: () => {
      setError(null);
      invalidateAgents();
    },
    onError,
  });
  const pinM = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      pinned ? agents.pin(id) : agents.unpin(id),
    onSuccess: invalidateAgents,
    onError,
  });
  const archiveM = useMutation({
    mutationFn: (id: string) => agents.archive(id),
    onSuccess: invalidateAgents,
    onError,
  });
  const unarchiveM = useMutation({
    mutationFn: (id: string) => agents.unarchive(id),
    onSuccess: invalidateAgents,
    onError,
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => agents.remove(id),
    onSuccess: invalidateAgents,
    onError,
  });
  const restartM = useMutation({
    mutationFn: (id: string) => agents.restart(id),
    onSuccess: invalidateAgents,
    onError,
  });

  const busy =
    renameM.isPending ||
    pinM.isPending ||
    archiveM.isPending ||
    unarchiveM.isPending ||
    deleteM.isPending ||
    restartM.isPending;

  const sorted = useMemo(() => sortAgents(q.data ?? []), [q.data]);
  const pinned = sorted.filter((a) => a.pinned_at && !isAgentArchived(a));
  const recent = sorted.filter((a) => !a.pinned_at && !isAgentArchived(a));
  const archived = sorted.filter((a) => isAgentArchived(a));

  const promptRename = (agent: Agent) => {
    const next = prompt("Rename agent", agent.name ?? agentTitle(agent));
    if (next === null) return;
    const name = next.trim();
    if (name && name !== agent.name) renameM.mutate({ id: agent.id, name });
  };

  const rowActions = (agent: Agent) => ({
    busy,
    onRename: () => promptRename(agent),
    onPin: () => pinM.mutate({ id: agent.id, pinned: !agent.pinned_at }),
    onRestart: () => {
      if (confirm(`Restart ${agentTitle(agent)}?`)) restartM.mutate(agent.id);
    },
    onArchive: () =>
      isAgentArchived(agent) ? unarchiveM.mutate(agent.id) : archiveM.mutate(agent.id),
    onDelete: () => {
      if (confirm(`Delete ${agentTitle(agent)}?`)) deleteM.mutate(agent.id);
    },
  });

  return (
    <div className="mx-auto w-full max-w-3xl p-4 @md/shell:p-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Every CLI agent across your hosts.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setIncludeArchived((v) => !v)}>
            {includeArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button asChild size="sm">
            <Link href="/agents/new">
              <SquarePen className="size-4" />
              New agent
            </Link>
          </Button>
        </div>
      </header>

      {error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {q.error && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load agents: {String(q.error)}
        </p>
      )}

      {q.isLoading && (
        <div className="overflow-hidden rounded-xl border border-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-4">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!q.isLoading && !q.error && sorted.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No agents</CardTitle>
            <CardDescription>
              Spawn your first agent on any connected host —{" "}
              <Link href="/agents/new" className="underline underline-offset-2">
                new agent
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="space-y-5">
        {pinned.length > 0 && (
          <AgentSection title="Pinned" agentList={pinned} tails={tails} actions={rowActions} />
        )}
        {recent.length > 0 && (
          <AgentSection
            title={pinned.length > 0 ? "Recent" : undefined}
            agentList={recent}
            tails={tails}
            actions={rowActions}
          />
        )}
        {includeArchived && archived.length > 0 && (
          <AgentSection title="Archived" agentList={archived} tails={tails} actions={rowActions} />
        )}
      </div>
    </div>
  );
}

type RowActions = {
  busy: boolean;
  onRename: () => void;
  onPin: () => void;
  onRestart: () => void;
  onArchive: () => void;
  onDelete: () => void;
};

function AgentSection({
  title,
  agentList,
  tails,
  actions,
}: {
  title?: string;
  agentList: Agent[];
  tails: Record<string, string | null>;
  actions: (agent: Agent) => RowActions;
}) {
  return (
    <section>
      {title && (
        <h2 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      )}
      <ul className="overflow-hidden rounded-xl border border-border">
        {agentList.map((agent) => (
          <AgentRow key={agent.id} agent={agent} tail={tails[agent.id]} {...actions(agent)} />
        ))}
      </ul>
    </section>
  );
}

function AgentRow({
  agent,
  tail,
  busy,
  onRename,
  onPin,
  onRestart,
  onArchive,
  onDelete,
}: {
  agent: Agent;
  tail?: string | null;
} & RowActions) {
  const archived = isAgentArchived(agent);
  return (
    <li className="group border-b border-border transition-colors last:border-b-0 hover:bg-accent/40">
      <div className="flex items-center gap-3 px-4 py-3">
        <Link
          href={`/agents/${agent.id}`}
          className="flex min-w-0 flex-1 items-center gap-3"
          aria-label={`Open ${agentTitle(agent)}`}
        >
          <span className="relative shrink-0">
            <AgentKindIcon agent={agent} className="size-9" iconClassName="size-4.5" />
            <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{agentTitle(agent)}</span>
              {agent.pinned_at && (
                <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
              )}
              {archived && <Badge variant="outline">archived</Badge>}
              {agent.status === "exited" && (
                <Badge variant={agent.exit_code === 0 ? "outline" : "destructive"}>
                  exit {agent.exit_code ?? "?"}
                </Badge>
              )}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
              {agentCommand(agent)} · {agent.cwd}
            </span>
            {tail != null && tail !== "" && (
              <span className="mt-1 block truncate font-mono text-[11px] leading-4 text-muted-foreground/70">
                {lastNonEmptyLine(tail)}
              </span>
            )}
          </span>
          <span className="hidden shrink-0 text-right sm:block">
            <span className="block text-xs">{agent.host_name ?? "—"}</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              {agentActivityDetail(agent)}
            </span>
          </span>
          <span className="sr-only">{agentActivityLabel(agent)}</span>
        </Link>
        <DropdownMenu
          renderTrigger={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
              aria-label={`${agentTitle(agent)} actions`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        >
          <DropdownMenuItem disabled={busy} onSelect={onRename}>
            <Pencil className="size-4" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onPin}>
            {agent.pinned_at ? (
              <PinOff className="size-4" aria-hidden />
            ) : (
              <Pin className="size-4" aria-hidden />
            )}
            {agent.pinned_at ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onRestart}>
            <RotateCcw className="size-4" aria-hidden />
            Restart
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={onArchive}>
            {archived ? (
              <ArchiveRestore className="size-4" aria-hidden />
            ) : (
              <Archive className="size-4" aria-hidden />
            )}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={busy} onSelect={onDelete}>
            <Trash2 className="size-4" aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenu>
      </div>
    </li>
  );
}

function lastNonEmptyLine(tail: string): string {
  const lines = tail.split("\n").filter((line) => line.trim() !== "");
  return lines.at(-1) ?? "";
}

function sortAgents(agentList: Agent[]): Agent[] {
  return [...agentList].sort((a, b) => {
    const byActivity = lastActivityTime(b) - lastActivityTime(a);
    if (byActivity !== 0) return byActivity;
    return agentTitle(a).localeCompare(agentTitle(b));
  });
}

function lastActivityTime(agent: Agent): number {
  const value = agent.last_activity_at ?? agent.last_input_at ?? agent.started_at;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}
