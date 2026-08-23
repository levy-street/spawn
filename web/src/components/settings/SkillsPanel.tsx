"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, type Skill, type SkillCreateInput, skills as skillApi } from "@/lib/api";

export function SkillsPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["skills"], queryFn: skillApi.list });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [enabledByDefault, setEnabledByDefault] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setName("");
    setDescription("");
    setContent("");
    setEnabledByDefault(false);
    setEditingId(null);
    setError(null);
  };

  const editSkill = (skill: Skill) => {
    setName(skill.name);
    setDescription(skill.description);
    setContent(skill.content);
    setEnabledByDefault(skill.enabled_by_default);
    setEditingId(skill.id);
    setError(null);
  };

  const createM = useMutation({
    mutationFn: skillApi.create,
    onSuccess: () => {
      resetForm();
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const updateM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: SkillCreateInput }) => skillApi.update(id, body),
    onSuccess: () => {
      resetForm();
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const removeM = useMutation({
    mutationFn: skillApi.remove,
    onSuccess: (_, removedId) => {
      if (editingId === removedId) resetForm();
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!content.trim()) {
      setError("Content is required.");
      return;
    }
    const body: SkillCreateInput = {
      name: name.trim(),
      description: description.trim(),
      content,
      enabled_by_default: enabledByDefault,
    };
    if (editingId) updateM.mutate({ id: editingId, body });
    else createM.mutate(body);
  };

  const busy = createM.isPending || updateM.isPending;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Skills</h2>
        <p className="text-sm text-muted-foreground">Manage agent-accessible skills.</p>
      </div>
      <form className="grid gap-3 @md/settings:grid-cols-2" onSubmit={onSubmit}>
        <div className="space-y-1">
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="skill-description">Description</Label>
          <Input
            id="skill-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="space-y-1 @md/settings:col-span-2">
          <Label htmlFor="skill-content">Content</Label>
          <Textarea
            id="skill-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={8}
            disabled={busy}
          />
        </div>
        <label className="flex items-center gap-2 text-sm @md/settings:col-span-2">
          <input
            type="checkbox"
            checked={enabledByDefault}
            onChange={(event) => setEnabledByDefault(event.currentTarget.checked)}
            disabled={busy}
          />
          Grant to new sessions by default
        </label>
        {(error || q.error) && (
          <p className="text-sm text-destructive @md/settings:col-span-2" role="alert">
            {error ?? `Failed to load skills: ${String(q.error)}`}
          </p>
        )}
        <div className="flex flex-wrap gap-2 @md/settings:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving..." : editingId ? "Update skill" : "Add skill"}
          </Button>
          {editingId && (
            <Button type="button" variant="secondary" onClick={resetForm} disabled={busy}>
              <X className="size-4" />
              Cancel
            </Button>
          )}
        </div>
      </form>
      <div className="divide-y divide-border rounded-md border border-border">
        {q.isLoading && <div className="p-3 text-sm text-muted-foreground">Loading skills...</div>}
        {!q.isLoading && !q.error && (q.data?.length ?? 0) === 0 && (
          <div className="p-3 text-sm text-muted-foreground">No skills yet.</div>
        )}
        {(q.data ?? []).map((skill) => (
          <div key={skill.id} className="flex items-start justify-between gap-3 p-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{skill.name}</span>
                {skill.enabled_by_default && (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[11px]">
                    default
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground">{skill.description}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit skill ${skill.name}`}
                title="Edit skill"
                disabled={busy}
                onClick={() => editSkill(skill)}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete skill ${skill.name}`}
                title="Delete skill"
                disabled={removeM.isPending}
                onClick={() => {
                  if (confirm(`Delete skill ${skill.name}?`)) removeM.mutate(skill.id);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
