"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronUp,
  Folder,
  Home,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { agentActivityDetail, agentCommand, agentTitle, isAgentArchived } from "@/lib/agents";
import {
  type Agent,
  ApiError,
  agents,
  type Host,
  hosts,
  mcpServers,
  presets,
  skills as skillApi,
} from "@/lib/api";
import { normalizeCommandText, parseArgv } from "@/lib/argv";

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
  const [creating, setCreating] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["agents", { includeArchived }],
    queryFn: () => agents.list({ include_archived: includeArchived }),
    refetchInterval: 5_000,
  });

  const invalidateAgents = () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["hosts"] });
  };

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => agents.rename(id, name),
    onSuccess: () => {
      setEditingId(null);
      setDraftName("");
      setError(null);
      invalidateAgents();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const archiveM = useMutation({
    mutationFn: (id: string) => agents.archive(id),
    onSuccess: invalidateAgents,
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const unarchiveM = useMutation({
    mutationFn: (id: string) => agents.unarchive(id),
    onSuccess: invalidateAgents,
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => agents.remove(id),
    onSuccess: invalidateAgents,
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const restartM = useMutation({
    mutationFn: (id: string) => agents.restart(id),
    onSuccess: invalidateAgents,
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const startRename = (agent: Agent) => {
    setEditingId(agent.id);
    setDraftName(agent.name ?? agentTitle(agent));
    setError(null);
  };

  const submitRename = (agent: Agent) => {
    const next = draftName.trim();
    if (!next) {
      setError("Agent name is required.");
      return;
    }
    if (next === agent.name) {
      setEditingId(null);
      setDraftName("");
      return;
    }
    renameM.mutate({ id: agent.id, name: next });
  };

  return (
    <div className="mx-auto w-full max-w-5xl p-4 @container/agents">
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Agents</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setIncludeArchived((v) => !v)}>
            {includeArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button onClick={() => setCreating((v) => !v)}>
            <Plus className="size-4" />
            New agent
          </Button>
        </div>
      </header>

      {creating && <NewAgentForm onClose={() => setCreating(false)} />}
      {error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {q.isLoading && <p className="text-sm text-muted-foreground">Loading agents...</p>}
      {q.error && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load agents: {String(q.error)}
        </p>
      )}
      {!q.isLoading && !q.error && (q.data?.length ?? 0) === 0 && !creating && (
        <Card>
          <CardHeader>
            <CardTitle>No agents</CardTitle>
            <CardDescription>Spawn one with the New agent button.</CardDescription>
          </CardHeader>
        </Card>
      )}

      <ul className="grid gap-3 @md/agents:grid-cols-2 @xl/agents:grid-cols-3">
        {(q.data ?? []).map((a: Agent) => (
          <AgentCard
            key={a.id}
            agent={a}
            editing={editingId === a.id}
            draftName={draftName}
            busy={
              renameM.isPending ||
              archiveM.isPending ||
              unarchiveM.isPending ||
              deleteM.isPending ||
              restartM.isPending
            }
            onDraftName={setDraftName}
            onStartRename={() => startRename(a)}
            onSubmitRename={() => submitRename(a)}
            onCancelRename={() => {
              setEditingId(null);
              setDraftName("");
            }}
            onArchive={() => archiveM.mutate(a.id)}
            onUnarchive={() => unarchiveM.mutate(a.id)}
            onRestart={() => {
              if (confirm(`Restart ${agentTitle(a)}?`)) restartM.mutate(a.id);
            }}
            onDelete={() => {
              if (confirm(`Delete ${agentTitle(a)}?`)) deleteM.mutate(a.id);
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function AgentCard({
  agent,
  editing,
  draftName,
  busy,
  onDraftName,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onArchive,
  onUnarchive,
  onRestart,
  onDelete,
}: {
  agent: Agent;
  editing: boolean;
  draftName: string;
  busy: boolean;
  onDraftName: (value: string) => void;
  onStartRename: () => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onRestart: () => void;
  onDelete: () => void;
}) {
  const archived = isAgentArchived(agent);

  return (
    <li>
      <Card className="transition hover:border-foreground/20">
        <CardHeader className="pb-3">
          {editing ? (
            <div className="flex items-center gap-1">
              <Input
                aria-label="Agent name"
                value={draftName}
                onChange={(e) => onDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmitRename();
                  if (e.key === "Escape") onCancelRename();
                }}
                className="h-8"
                disabled={busy}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label="Save agent name"
                title="Save agent name"
                disabled={busy}
                onClick={onSubmitRename}
              >
                <Check className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label="Cancel rename"
                title="Cancel rename"
                disabled={busy}
                onClick={onCancelRename}
              >
                <X className="size-4" />
              </Button>
            </div>
          ) : (
            <Link
              href={`/agents/${agent.id}`}
              className="flex min-w-0 items-start gap-2 focus:outline-none"
            >
              <AgentKindIcon agent={agent} className="mt-0.5" />
              <span className="min-w-0">
                <CardTitle className="truncate text-sm">{agentTitle(agent)}</CardTitle>
                <CardDescription className="truncate font-mono text-xs">
                  {agentCommand(agent)}
                </CardDescription>
              </span>
            </Link>
          )}
        </CardHeader>
        <CardContent className="flex items-end justify-between gap-3 pt-0">
          <Link href={`/agents/${agent.id}`} className="min-w-0 text-xs text-muted-foreground">
            <span className="block truncate">{agent.cwd}</span>
            <span className="mt-1 block">
              {agentActivityDetail(agent)}
              {archived ? " · ARCHIVED" : ""}
            </span>
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            {!editing && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Rename ${agentTitle(agent)}`}
                title="Rename agent"
                disabled={busy}
                onClick={onStartRename}
              >
                <Pencil className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Restart ${agentTitle(agent)}`}
              title="Restart agent"
              disabled={busy}
              onClick={onRestart}
            >
              <RotateCcw className="size-4" />
            </Button>
            {archived ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Unarchive ${agentTitle(agent)}`}
                title="Unarchive agent"
                disabled={busy}
                onClick={onUnarchive}
              >
                <ArchiveRestore className="size-4" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Archive ${agentTitle(agent)}`}
                title="Archive agent"
                disabled={busy}
                onClick={onArchive}
              >
                <Archive className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-destructive hover:text-destructive"
              aria-label={`Delete ${agentTitle(agent)}`}
              title="Delete agent"
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function DirectoryPicker({
  host,
  value,
  onChange,
  disabled,
}: {
  host: Host | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const homeDir = host?.home_dir?.trim() || "/";
  const resolved = normalizeCwdForHost(value, homeDir);
  const suggestion = splitForDirectorySuggestions(value, homeDir);
  const dirsQ = useQuery({
    queryKey: ["host-dirs", host?.id, suggestion.base],
    queryFn: () => hosts.dirs(host!.id, suggestion.base),
    enabled: Boolean(host?.id && host.status === "online"),
    staleTime: 5_000,
  });
  const listId = `agent-cwd-options-${host?.id ?? "none"}`;
  const entries = useMemo(() => {
    const prefix = suggestion.prefix.toLowerCase();
    return (dirsQ.data?.entries ?? []).filter((entry) =>
      entry.name.toLowerCase().startsWith(prefix),
    );
  }, [dirsQ.data?.entries, suggestion.prefix]);
  const parent = dirsQ.data?.parent ?? parentDir(resolved);
  const statusText = host
    ? host.status === "online"
      ? "Missing directories are created automatically."
      : "Host is offline."
    : "Choose a host first.";

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor="agent-cwd">Directory</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Use home directory"
            title="Use home directory"
            onClick={() => onChange(withTrailingSlash(homeDir))}
            disabled={disabled || !host}
          >
            <Home className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Parent directory"
            title="Parent directory"
            onClick={() => onChange(withTrailingSlash(parent))}
            disabled={disabled || !host}
          >
            <ChevronUp className="size-4" />
          </Button>
          <Input
            id="agent-cwd"
            list={listId}
            placeholder={homeDir}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            disabled={disabled || !host}
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Refresh directories"
            title="Refresh directories"
            onClick={() => dirsQ.refetch()}
            disabled={disabled || !host || host.status !== "online" || dirsQ.isFetching}
          >
            <RefreshCw className={`size-4 ${dirsQ.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <datalist id={listId}>
          {entries.map((entry) => (
            <option key={entry.path} value={entry.path} />
          ))}
        </datalist>
        <p className="text-xs text-muted-foreground">
          {statusText} Resolved path: <code>{resolved}</code>
        </p>
      </div>
      {host?.status === "online" && (
        <div className="rounded-md border border-border bg-background/60">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{suggestion.base}</span>
            {dirsQ.isError && <span className="shrink-0 text-destructive">Could not load</span>}
            {dirsQ.data?.error && <span className="shrink-0">New path</span>}
          </div>
          <div className="max-h-44 overflow-auto p-1">
            {parent && parent !== suggestion.base && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => onChange(withTrailingSlash(parent))}
                disabled={disabled}
              >
                <ChevronUp className="size-4 text-muted-foreground" />
                <span className="font-mono">..</span>
              </button>
            )}
            {entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => onChange(withTrailingSlash(entry.path))}
                disabled={disabled}
              >
                <Folder className="size-4 text-muted-foreground" />
                <span className="min-w-0 truncate font-mono">{entry.name}</span>
              </button>
            ))}
            {!dirsQ.isFetching && entries.length === 0 && (
              <div className="px-2 py-2 text-sm text-muted-foreground">
                {dirsQ.data?.error ? "No existing directory at this path." : "No matching folders."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NewAgentForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const presetsQ = useQuery({ queryKey: ["presets"], queryFn: presets.list });
  const mcpServersQ = useQuery({ queryKey: ["mcp-servers"], queryFn: mcpServers.list });
  const skillsQ = useQuery({ queryKey: ["skills"], queryFn: skillApi.list });

  const [hostId, setHostId] = useState("");
  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [cwd, setCwd] = useState("");
  const [argv, setArgv] = useState("");
  const [cols, setCols] = useState("120");
  const [rows, setRows] = useState("32");
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastAutoCwd, setLastAutoCwd] = useState("");
  const [presetTouched, setPresetTouched] = useState(false);

  const m = useMutation({
    mutationFn: agents.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const hostOptions = useMemo(
    () =>
      [...(hostsQ.data ?? [])].sort((a, b) => {
        if (a.status !== b.status) return a.status === "online" ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [hostsQ.data],
  );
  const presetOptions = useMemo(
    () =>
      [...(presetsQ.data ?? [])].sort((a, b) => {
        const order = ["codex", "claude-code", "opencode", "aider-sonnet", "shell"];
        const ai = order.indexOf(a.name);
        const bi = order.indexOf(b.name);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return a.name.localeCompare(b.name);
      }),
    [presetsQ.data],
  );
  const selectedHost = hostOptions.find((h) => h.id === hostId);
  const selectedHostHomeDir = selectedHost?.home_dir ?? "/";
  const selectedPreset = presetOptions.find((p) => p.id === presetId);
  const formDisabled = m.isPending || hostsQ.isLoading || presetsQ.isLoading;
  const mcpOptions = mcpServersQ.data ?? [];
  const skillOptions = skillsQ.data ?? [];

  useEffect(() => {
    if (hostId || hostOptions.length === 0) return;
    setHostId((hostOptions.find((h) => h.status === "online") ?? hostOptions[0]).id);
  }, [hostId, hostOptions]);

  useEffect(() => {
    if (presetTouched || presetId || argv.trim() || presetOptions.length === 0) return;
    setPresetId((presetOptions.find((p) => p.name === "codex") ?? presetOptions[0]).id);
  }, [argv, presetId, presetOptions, presetTouched]);

  useEffect(() => {
    setMcpServerIds((current) => mergeDefaults(current, mcpOptions));
  }, [mcpOptions]);

  useEffect(() => {
    setSkillIds((current) => mergeDefaults(current, skillOptions));
  }, [skillOptions]);

  useEffect(() => {
    if (!hostId) return;
    const nextCwd = withTrailingSlash(selectedHostHomeDir.trim() || "/");
    if (!cwd.trim() || cwd === lastAutoCwd) {
      setCwd(nextCwd);
      setLastAutoCwd(nextCwd);
    }
  }, [cwd, hostId, lastAutoCwd, selectedHostHomeDir]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!hostId) {
      setError("Choose a host.");
      return;
    }
    let argvArr: string[] | undefined;
    try {
      argvArr = argv.trim() ? parseArgv(argv) : undefined;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse argv.");
      return;
    }
    if (!presetId && !argvArr) {
      setError("Provide a preset or argv.");
      return;
    }
    const parsedCols = Number.parseInt(cols, 10);
    const parsedRows = Number.parseInt(rows, 10);
    if (!Number.isInteger(parsedCols) || parsedCols < 20 || parsedCols > 400) {
      setError("Columns must be between 20 and 400.");
      return;
    }
    if (!Number.isInteger(parsedRows) || parsedRows < 5 || parsedRows > 200) {
      setError("Rows must be between 5 and 200.");
      return;
    }
    m.mutate({
      name: name.trim() || undefined,
      host_id: hostId,
      preset_id: presetId || undefined,
      cwd: normalizeCwdForHost(cwd, selectedHostHomeDir),
      argv: argvArr,
      mcp_server_ids: mcpServerIds,
      skill_ids: skillIds,
      cols: parsedCols,
      rows: parsedRows,
      create_cwd: true,
    });
  };

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>New agent</CardTitle>
        <CardDescription>Choose a host, agent, and working directory.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 @md/agents:grid-cols-2" onSubmit={onSubmit}>
          <div className="space-y-1">
            <Label htmlFor="agent-host">Host</Label>
            <select
              id="agent-host"
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
              disabled={hostsQ.isLoading || m.isPending}
              aria-describedby="new-agent-status"
            >
              <option value="">Pick a host...</option>
              {hostOptions.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} ({h.status}
                  {h.home_dir ? ` · ${h.home_dir}` : ""})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-preset">Preset</Label>
            <select
              id="agent-preset"
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              value={presetId}
              onChange={(e) => {
                setPresetTouched(true);
                setPresetId(e.target.value);
              }}
              disabled={presetsQ.isLoading || m.isPending}
              aria-describedby={selectedPreset ? "agent-preset-details" : undefined}
            >
              <option value="">(custom argv)</option>
              {presetOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {selectedPreset && (
            <div
              id="agent-preset-details"
              className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground @md/agents:col-span-2"
            >
              <div>
                Default argv:{" "}
                <code className="text-foreground">{selectedPreset.default_argv.join(" ")}</code>
              </div>
              {selectedPreset.install && (
                <div className="mt-1">
                  Install: <code className="text-foreground">{selectedPreset.install}</code>
                </div>
              )}
            </div>
          )}
          <div className="@md/agents:col-span-2">
            <DirectoryPicker
              host={selectedHost}
              value={cwd}
              onChange={(next) => {
                setCwd(next);
                if (next !== lastAutoCwd) setLastAutoCwd("");
              }}
              disabled={m.isPending}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              placeholder="optional"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              disabled={m.isPending}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-argv">argv override</Label>
            <Input
              id="agent-argv"
              placeholder={selectedPreset ? "(use preset)" : "codex"}
              value={argv}
              onChange={(e) => setArgv(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-cols">Initial columns</Label>
            <Input
              id="agent-cols"
              type="number"
              min={20}
              max={400}
              value={cols}
              onChange={(e) => setCols(e.target.value)}
              disabled={m.isPending}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-rows">Initial rows</Label>
            <Input
              id="agent-rows"
              type="number"
              min={5}
              max={200}
              value={rows}
              onChange={(e) => setRows(e.target.value)}
              disabled={m.isPending}
            />
          </div>
          {(mcpOptions.length > 0 || skillOptions.length > 0) && (
            <div className="space-y-3 rounded-md border border-border p-3 @md/agents:col-span-2">
              <div className="text-sm font-medium">Access</div>
              {mcpOptions.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs uppercase text-muted-foreground">MCP servers</div>
                  <div className="flex flex-wrap gap-3">
                    {mcpOptions.map((server) => (
                      <label key={server.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={mcpServerIds.includes(server.id)}
                          onChange={(event) =>
                            setMcpServerIds((current) =>
                              toggleId(current, server.id, event.currentTarget.checked),
                            )
                          }
                        />
                        {server.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {skillOptions.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs uppercase text-muted-foreground">Skills</div>
                  <div className="flex flex-wrap gap-3">
                    {skillOptions.map((skill) => (
                      <label key={skill.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={skillIds.includes(skill.id)}
                          onChange={(event) =>
                            setSkillIds((current) =>
                              toggleId(current, skill.id, event.currentTarget.checked),
                            )
                          }
                        />
                        {skill.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {(hostsQ.error || presetsQ.error || error) && (
            <p
              id="new-agent-status"
              className="text-sm text-destructive @md/agents:col-span-2"
              role="alert"
            >
              {error ??
                (hostsQ.error
                  ? `Failed to load hosts: ${String(hostsQ.error)}`
                  : `Failed to load presets: ${String(presetsQ.error)}`)}
            </p>
          )}
          <div className="flex items-center gap-2 @md/agents:col-span-2">
            <Button type="submit" disabled={formDisabled}>
              {m.isPending ? "Spawning..." : "Spawn"}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={m.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function normalizeCwdForHost(value: string, homeDir: string): string {
  const home = trimTrailingSlash(normalizeCommandText(homeDir).trim() || "/") || "/";
  const raw = normalizeCommandText(value).trim();
  if (!raw) return home;
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return normalizeAbsolutePath(joinPath(home, raw.slice(2)));
  if (raw.startsWith("/")) return normalizeAbsolutePath(raw);
  return normalizeAbsolutePath(joinPath(home, raw));
}

function mergeDefaults<T extends { id: string; enabled_by_default: boolean }>(
  current: string[],
  options: T[],
): string[] {
  const available = new Set(options.map((option) => option.id));
  const next = current.filter((id) => available.has(id));
  for (const option of options) {
    if (option.enabled_by_default && !next.includes(option.id)) next.push(option.id);
  }
  return next;
}

function toggleId(current: string[], id: string, enabled: boolean): string[] {
  if (enabled) return current.includes(id) ? current : [...current, id];
  return current.filter((value) => value !== id);
}

function splitForDirectorySuggestions(
  value: string,
  homeDir: string,
): { base: string; prefix: string } {
  const raw = normalizeCommandText(value).trim();
  const resolved = normalizeCwdForHost(value, homeDir);
  if (!raw || raw.endsWith("/")) return { base: resolved, prefix: "" };
  return { base: parentDir(resolved), prefix: basename(resolved) };
}

function withTrailingSlash(path: string): string {
  const normalized = normalizeAbsolutePath(path.trim() || "/");
  return normalized === "/" ? normalized : `${normalized}/`;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

function parentDir(path: string): string {
  const normalized = trimTrailingSlash(normalizeAbsolutePath(path || "/"));
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

function basename(path: string): string {
  const normalized = trimTrailingSlash(path);
  if (normalized === "/") return "";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function joinPath(base: string, rest: string): string {
  if (!rest) return base;
  return `${trimTrailingSlash(base)}/${rest.replace(/^\/+/u, "")}`;
}

function normalizeAbsolutePath(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}
