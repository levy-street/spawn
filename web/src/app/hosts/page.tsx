"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  type Host,
  type HostDaemonStatus,
  type HostToolInstallResult,
  type HostToolStatus,
  hosts,
} from "@/lib/api";

export default function HostsPage() {
  return (
    <AuthGate>
      <AppShell>
        <HostsList />
      </AppShell>
    </AuthGate>
  );
}

function HostsList() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const removeM = useMutation({
    mutationFn: (id: string) => hosts.remove(id),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["hosts"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => hosts.rename(id, name),
    onSuccess: () => {
      setEditingId(null);
      setDraftName("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["hosts"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const startRename = (host: Host) => {
    setEditingId(host.id);
    setDraftName(host.name);
    setError(null);
  };

  const submitRename = (host: Host) => {
    const next = draftName.trim();
    if (!next) {
      setError("Host name is required.");
      return;
    }
    if (next === host.name) {
      setEditingId(null);
      setDraftName("");
      return;
    }
    renameM.mutate({ id: host.id, name: next });
  };

  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Hosts</h1>
        <Button asChild variant="outline">
          <Link href="/device">Approve a daemon</Link>
        </Button>
      </header>

      {q.isLoading && <p className="text-sm text-muted-foreground">Loading hosts...</p>}
      {q.error && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load hosts: {String(q.error)}
        </p>
      )}
      {error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {!q.isLoading && !q.error && (q.data?.length ?? 0) === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No hosts yet</CardTitle>
            <CardDescription>
              Install <code>spawnd</code> on a machine, run <code>spawnd login</code>, and approve
              the device code from{" "}
              <Link href="/device" className="underline">
                /device
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <ul className="space-y-2">
        {(q.data ?? []).map((h: Host) => (
          <li key={h.id}>
            <Card>
              <CardContent className="space-y-4 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span
                        className={`inline-block size-2 rounded-full ${
                          h.status === "online" ? "bg-green-500" : "bg-zinc-500"
                        }`}
                        aria-hidden
                      />
                      {editingId === h.id ? (
                        <Input
                          aria-label="Host name"
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") submitRename(h);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="h-8"
                          disabled={renameM.isPending}
                        />
                      ) : (
                        <span className="truncate">{h.name}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {h.os ?? "unknown"}/{h.arch ?? "unknown"} · spawnd {h.version ?? "unknown"}
                      </span>
                      <span>{h.agent_count} agents</span>
                      {h.home_dir && <span className="truncate">home {h.home_dir}</span>}
                      {h.last_seen_at && (
                        <span>last seen {new Date(h.last_seen_at).toLocaleString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {editingId === h.id ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Save host name"
                          title="Save host name"
                          disabled={renameM.isPending}
                          onClick={() => submitRename(h)}
                        >
                          <Check className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Cancel rename"
                          title="Cancel rename"
                          disabled={renameM.isPending}
                          onClick={() => setEditingId(null)}
                        >
                          <X className="size-4" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Rename ${h.name}`}
                        title="Rename host"
                        onClick={() => startRename(h)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${h.name}`}
                      title="Remove host"
                      disabled={removeM.isPending}
                      onClick={() => {
                        if (confirm(`Remove host ${h.name}?`)) removeM.mutate(h.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <HostDaemonPanel host={h} />
                <HostToolsPanel host={h} />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HostDaemonPanel({ host }: { host: Host }) {
  const daemonQ = useQuery({
    queryKey: ["host-daemon", host.id],
    queryFn: () => hosts.daemonStatus(host.id),
    enabled: host.status === "online",
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  if (host.status !== "online") return null;

  const daemon = daemonQ.data;
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-xs text-muted-foreground">
          <span className="font-medium uppercase">Daemon</span>
          {daemonQ.isLoading && <span className="ml-2">Checking...</span>}
          {daemonQ.error && (
            <span className="ml-2 text-destructive">
              {daemonQ.error instanceof ApiError ? daemonQ.error.message : String(daemonQ.error)}
            </span>
          )}
          {daemon && <DaemonSummary daemon={daemon} />}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Refresh daemon status for ${host.name}`}
          title="Refresh daemon status"
          onClick={() => daemonQ.refetch()}
          disabled={daemonQ.isFetching}
        >
          <RefreshCw className={`size-4 ${daemonQ.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>
    </div>
  );
}

function DaemonSummary({ daemon }: { daemon: HostDaemonStatus }) {
  const clean = daemon.update?.clean;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-x-3 gap-y-1">
      <span>{daemon.agents.length} local agents</span>
      {clean !== undefined && clean !== null && (
        <span className={clean ? "text-green-500" : "text-amber-500"}>
          {clean ? "update clean" : "local changes present"}
        </span>
      )}
    </span>
  );
}

function HostToolsPanel({ host }: { host: Host }) {
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
      <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
        Daemon offline
      </div>
    );
  }

  const installingId = installM.variables?.preset_id;
  const tools = toolsQ.data?.tools ?? [];

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-xs font-medium uppercase text-muted-foreground">Targets</div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Refresh targets for ${host.name}`}
          title="Refresh targets"
          onClick={() => toolsQ.refetch()}
          disabled={toolsQ.isFetching}
        >
          <RefreshCw className={`size-4 ${toolsQ.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {toolsQ.isLoading && (
        <div className="px-3 py-3 text-sm text-muted-foreground">Checking targets...</div>
      )}
      {toolsQ.error && (
        <div className="px-3 py-3 text-sm text-destructive">
          {toolsQ.error instanceof ApiError ? toolsQ.error.message : String(toolsQ.error)}
        </div>
      )}
      {!toolsQ.isLoading && !toolsQ.error && tools.length === 0 && (
        <div className="px-3 py-3 text-sm text-muted-foreground">No preset targets.</div>
      )}

      {tools.length > 0 && (
        <div className="divide-y divide-border">
          {tools.map((tool) => (
            <div key={tool.preset_id} className="grid gap-3 px-3 py-3 sm:grid-cols-[1fr_auto]">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <ToolStatusIcon tool={tool} />
                  <span className="font-medium">{tool.preset_name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{tool.command}</code>
                  <span className="text-xs text-muted-foreground">{tool.agent_kind}</span>
                  {tool.update_available && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-500">
                      Update available
                    </span>
                  )}
                </div>
                <div className="space-y-0.5 text-xs text-muted-foreground">
                  {tool.installed ? (
                    <>
                      {tool.version && <div className="truncate">{tool.version}</div>}
                      {tool.latest_version && (
                        <div className="truncate">latest {tool.latest_version}</div>
                      )}
                      {tool.path && <div className="truncate">{tool.path}</div>}
                    </>
                  ) : (
                    <div>Missing from PATH</div>
                  )}
                  {tool.error && <div className="text-destructive">{tool.error}</div>}
                  {tool.last_auto_update_error && (
                    <div className="text-destructive">
                      auto update failed: {tool.last_auto_update_error}
                    </div>
                  )}
                  {tool.install && <div className="truncate">install {tool.install}</div>}
                  {tool.last_checked_at && (
                    <div>checked {new Date(tool.last_checked_at).toLocaleTimeString()}</div>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
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
                  disabled={!tool.install || installM.isPending}
                  onClick={() => {
                    if (confirm(`Run install/update for ${tool.preset_name} on ${host.name}?`)) {
                      setLastResult(null);
                      installM.mutate(tool);
                    }
                  }}
                >
                  <Download className="size-4" />
                  {installingId === tool.preset_id
                    ? "Running..."
                    : tool.installed
                      ? "Update"
                      : "Install"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {lastResult && (
        <div className="border-t border-border px-3 py-3">
          <div
            className={`mb-2 text-sm ${lastResult.success ? "text-green-500" : "text-destructive"}`}
          >
            {lastResult.preset_name}: {lastResult.success ? "completed" : "failed"}
            {lastResult.error ? ` · ${lastResult.error}` : ""}
          </div>
          {lastResult.output && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
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
    return <AlertCircle className="size-4 text-amber-500" aria-label="Target warning" />;
  }
  if (tool.installed) {
    return <CheckCircle2 className="size-4 text-green-500" aria-label="Installed" />;
  }
  return <X className="size-4 text-muted-foreground" aria-label="Missing" />;
}
