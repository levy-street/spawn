"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentActivityDetail, agentActivityLabel, agentCommand, agentTitle } from "@/lib/agents";
import { type Agent, agents } from "@/lib/api";
import { cn } from "@/lib/utils";

export function AgentSidebar({
  pathname,
  collapsed = false,
}: {
  pathname: string;
  collapsed?: boolean;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({
    queryKey: ["agents"],
    queryFn: () => agents.list(),
    refetchInterval: 5_000,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["hosts"] });
    if (id) qc.invalidateQueries({ queryKey: ["agent", id] });
  };

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => agents.rename(id, name),
    onSuccess: (_agent, vars) => {
      setEditingId(null);
      setDraftName("");
      setActionError(null);
      invalidate(vars.id);
    },
    onError: (err) => setActionError(String(err)),
  });

  const archiveM = useMutation({
    mutationFn: (id: string) => agents.archive(id),
    onSuccess: (_agent, id) => {
      setActionError(null);
      invalidate(id);
      if (pathname === `/agents/${id}`) router.push("/agents");
    },
    onError: (err) => setActionError(String(err)),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => agents.remove(id),
    onSuccess: (_result, id) => {
      setActionError(null);
      invalidate(id);
      if (pathname === `/agents/${id}`) router.push("/agents");
    },
    onError: (err) => setActionError(String(err)),
  });

  const startRename = (agent: Agent) => {
    setEditingId(agent.id);
    setDraftName(agent.name ?? agentTitle(agent));
    setActionError(null);
  };

  const submitRename = (agent: Agent) => {
    const name = draftName.trim();
    if (!name) {
      setActionError("Agent name is required.");
      return;
    }
    if (name === agent.name) {
      setEditingId(null);
      setDraftName("");
      return;
    }
    renameM.mutate({ id: agent.id, name });
  };

  const visible = q.data ?? [];
  const busy = renameM.isPending || archiveM.isPending || deleteM.isPending;

  if (collapsed) {
    return (
      <section className="mt-5 min-h-0 px-1">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="mb-2 size-10"
          aria-label="New agent"
          title="New agent"
        >
          <Link href="/agents">
            <Plus className="size-4" />
          </Link>
        </Button>
        <ul className="max-h-[48vh] space-y-1 overflow-y-auto">
          {visible.map((agent) => {
            const active = pathname === `/agents/${agent.id}`;
            return (
              <li key={agent.id}>
                <Link
                  href={`/agents/${agent.id}`}
                  aria-current={active ? "page" : undefined}
                  title={`${agentTitle(agent)} · ${agentCommand(agent)} · ${agentActivityDetail(agent)} · ${agent.cwd}`}
                  className={cn(
                    "relative flex size-10 items-center justify-center rounded-md transition-colors",
                    active ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <AgentKindIcon agent={agent} className="size-8" iconClassName="size-4" />
                  <AgentStatusDot agent={agent} className="absolute bottom-1 right-1" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <section className="mt-5 min-h-0 px-2">
      <div className="mb-2 flex items-center justify-between px-2">
        <h2 className="text-[11px] font-medium uppercase text-muted-foreground">Agents</h2>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="New agent"
          title="New agent"
        >
          <Link href="/agents">
            <Plus className="size-4" />
          </Link>
        </Button>
      </div>
      {actionError && <p className="mb-2 px-2 text-[11px] text-destructive">{actionError}</p>}
      <ul className="max-h-[48vh] space-y-1 overflow-y-auto pr-1">
        {visible.map((agent) => {
          const active = pathname === `/agents/${agent.id}`;
          const editing = editingId === agent.id;
          return (
            <li key={agent.id} className="group relative">
              {editing ? (
                <form
                  className="flex items-center gap-1 rounded-md border border-border bg-background p-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitRename(agent);
                  }}
                >
                  <AgentKindIcon agent={agent} className="size-7" />
                  <Input
                    aria-label="Agent name"
                    value={draftName}
                    disabled={busy}
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setEditingId(null);
                        setDraftName("");
                      }
                    }}
                    className="h-7 min-w-0 px-2 text-xs"
                    autoFocus
                  />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={busy}
                    aria-label="Save agent name"
                    title="Save agent name"
                  >
                    <Check className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={busy}
                    aria-label="Cancel rename"
                    title="Cancel rename"
                    onClick={() => {
                      setEditingId(null);
                      setDraftName("");
                    }}
                  >
                    <X className="size-3.5" />
                  </Button>
                </form>
              ) : (
                <>
                  <Link
                    href={`/agents/${agent.id}`}
                    aria-current={active ? "page" : undefined}
                    title={`${agentTitle(agent)} · ${agentCommand(agent)} · ${agentActivityDetail(agent)} · ${agent.cwd}`}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors group-hover:pr-[4.25rem] group-focus-within:pr-[4.25rem]",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <div className="relative shrink-0">
                      <AgentKindIcon agent={agent} />
                      <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5" />
                    </div>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{agentTitle(agent)}</span>
                      <span className="block truncate text-[10px] opacity-70">
                        {agentActivityDetail(agent)}
                      </span>
                    </span>
                  </Link>
                  <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded-md bg-card/95 opacity-0 shadow-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Rename ${agentTitle(agent)}`}
                      title="Rename agent"
                      disabled={busy}
                      onClick={() => startRename(agent)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Archive ${agentTitle(agent)}`}
                      title="Archive agent"
                      disabled={busy}
                      onClick={() => archiveM.mutate(agent.id)}
                    >
                      <Archive className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive hover:text-destructive"
                      aria-label={`Delete ${agentTitle(agent)}`}
                      title="Delete agent"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Delete ${agentTitle(agent)}?`)) deleteM.mutate(agent.id);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </>
              )}
            </li>
          );
        })}
        {!q.isLoading && visible.length === 0 && (
          <li className="px-2 py-1 text-xs text-muted-foreground">No agents</li>
        )}
      </ul>
    </section>
  );
}

function AgentStatusDot({ agent, className }: { agent: Agent; className?: string }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full border border-card",
        agent.activity_state === "active"
          ? "bg-green-500"
          : agent.activity_state === "waiting"
            ? "bg-sky-500"
            : agent.activity_state === "input_sent"
              ? "bg-violet-500"
              : agent.activity_state === "starting"
                ? "bg-yellow-500"
                : agent.activity_state === "quiet"
                  ? "bg-zinc-400"
                  : "bg-zinc-600",
        className,
      )}
      role="img"
      aria-label={agentActivityLabel(agent)}
      title={agentActivityDetail(agent)}
    />
  );
}
