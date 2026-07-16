"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Download, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  code?: string;
  outcomeUnknown?: boolean;
  cancelled?: boolean;
}

interface ReconciliationEntry extends VisibleResult {
  targetId: string;
}

type ReconciliationMap = Record<string, ReconciliationEntry>;

const TOOL_CHECK_BATCH_SIZE = 8;

export function HostToolsPanel({ host }: { host: Host }) {
  const qc = useQueryClient();
  const { client, state } = useHostControl(host.id, host.status === "online");
  const [lastResult, setLastResult] = useState<VisibleResult | null>(null);
  const reconciliationKey = ["host-tool-reconciliation", host.id] as const;
  const reconciliationQ = useQuery<ReconciliationMap>({
    queryKey: reconciliationKey,
    queryFn: async () => ({}),
    initialData: {},
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  const reconciliationByTarget = reconciliationQ.data;
  const installAbortRef = useRef<{
    controller: AbortController;
    client: typeof client;
    hostId: string;
    tool: ToolRow;
  } | null>(null);
  useEffect(() => {
    const hostId = host.id;
    return () => {
      const active = installAbortRef.current;
      if (active?.client === client && active.hostId === hostId) {
        active.controller.abort();
        installAbortRef.current = null;
      }
    };
  }, [client, host.id]);
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
    mutationFn: async ({ tool, controller }: { tool: ToolRow; controller: AbortController }) => {
      if (!client || !isInteractiveToolKind(tool.agent_kind)) {
        throw new HostControlError(
          "unsupported_tool",
          "Tool is not supported by the endpoint policy",
        );
      }
      return client.installTool(
        { target_id: tool.preset_id, tool: tool.agent_kind },
        { signal: controller.signal },
      );
    },
    onSuccess: (result, { tool, controller }) => {
      if (controller.signal.aborted) {
        const unknown: ReconciliationEntry = {
          targetId: tool.preset_id,
          name: tool.preset_name,
          code: "outcome_unknown",
          outcomeUnknown: true,
          error: "Cancellation raced completion. Check the tool status before retrying.",
        };
        qc.setQueryData<ReconciliationMap>(reconciliationKey, (current = {}) => ({
          ...current,
          [tool.preset_id]: unknown,
        }));
        setLastResult(unknown);
        return;
      }
      setLastResult({ name: tool.preset_name, result });
      qc.invalidateQueries({ queryKey: ["host-tools", host.id] });
    },
    onError: (err, { tool }) => {
      const uncertain = err instanceof HostControlError ? err.data : undefined;
      const code = err instanceof HostControlError ? err.code : undefined;
      const visible: VisibleResult = {
        name: tool.preset_name,
        result: isInstallResult(uncertain) ? uncertain : undefined,
        error: err instanceof Error ? err.message : String(err),
        code,
        outcomeUnknown: code === "outcome_unknown",
        cancelled:
          code === "cancelled" || (err instanceof DOMException && err.name === "AbortError"),
      };
      if (visible.outcomeUnknown) {
        const unknown: ReconciliationEntry = {
          ...visible,
          targetId: tool.preset_id,
        };
        qc.setQueryData<ReconciliationMap>(reconciliationKey, (current = {}) => ({
          ...current,
          [tool.preset_id]: unknown,
        }));
        setLastResult(unknown);
      } else {
        setLastResult(visible);
      }
    },
    onSettled: (_result, _error, { controller }) => {
      if (installAbortRef.current?.controller === controller) installAbortRef.current = null;
    },
  });
  const reconcileM = useMutation({
    mutationFn: async (tool: ToolRow) => {
      if (!client || !isInteractiveToolKind(tool.agent_kind)) {
        throw new HostControlError(
          "unsupported_tool",
          "Tool is not supported by the endpoint policy",
        );
      }
      const [status] = await client.checkTools([
        { target_id: tool.preset_id, tool: tool.agent_kind },
      ]);
      if (!status || !isDefinitiveReconciliation(status)) {
        throw new HostControlError(
          "reconciliation_failed",
          status?.error ?? "Endpoint did not return a definitive tool status",
          status,
        );
      }
      return status;
    },
    onSuccess: (status, tool) => {
      qc.setQueryData<ReconciliationMap>(reconciliationKey, (current = {}) => {
        const next = { ...current };
        delete next[tool.preset_id];
        return next;
      });
      qc.setQueryData<{ tools: ToolRow[] }>(["host-tools", host.id], (current) =>
        current
          ? {
              tools: current.tools.map((row) =>
                row.preset_id === tool.preset_id ? { ...row, status } : row,
              ),
            }
          : current,
      );
      setLastResult(null);
    },
    onError: (error, tool) => {
      const existing = reconciliationByTarget[tool.preset_id];
      setLastResult({
        ...(existing ?? { name: tool.preset_name, outcomeUnknown: true }),
        error: `Check now failed: ${error instanceof Error ? error.message : String(error)}`,
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

  const installingId = installM.isPending ? installM.variables?.tool.preset_id : undefined;
  const tools = toolsQ.data?.tools ?? [];
  const visibleResult = lastResult ?? Object.values(reconciliationByTarget)[0] ?? null;

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
                  {reconciliationByTarget[tool.preset_id] && (
                    <Badge variant="warning">reconciliation required</Badge>
                  )}
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
                  disabled={
                    !tool.supported ||
                    tool.agent_kind === "shell" ||
                    policyM.isPending ||
                    (Boolean(reconciliationByTarget[tool.preset_id]) && !tool.auto_update)
                  }
                  onChange={(event) => {
                    const autoUpdate = event.currentTarget.checked;
                    if (reconciliationByTarget[tool.preset_id] && autoUpdate) return;
                    policyM.mutate({ tool, autoUpdate });
                  }}
                />
                Auto update (legacy)
              </label>
              <Button
                variant={
                  tool.status?.installed && !tool.status.update_available ? "outline" : "secondary"
                }
                size="sm"
                className="shrink-0"
                disabled={
                  !tool.supported ||
                  tool.agent_kind === "shell" ||
                  installM.isPending ||
                  Boolean(reconciliationByTarget[tool.preset_id])
                }
                onClick={() => {
                  if (reconciliationByTarget[tool.preset_id]) return;
                  if (confirm(`Run install/update for ${tool.preset_name} on ${host.name}?`)) {
                    setLastResult(null);
                    const controller = new AbortController();
                    installAbortRef.current?.controller.abort();
                    installAbortRef.current = { controller, client, hostId: host.id, tool };
                    installM.mutate({ tool, controller });
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
              {reconciliationByTarget[tool.preset_id] && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={reconcileM.isPending}
                  onClick={() => reconcileM.mutate(tool)}
                >
                  {reconcileM.isPending && reconcileM.variables?.preset_id === tool.preset_id
                    ? "Checking..."
                    : "Check now"}
                </Button>
              )}
              {installingId === tool.preset_id && installM.isPending && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    const active = installAbortRef.current;
                    if (!active || active.tool.preset_id !== tool.preset_id) return;
                    active.controller.abort();
                    setLastResult({
                      name: tool.preset_name,
                      code: "cancelling",
                      error: "Cancellation requested; waiting for the endpoint outcome.",
                    });
                  }}
                >
                  Cancel
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {visibleResult && (
        <div className="border-t border-border px-4 py-3">
          <div
            className={`mb-2 text-sm ${visibleResult.result?.success ? "text-emerald-400" : visibleResult.outcomeUnknown ? "text-amber-400" : "text-destructive"}`}
          >
            {visibleResult.name}:{" "}
            {visibleResult.result?.success
              ? "completed"
              : visibleResult.outcomeUnknown || visibleResult.result
                ? "outcome unknown"
                : visibleResult.cancelled
                  ? "cancelled"
                  : "failed"}
            {visibleResult.error ? ` · ${visibleResult.error}` : ""}
          </div>
          {visibleResult.outcomeUnknown && (
            <div className="mb-2 text-xs text-amber-300">
              Check now must return a definitive status before install or update is enabled. This
              install is never retried automatically.
            </div>
          )}
          {(visibleResult.result?.stdout || visibleResult.result?.stderr) && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 text-xs">
              {visibleResult.result.stdout}
              {visibleResult.result.stdout && visibleResult.result.stderr ? "\n" : ""}
              {visibleResult.result.stderr}
              {visibleResult.result.output_truncated ? "\n[output truncated by endpoint]" : ""}
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

function isDefinitiveReconciliation(status: HostToolStatus): boolean {
  if (status.error) return false;
  if (!status.installed) return true;
  return (
    typeof status.path === "string" &&
    typeof status.version === "string" &&
    typeof status.latest_version === "string" &&
    typeof status.update_available === "boolean"
  );
}
