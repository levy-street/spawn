"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, type Preset, type PresetCreateInput, presets } from "@/lib/api";
import { parseArgv, parseEnvLines } from "@/lib/argv";
import { logout, useAuth } from "@/lib/auth";

export default function SettingsPage() {
  return (
    <AuthGate>
      <AppShell>
        <SettingsView />
      </AppShell>
    </AuthGate>
  );
}

function SettingsView() {
  const { user } = useAuth();
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4 @container/settings">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Signed in as {user?.email ?? "—"}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="secondary"
            onClick={() => {
              void logout();
            }}
          >
            Log out
          </Button>
        </CardContent>
      </Card>
      <PresetsSettings />
      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>Account deletion is not yet wired up.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function PresetsSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["presets"], queryFn: presets.list });
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [argv, setArgv] = useState("");
  const [install, setInstall] = useState("");
  const [envText, setEnvText] = useState("");
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setName("");
    setKind("");
    setArgv("");
    setInstall("");
    setEnvText("");
    setEditingPresetId(null);
    setError(null);
  };

  const editPreset = (preset: Preset) => {
    setName(preset.name);
    setKind(preset.agent_kind);
    setArgv(formatArgv(preset.default_argv));
    setInstall(preset.install ?? "");
    setEnvText(formatEnvTemplate(preset.env_template));
    setEditingPresetId(preset.id);
    setError(null);
  };

  const createM = useMutation({
    mutationFn: presets.create,
    onSuccess: () => {
      resetForm();
      qc.invalidateQueries({ queryKey: ["presets"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const updateM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PresetCreateInput }) => presets.update(id, body),
    onSuccess: () => {
      resetForm();
      qc.invalidateQueries({ queryKey: ["presets"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const removeM = useMutation({
    mutationFn: (id: string) => presets.remove(id),
    onSuccess: (_, removedId) => {
      if (editingPresetId === removedId) resetForm();
      setError(null);
      qc.invalidateQueries({ queryKey: ["presets"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    let defaultArgv: string[];
    let envTemplate: Record<string, string>;
    try {
      defaultArgv = parseArgv(argv);
      envTemplate = parseEnvLines(envText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse preset fields.");
      return;
    }

    if (!name.trim()) {
      setError("Preset name is required.");
      return;
    }
    if (!kind.trim()) {
      setError("Agent kind is required.");
      return;
    }
    if (defaultArgv.length === 0) {
      setError("Default argv is required.");
      return;
    }

    const body: PresetCreateInput = {
      name: name.trim(),
      agent_kind: kind.trim(),
      default_argv: defaultArgv,
      env_template: envTemplate,
      install: install.trim() || (editingPresetId ? null : undefined),
    };

    if (editingPresetId) updateM.mutate({ id: editingPresetId, body });
    else createM.mutate(body);
  };

  const isSaving = createM.isPending || updateM.isPending;
  const isEditing = editingPresetId !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Presets</CardTitle>
        <CardDescription>Manage reusable agent commands and optional installers.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="grid gap-3 @md/settings:grid-cols-2" onSubmit={onSubmit}>
          <div className="space-y-1">
            <Label htmlFor="preset-name">Name</Label>
            <Input
              id="preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="aider-sonnet"
              disabled={isSaving}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="preset-kind">Agent kind</Label>
            <Input
              id="preset-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              placeholder="aider"
              disabled={isSaving}
            />
          </div>
          <div className="space-y-1 @md/settings:col-span-2">
            <Label htmlFor="preset-argv">Default argv</Label>
            <Input
              id="preset-argv"
              value={argv}
              onChange={(e) => setArgv(e.target.value)}
              placeholder='aider --model "claude-sonnet-4-6"'
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={isSaving}
            />
          </div>
          <div className="space-y-1 @md/settings:col-span-2">
            <Label htmlFor="preset-install">Install command (optional)</Label>
            <Input
              id="preset-install"
              value={install}
              onChange={(e) => setInstall(e.target.value)}
              placeholder="pipx install aider-chat"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={isSaving}
            />
          </div>
          <div className="space-y-1 @md/settings:col-span-2">
            <Label htmlFor="preset-env">Env template (optional)</Label>
            <Textarea
              id="preset-env"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="FOO=bar"
              rows={3}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={isSaving}
            />
          </div>
          {(error || q.error) && (
            <p className="text-sm text-destructive @md/settings:col-span-2" role="alert">
              {error ?? `Failed to load presets: ${String(q.error)}`}
            </p>
          )}
          <div className="flex flex-wrap gap-2 @md/settings:col-span-2">
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving..." : isEditing ? "Update preset" : "Add preset"}
            </Button>
            {isEditing && (
              <Button type="button" variant="secondary" onClick={resetForm} disabled={isSaving}>
                <X className="size-4" />
                Cancel
              </Button>
            )}
          </div>
        </form>

        <div className="divide-y divide-border rounded-md border border-border">
          {q.isLoading && (
            <div className="p-3 text-sm text-muted-foreground">Loading presets...</div>
          )}
          {!q.isLoading && !q.error && (q.data?.length ?? 0) === 0 && (
            <div className="p-3 text-sm text-muted-foreground">No presets yet.</div>
          )}
          {(q.data ?? []).map((preset) => (
            <div key={preset.id} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{preset.name}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {preset.owner_user_id ? "custom" : "built-in"}
                  </span>
                  <span className="text-xs text-muted-foreground">{preset.agent_kind}</span>
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {preset.default_argv.join(" ")}
                </div>
                {preset.install && (
                  <div className="truncate text-xs text-muted-foreground">
                    Install: <code>{preset.install}</code>
                  </div>
                )}
              </div>
              {preset.owner_user_id && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit preset ${preset.name}`}
                    title="Edit preset"
                    disabled={isSaving}
                    onClick={() => editPreset(preset)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete preset ${preset.name}`}
                    title="Delete preset"
                    disabled={removeM.isPending}
                    onClick={() => {
                      if (confirm(`Delete preset ${preset.name}?`)) removeM.mutate(preset.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function formatArgv(argv: string[]): string {
  return argv.map(formatArg).join(" ");
}

function formatArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function formatEnvTemplate(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
