"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { AgentIcon } from "@/components/icons/AgentIcon";
import {
  type AgentDraft,
  type AgentEnvRow,
  agentDraft,
  agentDraftToInput,
} from "@/components/settings/agent-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { confirm } from "@/components/ui/confirm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { type Agent, type AgentCreateInput, agents } from "@/lib/api";

export function AgentsPanel() {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<{ agent?: Agent } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list });
  const definitions = agentsQ.data ?? [];
  const builtIns = definitions.filter((agent) => agent.owner_user_id === null);
  const custom = definitions.filter((agent) => agent.owner_user_id !== null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agents"] });
  const createM = useMutation({
    mutationFn: agents.create,
    onSuccess: () => {
      setError(null);
      setEditor(null);
      refresh();
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  });
  const updateM = useMutation({
    mutationFn: ({ id, input }: { id: string; input: AgentCreateInput }) =>
      agents.update(id, input),
    onSuccess: () => {
      setError(null);
      setEditor(null);
      refresh();
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  });
  const removeM = useMutation({
    mutationFn: agents.remove,
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
  });

  const requestRemove = async (agent: Agent) => {
    const accepted = await confirm({
      title: `Delete ${agent.name}?`,
      body: "This removes the shortcut definition. Running sessions are not affected.",
      confirmLabel: "Delete agent",
      destructive: true,
    });
    if (accepted) removeM.mutate(agent.id);
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3" aria-labelledby="settings-agents-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="settings-agents-title" className="text-base font-semibold">
              Agents
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Shortcuts that type CLI commands into a session shell.
            </p>
          </div>
          <Button size="sm" onClick={() => setEditor({})}>
            <Plus className="size-4" aria-hidden />
            Add agent
          </Button>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {agentsQ.error && (
          <p className="text-sm text-destructive" role="alert">
            Failed to load agents: {String(agentsQ.error)}
          </p>
        )}
        {agentsQ.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {builtIns.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Lock className="size-3.5" aria-hidden />
              Built in
            </div>
            {builtIns.map((agent) => (
              <AgentDefinitionRow key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="custom-agents-title">
        <h3 id="custom-agents-title" className="text-sm font-medium">
          Custom agents
        </h3>
        {!agentsQ.isLoading && custom.length === 0 && (
          <p className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
            Add a shortcut for any CLI tool installed on your hosts.
          </p>
        )}
        {custom.map((agent) => (
          <AgentDefinitionRow
            key={agent.id}
            agent={agent}
            busy={updateM.isPending || removeM.isPending}
            onEdit={() => setEditor({ agent })}
            onRemove={() => void requestRemove(agent)}
          />
        ))}
      </section>

      <AgentEditorDialog
        open={editor !== null}
        agent={editor?.agent}
        busy={createM.isPending || updateM.isPending}
        error={error}
        onClose={() => {
          setEditor(null);
          setError(null);
        }}
        onSubmit={(input) => {
          if (editor?.agent) updateM.mutate({ id: editor.agent.id, input });
          else createM.mutate(input);
        }}
      />
    </div>
  );
}

function AgentDefinitionRow({
  agent,
  busy = false,
  onEdit,
  onRemove,
}: {
  agent: Agent;
  busy?: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  return (
    <Card className="shadow-none">
      <CardContent className="flex items-center gap-3 p-3">
        <AgentIcon kind={agent.kind} command={agent.command} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{agent.name}</span>
            {agent.owner_user_id === null && <Badge variant="outline">read only</Badge>}
          </div>
          <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">
            {agent.command}
          </code>
        </div>
        {onEdit && onRemove && (
          <DropdownMenu
            renderTrigger={(props) => (
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`${agent.name} actions`}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            )}
          >
            <DropdownMenuItem disabled={busy} onSelect={onEdit}>
              <Pencil className="size-4" aria-hidden />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem destructive disabled={busy} onSelect={onRemove}>
              <Trash2 className="size-4" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenu>
        )}
      </CardContent>
    </Card>
  );
}

function AgentEditorDialog({
  open,
  agent,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  agent?: Agent;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: AgentCreateInput) => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(() => agentDraft(agent));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(agentDraft(agent));
      setValidationError(null);
    }
  }, [agent, open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = agentDraftToInput(draft);
    if (!input.name || !input.kind || !input.command) {
      setValidationError("Name, kind, and command are required.");
      return;
    }
    const envKeys = draft.env.map((row) => row.key.trim()).filter(Boolean);
    if (new Set(envKeys).size !== envKeys.length) {
      setValidationError("Environment variable names must be unique.");
      return;
    }
    setValidationError(null);
    onSubmit(input);
  };

  const updateEnv = (id: string, patch: Partial<AgentEnvRow>) => {
    setDraft((current) => ({
      ...current,
      env: current.env.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : "Add an agent"}</DialogTitle>
          <DialogDescription>
            Define the command that appears in the session shortcut bar.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="min-h-0 overflow-y-auto">
          <div className="grid gap-4 px-4 py-2 @container/agent-form @sm/agent-form:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.currentTarget.value }))
                }
                placeholder="My agent"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-kind">Kind</Label>
              <Input
                id="agent-kind"
                value={draft.kind}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, kind: event.currentTarget.value }))
                }
                placeholder="custom"
              />
            </div>
            <div className="space-y-1.5 @sm/agent-form:col-span-2">
              <Label htmlFor="agent-command">Command</Label>
              <Input
                id="agent-command"
                value={draft.command}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, command: event.currentTarget.value }))
                }
                placeholder="my-agent --interactive"
              />
              <p className="text-xs text-muted-foreground">
                A single shell command, including arguments.
              </p>
            </div>
            <div className="space-y-1.5 @sm/agent-form:col-span-2">
              <Label htmlFor="agent-install">Install command (optional)</Label>
              <Input
                id="agent-install"
                value={draft.install}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, install: event.currentTarget.value }))
                }
                placeholder="npm install -g my-agent"
              />
            </div>
            <div className="space-y-2 @sm/agent-form:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Environment</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      env: [
                        ...current.env,
                        { id: `env-${Date.now()}-${current.env.length}`, key: "", value: "" },
                      ],
                    }))
                  }
                >
                  <Plus className="size-3.5" aria-hidden />
                  Add variable
                </Button>
              </div>
              {draft.env.length === 0 && (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  No environment variables.
                </p>
              )}
              {draft.env.map((row) => (
                <div key={row.id} className="grid grid-cols-[1fr_1fr_2rem] gap-2">
                  <Input
                    aria-label="Environment variable name"
                    value={row.key}
                    onChange={(event) => updateEnv(row.id, { key: event.currentTarget.value })}
                    placeholder="KEY"
                  />
                  <Input
                    aria-label="Environment variable value"
                    value={row.value}
                    onChange={(event) => updateEnv(row.id, { value: event.currentTarget.value })}
                    placeholder="value"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${row.key || "environment variable"}`}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        env: current.env.filter((item) => item.id !== row.id),
                      }))
                    }
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
            {(validationError || error) && (
              <p className="text-sm text-destructive @sm/agent-form:col-span-2" role="alert">
                {validationError ?? error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : agent ? "Save changes" : "Add agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
