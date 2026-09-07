"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type Host, type HostAgentStatus, hosts } from "@/lib/api";

export function HostAgentsPanel({ host }: { host: Host }) {
  const agentsQ = useQuery({
    queryKey: ["host-agents", host.id],
    queryFn: () => hosts.agents(host.id),
    enabled: host.status === "online",
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  if (host.status !== "online") {
    return (
      <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
        <p>Agent availability is unavailable while the daemon is offline.</p>
        <p className="mt-2">
          Agent installation and auto update are unavailable here. Install or update agents in a
          trusted terminal on this host.
        </p>
      </div>
    );
  }

  const definitions = agentsQ.data?.agents ?? [];

  return (
    <section
      className="overflow-hidden rounded-xl border border-border"
      aria-labelledby="host-agents-title"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 id="host-agents-title" className="text-sm font-medium">
          Agent availability
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Refresh agents for ${host.name}`}
          title="Refresh"
          onClick={() => agentsQ.refetch()}
          disabled={agentsQ.isFetching}
        >
          <RefreshCw className={`size-3.5 ${agentsQ.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
        Agent installation and auto update are unavailable here. Install or update agents in a
        trusted terminal on this host.
      </p>

      {agentsQ.isLoading && (
        <div className="space-y-3 p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      )}
      {agentsQ.error && (
        <div className="px-4 py-3 text-sm text-destructive">
          {agentsQ.error instanceof ApiError ? agentsQ.error.message : String(agentsQ.error)}
        </div>
      )}
      {!agentsQ.isLoading && !agentsQ.error && definitions.length === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">No agents defined.</div>
      )}

      {definitions.length > 0 && (
        <ul className="divide-y divide-border">
          {definitions.map((agent) => (
            <li key={agent.agent_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <AgentStatusIcon agent={agent} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{agent.agent_name}</span>
                  {agent.installed && agent.version && (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {agent.version}
                    </span>
                  )}
                  {agent.update_available && (
                    <Badge variant="warning">
                      update{agent.latest_version ? ` ${agent.latest_version}` : ""}
                    </Badge>
                  )}
                  {!agent.installed && <Badge variant="outline">not installed</Badge>}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {agent.error ? (
                    <span className="text-destructive">{agent.error}</span>
                  ) : agent.last_auto_update_error ? (
                    <span className="text-destructive">
                      auto update failed: {agent.last_auto_update_error}
                    </span>
                  ) : (
                    (agent.path ?? agent.install ?? agent.command)
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentStatusIcon({ agent }: { agent: HostAgentStatus }) {
  if (agent.error) {
    return <AlertCircle className="size-4 shrink-0 text-warning" aria-label="Agent warning" />;
  }
  if (agent.installed) {
    return <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Installed" />;
  }
  return <X className="size-4 shrink-0 text-muted-foreground" aria-label="Missing" />;
}
