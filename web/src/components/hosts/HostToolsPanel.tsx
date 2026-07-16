"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Download, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHostControl } from "@/hooks/useHostControl";
import { ApiError, type Host, type HostToolMetadata, hosts } from "@/lib/api";
import {
  HostControlError,
  type HostToolInstallResult,
  type HostToolStatus,
  isInteractiveToolKind,
} from "@/lib/hostControl";

interface ToolRow extends HostToolMetadata {
  status: HostToolStatus | null;
  supported: boolean;
}

interface VisibleResult {
  name: string;
  result?: HostToolInstallResult;
  error?: string;
}

const TOOL_CHECK_BATCH_SIZE = 8;

export function HostToolsPanel({ host }: { host: Host }) {
  const qc = useQueryClient();
  const { client, state } = useHostControl(host.id, host.status === "online");
  const [lastResult, setLastResult] = useState<VisibleResult | null>(null);
  const toolsQ = useQuery({
    queryKey: ["host-tools", host.id],
    queryFn: async (): Promise<{ tools: ToolRow[] }> => {
      if (!client) throw new HostControlError("connection_closed", "Host control is unavailable");
      const metadata = await hosts.toolTargets(host.id);
      const targets = metadata.tools.flatMap((tool) =>
        isInteractiveToolKind(tool.agent_kind)
          ? [{ target_id: tool.preset_id, tool: tool.agent_kind }]
          : [],
      );
      const checked: HostToolStatus[] = [];
      for (let offset = 0; offset < targets.length; offset += TOOL_CHECK_BATCH_SIZE) {
        checked.push(
          ...(await client.checkTools(targets.slice(offset, offset + TOOL_CHECK_BATCH_SIZE))),
        );
      }
      const statuses = new Map(checked.map((tool) => [tool.target_id, tool]));
      return {
        tools: metadata.tools.map((tool) => ({
          ...tool,
          status: statuses.get(tool.preset_id) ?? null,
          supported: isInteractiveToolKind(tool.agent_kind),
        })),
      };
    },
    enabled: host.status === "online" && state === "ready",
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const installM = useMutation({
    mutationFn: async (tool: ToolRow) => {
      if (!client || !isInteractiveToolKind(tool.agent_kind)) {
        throw new HostControlError(
          "unsupported_tool",
          "Tool is not supported by the endpoint policy",
        );
      }
      return client.installTool({ target_id: tool.preset_id, tool: tool.agent_kind });
    },
    onSuccess: (result, tool) => {
      setLastResult({ name: tool.preset_name, result });
      qc.invalidateQueries({ queryKey: ["host-tools", host.id] });
    },
    onError: (err, tool) => {
      const uncertain = err instanceof HostControlError ? err.data : undefined;
      setLastResult({
        name: tool.preset_name,
        result: isInstallResult(uncertain) ? uncertain : undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });
  const policyM = useMutation({
    mutationFn: ({ tool, autoUpdate }: { tool: ToolRow; autoUpdate: boolean }) =>
      hosts.updateToolPolicy(host.id, tool.preset_id, { auto_update: autoUpdate }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["host-tools", host.id] });
    },
    onError: (err) => {
      setLastResult({
        name: "Policy",
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
          disabled={state !== "ready" || toolsQ.isFetching}
        >
          <RefreshCw className={`size-3.5 ${toolsQ.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {(state !== "ready" || toolsQ.isLoading) && (
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
      {state === "ready" && !toolsQ.isLoading && !toolsQ.error && tools.length === 0 && (
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
                  {tool.status?.installed && tool.status.version && (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {tool.status.version}
                    </span>
                  )}
                  {tool.status?.update_available && (
                    <Badge variant="warning">
                      update{tool.status.latest_version ? ` ${tool.status.latest_version}` : ""}
                    </Badge>
                  )}
                  {!tool.supported && <Badge variant="outline">unsupported policy</Badge>}
                  {tool.supported && !tool.status?.installed && (
                    <Badge variant="outline">not installed</Badge>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {tool.status?.error ? (
                    <span className="text-destructive">{tool.status.error}</span>
                  ) : !tool.supported ? (
                    "This custom target is not in the endpoint execution policy."
                  ) : (
                    (tool.status?.path ?? tool.status?.command.join(" ") ?? tool.agent_kind)
                  )}
                </div>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={tool.auto_update}
                  disabled={!tool.supported || tool.agent_kind === "shell" || policyM.isPending}
                  onChange={(event) =>
                    policyM.mutate({ tool, autoUpdate: event.currentTarget.checked })
                  }
                />
                Auto update (legacy)
              </label>
              <Button
                variant={
                  tool.status?.installed && !tool.status.update_available ? "outline" : "secondary"
                }
                size="sm"
                className="shrink-0"
                disabled={!tool.supported || tool.agent_kind === "shell" || installM.isPending}
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
                  : tool.status?.installed
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
            className={`mb-2 text-sm ${lastResult.result?.success ? "text-emerald-400" : "text-destructive"}`}
          >
            {lastResult.name}:{" "}
            {lastResult.result?.success
              ? "completed"
              : lastResult.result
                ? "outcome unknown"
                : "failed"}
            {lastResult.error ? ` · ${lastResult.error}` : ""}
          </div>
          {(lastResult.result?.stdout || lastResult.result?.stderr) && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 text-xs">
              {lastResult.result.stdout}
              {lastResult.result.stdout && lastResult.result.stderr ? "\n" : ""}
              {lastResult.result.stderr}
              {lastResult.result.output_truncated ? "\n[output truncated by endpoint]" : ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStatusIcon({ tool }: { tool: ToolRow }) {
  if (!tool.supported || tool.status?.error) {
    return <AlertCircle className="size-4 shrink-0 text-amber-400" aria-label="Target warning" />;
  }
  if (tool.status?.installed) {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-400" aria-label="Installed" />;
  }
  return <X className="size-4 shrink-0 text-muted-foreground" aria-label="Missing" />;
}

function isInstallResult(value: unknown): value is HostToolInstallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    ((value as { outcome?: unknown }).outcome === "succeeded" ||
      (value as { outcome?: unknown }).outcome === "unknown")
  );
}
