"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Download, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  type Host,
  type HostAgentInstallResult,
  type HostAgentStatus,
  hosts,
} from "@/lib/api";

export function HostAgentsPanel({ host }: { host: Host }) {
  const queryClient = useQueryClient();
  const [lastResult, setLastResult] = useState<HostAgentInstallResult | null>(null);
  const agentsQ = useQuery({
    queryKey: ["host-agents", host.id],
    queryFn: () => hosts.agents(host.id),
    enabled: host.status === "online",
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const failureResult = (name: string, error: unknown): HostAgentInstallResult => ({
    agent_id: "",
    agent_name: name,
    agent_kind: "",
    command: "",
    success: false,
    output: "",
    error: error instanceof ApiError ? error.message : String(error),
  });
  const installM = useMutation({
    mutationFn: (agent: HostAgentStatus) => hosts.installAgent(host.id, agent.agent_id),
    onSuccess: (result) => {
      setLastResult(result);
      queryClient.invalidateQueries({ queryKey: ["host-agents", host.id] });
    },
    onError: (error) => setLastResult(failureResult("Install", error)),
  });
  const policyM = useMutation({
    mutationFn: ({ agent, autoUpdate }: { agent: HostAgentStatus; autoUpdate: boolean }) =>
      hosts.updateAgentPolicy(host.id, agent.agent_id, { auto_update: autoUpdate }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["host-agents", host.id] }),
    onError: (error) => setLastResult(failureResult("Policy", error)),
  });

  if (host.status !== "online") {
    return (
      <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
        Agent availability is unavailable while the daemon is offline.
      </div>
    );
  }

  const installingId = installM.variables?.agent_id;
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
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={agent.auto_update}
                  disabled={!agent.install || policyM.isPending}
                  onChange={(event) =>
                    policyM.mutate({ agent, autoUpdate: event.currentTarget.checked })
                  }
                />
                Auto update
              </label>
              <Button
                variant={agent.installed && !agent.update_available ? "outline" : "secondary"}
                size="sm"
                className="shrink-0"
                disabled={!agent.install || installM.isPending}
                onClick={async () => {
                  const accepted = await confirm({
                    title: `${agent.installed ? "Update" : "Install"} ${agent.agent_name}?`,
                    body: `Runs the install command on ${host.name}.`,
                    confirmLabel: agent.installed ? "Update" : "Install",
                  });
                  if (accepted) {
                    setLastResult(null);
                    installM.mutate(agent);
                  }
                }}
              >
                <Download className="size-3.5" />
                {installingId === agent.agent_id
                  ? "Running…"
                  : agent.installed
                    ? "Update"
                    : "Install"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {lastResult && (
        <div className="border-t border-border px-4 py-3">
          <div
            className={`mb-2 text-sm ${lastResult.success ? "text-success" : "text-destructive"}`}
          >
            {lastResult.agent_name}: {lastResult.success ? "completed" : "failed"}
            {lastResult.error ? ` · ${lastResult.error}` : ""}
          </div>
          {lastResult.output && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 text-xs">
              {lastResult.output}
            </pre>
          )}
        </div>
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
