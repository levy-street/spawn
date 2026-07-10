"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MoreHorizontal, PanelsTopLeft, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/agents";
import { ApiError, type View, views } from "@/lib/api";

export default function ViewsPage() {
  return (
    <AuthGate>
      <AppShell>
        <ViewsList />
      </AppShell>
    </AuthGate>
  );
}

function ViewsList() {
  const qc = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["views"], queryFn: views.list });

  const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : String(err));

  const createM = useMutation({
    mutationFn: () => {
      const existing = new Set((q.data ?? []).map((view) => view.name));
      let n = (q.data?.length ?? 0) + 1;
      while (existing.has(`View ${n}`)) n += 1;
      return views.create({ name: `View ${n}`, layout: { tabs: [{ name: null, agent_ids: [] }] } });
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["views"] });
      router.push(`/views/${created.id}`);
    },
    onError,
  });
  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => views.update(id, { name }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["views"] });
    },
    onError,
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => views.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views"] }),
    onError,
  });

  const promptRename = (view: View) => {
    const next = prompt("Rename view", view.name);
    if (next === null) return;
    const name = next.trim();
    if (name && name !== view.name) renameM.mutate({ id: view.id, name });
  };

  return (
    <div className="mx-auto w-full max-w-3xl p-4 @md/shell:p-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Views</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Saved multi-terminal arrangements.</p>
        </div>
        <Button size="sm" disabled={createM.isPending} onClick={() => createM.mutate()}>
          <Plus className="size-4" />
          New view
        </Button>
      </header>

      {(error || q.error) && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error ?? `Failed to load views: ${String(q.error)}`}
        </p>
      )}

      {q.isLoading && (
        <div className="overflow-hidden rounded-xl border border-border">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-4">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!q.isLoading && !q.error && (q.data?.length ?? 0) === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No views yet</CardTitle>
            <CardDescription>
              A view arranges several agent terminals on one screen — split panes, organized in
              tabs, saved under a name. Create one and add agents to its panes.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {(q.data?.length ?? 0) > 0 && (
        <ul className="overflow-hidden rounded-xl border border-border">
          {(q.data ?? []).map((view) => {
            const tabCount = view.layout.tabs.length;
            const agentCount = view.layout.tabs.reduce((sum, tab) => sum + tab.agent_ids.length, 0);
            return (
              <li
                key={view.id}
                className="group border-b border-border transition-colors last:border-b-0 hover:bg-accent/40"
              >
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <Link
                    href={`/views/${view.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
                      <PanelsTopLeft className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{view.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {tabCount} tab{tabCount === 1 ? "" : "s"} · {agentCount} agent
                        {agentCount === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      updated {relativeTime(view.updated_at) ?? "just now"}
                    </span>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
                      aria-hidden
                    />
                  </Link>
                  <DropdownMenu
                    renderTrigger={(props) => (
                      <Button
                        {...props}
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
                        aria-label={`${view.name} actions`}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    )}
                  >
                    <DropdownMenuItem
                      disabled={renameM.isPending}
                      onSelect={() => promptRename(view)}
                    >
                      <Pencil className="size-4" aria-hidden />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      destructive
                      disabled={deleteM.isPending}
                      onSelect={() => {
                        if (confirm(`Delete view ${view.name}?`)) deleteM.mutate(view.id);
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
