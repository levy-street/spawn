"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Download, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  type Host,
  type HostToolInstallResult,
  type HostToolStatus,
  hosts,
} from "@/lib/api";

export function HostToolsPanel({ host }: { host: Host }) {
  const qc = useQueryClient();
  const [lastResult, setLastResult] = useState<HostToolInstallResult | null>(null);
  const toolsQ = useQuery({
    queryKey: ["host-tools", host.id],
    queryFn: () => hosts.tools(host.id),
    enabled: host.status === "online",
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const installM = useMutation({
    mutationFn: (tool: HostToolStatus) => hosts.installTool(host.id, tool.preset_id),
    onSuccess: (result) => {
      setLastResult(result);
      qc.invalidateQueries({ queryKey: ["host-tools", host.id] });
    },
    onError: (err) => {
      setLastResult({
        preset_id: "",
        preset_name: "Install",
        agent_kind: "",
        command: "",
        success: false,
        output: "",
        error: err instanceof ApiError ? err.message : String(err),
      });
    },
  });
  const policyM = useMutation({
    mutationFn: ({ tool, autoUpdate }: { tool: HostToolStatus; autoUpdate: boolean }) =>
      hosts.updateToolPolicy(host.id, tool.preset_id, { auto_update: autoUpdate }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["host-tools", host.id] });
    },
    onError: (err) => {
      setLastResult({
        preset_id: "",
        preset_name: "Policy",
        agent_kind: "",
        command: "",
        success: false,
        output: "",
        error: err instanceof ApiError ? err.message : String(err),
      });
    },
  });

  if (host.status !== "online") {
    return (
      <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
        Tool status is unavailable while the daemon is offline.
      </div>
    );
  }

  const installingId = installM.variables?.preset_id;
  const tools = toolsQ.data?.tools ?? [];

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-medium">Tools</h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Refresh tools for ${host.name}`}
          title="Refresh"
          onClick={() => toolsQ.refetch()}
          disabled={toolsQ.isFetching}
        >
          <RefreshCw className={`size-3.5 ${toolsQ.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {toolsQ.isLoading && (
        <div className="space-y-3 p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      )}
      {toolsQ.error && (
        <div className="px-4 py-3 text-sm text-destructive">
          {toolsQ.error instanceof ApiError ? toolsQ.error.message : String(toolsQ.error)}
        </div>
      )}
      {!toolsQ.isLoading && !toolsQ.error && tools.length === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">No preset targets.</div>
      )}

      {tools.length > 0 && (
        <ul className="divide-y divide-border">
          {tools.map((tool) => (
            <li key={tool.preset_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <ToolStatusIcon tool={tool} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{tool.preset_name}</span>
                  {tool.installed && tool.version && (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {tool.version}
                    </span>
                  )}
                  {tool.update_available && (
                    <Badge variant="warning">
                      update{tool.latest_version ? ` ${tool.latest_version}` : ""}
                    </Badge>
                  )}
                  {!tool.installed && <Badge variant="outline">not installed</Badge>}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {tool.error ? (
                    <span className="text-destructive">{tool.error}</span>
                  ) : tool.last_auto_update_error ? (
                    <span className="text-destructive">
                      auto update failed: {tool.last_auto_update_error}
                    </span>
                  ) : (
                    (tool.path ?? tool.install ?? tool.command)
                  )}
                </div>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={tool.auto_update}
                  disabled={!tool.install || policyM.isPending}
                  onChange={(event) =>
                    policyM.mutate({ tool, autoUpdate: event.currentTarget.checked })
                  }
                />
                Auto update
              </label>
              <Button
                variant={tool.installed && !tool.update_available ? "outline" : "secondary"}
                size="sm"
                className="shrink-0"
                disabled={!tool.install || installM.isPending}
                onClick={() => {
                  if (confirm(`Run install/update for ${tool.preset_name} on ${host.name}?`)) {
                    setLastResult(null);
                    installM.mutate(tool);
                  }
                }}
              >
                <Download className="size-3.5" />
                {installingId === tool.preset_id
                  ? "Running..."
                  : tool.installed
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
            className={`mb-2 text-sm ${lastResult.success ? "text-emerald-400" : "text-destructive"}`}
          >
            {lastResult.preset_name}: {lastResult.success ? "completed" : "failed"}
            {lastResult.error ? ` · ${lastResult.error}` : ""}
          </div>
          {lastResult.output && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 text-xs">
              {lastResult.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStatusIcon({ tool }: { tool: HostToolStatus }) {
  if (tool.error) {
    return <AlertCircle className="size-4 shrink-0 text-amber-400" aria-label="Target warning" />;
  }
  if (tool.installed) {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-400" aria-label="Installed" />;
  }
  return <X className="size-4 shrink-0 text-muted-foreground" aria-label="Missing" />;
}
