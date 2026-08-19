"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { type WorkspaceTemplate, workspaceTemplates } from "@/lib/api";

function templateSummary(template: WorkspaceTemplate): string {
  const tabs = template.spec.tabs.length;
  const panes = template.spec.tabs.reduce((count, tab) => count + tab.tiles.length, 0);
  const agents = template.spec.tabs
    .flatMap((tab) => tab.tiles)
    .filter((tile) => tile.run.kind === "agent").length;
  const parts = [
    `${tabs} ${tabs === 1 ? "tab" : "tabs"}`,
    `${panes} ${panes === 1 ? "pane" : "panes"}`,
  ];
  if (agents > 0) parts.push(`${agents} ${agents === 1 ? "agent" : "agents"}`);
  return parts.join(" · ");
}

/** Saved workspace shapes: rename or delete them. New ones are made from a
 *  workspace's ⋯ menu ("Save as template"). */
export function TemplatesPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["workspace-templates"], queryFn: workspaceTemplates.list });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      workspaceTemplates.update(id, { name }),
    onSuccess: () => {
      setEditingId(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ["workspace-templates"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });
  const removeM = useMutation({
    mutationFn: workspaceTemplates.remove,
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["workspace-templates"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const submitRename = (id: string, event?: FormEvent) => {
    event?.preventDefault();
    const name = draft.trim();
    if (!name) return;
    renameM.mutate({ id, name: name.slice(0, 128) });
  };

  const requestDelete = async (template: WorkspaceTemplate) => {
    const accepted = await confirm({
      title: `Delete ${template.name}?`,
      body: "Workspaces already created from it are not affected.",
      confirmLabel: "Delete template",
      destructive: true,
    });
    if (accepted) removeM.mutate(template.id);
  };

  const templates = q.data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Workspace templates</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          A template is a workspace's shape — its tabs, pane arrangement, and what runs in each
          pane. Save one from a workspace's ⋯ menu; create from one via the New workspace button.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No templates yet. Open a workspace and choose "Save as template" from its ⋯ menu.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {templates.map((template) => (
            <li key={template.id} className="flex items-center gap-3 px-3 py-2.5">
              {editingId === template.id ? (
                <form
                  onSubmit={(event) => submitRename(template.id, event)}
                  className="flex min-w-0 flex-1 items-center gap-2"
                >
                  <Input
                    autoFocus
                    aria-label={`Rename ${template.name}`}
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    className="h-8 text-sm"
                  />
                  <Button
                    type="submit"
                    size="icon"
                    variant="ghost"
                    aria-label="Save name"
                    disabled={!draft.trim() || renameM.isPending}
                    className="size-8 shrink-0"
                  >
                    <Check className="size-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Cancel rename"
                    onClick={() => setEditingId(null)}
                    className="size-8 shrink-0"
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                </form>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{template.name}</p>
                    <p className="text-xs text-muted-foreground">{templateSummary(template)}</p>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Rename ${template.name}`}
                    onClick={() => {
                      setDraft(template.name);
                      setEditingId(template.id);
                    }}
                    className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${template.name}`}
                    onClick={() => void requestDelete(template)}
                    disabled={removeM.isPending}
                    className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
