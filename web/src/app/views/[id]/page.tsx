"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Terminal, type TerminalHandle } from "@/components/terminal/Terminal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { AgentStatusDot } from "@/components/ui/status";
import { agentActivityDetail, agentTitle } from "@/lib/agents";
import { type Agent, ApiError, agents, type ViewLayout, views } from "@/lib/api";
import { useAgentDrop } from "@/lib/dnd";
import { cn } from "@/lib/utils";
import type { DisplayControlState } from "@/lib/ws";

const MOBILE_PROMPT_NEWLINE = "\x1b[200~\n\x1b[201~";
const MAX_PANES_PER_TAB = 4;

export default function ViewDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  return (
    <AuthGate>
      <AppShell hideMobileNav mainClassName="overflow-hidden">
        {/* Keying on the view id resets all editor state on navigation. */}
        {id ? <ViewScreen key={id} id={id} /> : null}
      </AppShell>
    </AuthGate>
  );
}

function ViewScreen({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();

  const [layout, setLayout] = useState<ViewLayout | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["view", id],
    queryFn: () => views.get(id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => agents.list(),
    refetchInterval: 5_000,
  });
  const agentsById = useMemo(
    () => new Map((agentsQ.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQ.data],
  );

  // Seed the editable layout once per view; PATCH responses stay canonical.
  useEffect(() => {
    if (q.data && layout === null) {
      setLayout(
        q.data.layout.tabs.length ? q.data.layout : { tabs: [{ name: null, agent_ids: [] }] },
      );
    }
  }, [q.data, layout]);
  const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : String(err));

  const saveM = useMutation({
    mutationFn: (next: ViewLayout) => views.update(id, { layout: next }),
    onSuccess: (saved) => {
      setError(null);
      qc.setQueryData(["view", id], saved);
      qc.invalidateQueries({ queryKey: ["views"] });
    },
    onError,
  });
  const renameM = useMutation({
    mutationFn: (name: string) => views.update(id, { name }),
    onSuccess: (saved) => {
      setError(null);
      setEditingName(false);
      qc.setQueryData(["view", id], saved);
      qc.invalidateQueries({ queryKey: ["views"] });
    },
    onError,
  });
  const deleteM = useMutation({
    mutationFn: () => views.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["views"] });
      router.push("/views");
    },
    onError,
  });

  const commit = (next: ViewLayout) => {
    setLayout(next);
    saveM.mutate(next);
  };

  const view = q.data;
  const tabs = layout?.tabs ?? [];
  const tabIndex = Math.min(activeTab, Math.max(0, tabs.length - 1));
  const tab = tabs[tabIndex];

  const submitRename = () => {
    const next = draftName.trim();
    if (!view || !next || next === view.name) {
      setEditingName(false);
      return;
    }
    renameM.mutate(next);
  };

  const updateTab = (index: number, agentIds: string[]) => {
    if (!layout) return;
    commit({
      tabs: layout.tabs.map((t, i) => (i === index ? { ...t, agent_ids: agentIds } : t)),
    });
  };
  const addAgentToTab = (index: number, agentId: string) => {
    if (!layout) return;
    const target = layout.tabs[index];
    if (!target || target.agent_ids.includes(agentId)) return;
    if (target.agent_ids.length >= MAX_PANES_PER_TAB) {
      setError("That tab already has 4 panes — drop on another tab or remove one first.");
      return;
    }
    setError(null);
    updateTab(index, [...target.agent_ids, agentId]);
  };
  const addTab = () => {
    if (!layout || layout.tabs.length >= 8) return;
    commit({ tabs: [...layout.tabs, { name: null, agent_ids: [] }] });
    setActiveTab(layout.tabs.length);
  };
  const renameTab = (index: number) => {
    if (!layout) return;
    const current = layout.tabs[index];
    const next = prompt("Rename tab", current?.name ?? `Tab ${index + 1}`);
    if (next === null) return;
    commit({
      tabs: layout.tabs.map((t, i) => (i === index ? { ...t, name: next.trim() || null } : t)),
    });
  };
  const closeTab = (index: number) => {
    if (!layout || layout.tabs.length <= 1) return;
    commit({ tabs: layout.tabs.filter((_, i) => i !== index) });
    setActiveTab(Math.max(0, tabIndex - (index <= tabIndex ? 1 : 0)));
  };

  return (
    <div className="flex h-vv flex-col bg-background pad-safe-top">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-2 pad-safe-x sm:px-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="All views"
        >
          <Link href="/views">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>

        {editingName ? (
          <Input
            aria-label="View name"
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setEditingName(false);
            }}
            className="h-7 max-w-48 text-sm"
            disabled={renameM.isPending}
          />
        ) : (
          <button
            type="button"
            className="max-w-48 shrink-0 truncate rounded px-0.5 text-sm font-semibold tracking-tight hover:bg-accent/50"
            title="Rename view"
            onClick={() => {
              if (!view) return;
              setDraftName(view.name);
              setEditingName(true);
            }}
          >
            {view?.name ?? "…"}
          </button>
        )}

        {/* Tab strip */}
        <div
          role="tablist"
          aria-label="View tabs"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1"
        >
          {tabs.map((t, i) => {
            const active = i === tabIndex;
            const label = t.name?.trim() || `Tab ${i + 1}`;
            return (
              <TabPill
                // biome-ignore lint/suspicious/noArrayIndexKey: tabs are positional; reordering is not supported
                key={`tab-${i}`}
                active={active}
                onDropAgent={(agentId) => addAgentToTab(i, agentId)}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="max-w-40 truncate py-1.5 pl-3 pr-1.5"
                  onClick={() => setActiveTab(i)}
                >
                  {label}
                </button>
                {active ? (
                  <DropdownMenu
                    align="start"
                    renderTrigger={(props) => (
                      <button
                        {...props}
                        type="button"
                        aria-label={`${label} tab options`}
                        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                      >
                        <ChevronDown className="size-3" aria-hidden />
                      </button>
                    )}
                  >
                    <DropdownMenuItem onSelect={() => renameTab(i)}>
                      <Pencil className="size-4" aria-hidden />
                      Rename tab
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      destructive
                      disabled={tabs.length <= 1}
                      onSelect={() => closeTab(i)}
                    >
                      <X className="size-4" aria-hidden />
                      Close tab
                    </DropdownMenuItem>
                  </DropdownMenu>
                ) : (
                  <span className="w-1.5" aria-hidden />
                )}
              </TabPill>
            );
          })}
          <button
            type="button"
            aria-label="New tab"
            title="New tab"
            onClick={addTab}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </div>

        <span
          className={cn(
            "hidden shrink-0 text-[11px] text-muted-foreground transition-opacity sm:inline",
            saveM.isPending ? "opacity-100" : "opacity-0",
          )}
          aria-hidden={!saveM.isPending}
        >
          Saving…
        </span>
        <DropdownMenu
          renderTrigger={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="View actions"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        >
          <DropdownMenuItem
            onSelect={() => {
              if (!view) return;
              setDraftName(view.name);
              setEditingName(true);
            }}
          >
            <Pencil className="size-4" aria-hidden />
            Rename view
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={addTab}>
            <Plus className="size-4" aria-hidden />
            New tab
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            disabled={deleteM.isPending}
            onSelect={() => {
              if (view && confirm(`Delete view ${view.name}?`)) deleteM.mutate();
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            Delete view
          </DropdownMenuItem>
        </DropdownMenu>
      </header>

      {(error || q.error) && (
        <p className="px-4 py-2 text-sm text-destructive" role="alert">
          {error ?? `Failed to load view: ${String(q.error)}`}
        </p>
      )}

      {tab && (
        <PaneGrid
          key={`${id}-${tabIndex}`}
          tabAgentIds={tab.agent_ids}
          agentsById={agentsById}
          allAgents={agentsQ.data ?? []}
          onChange={(agentIds) => updateTab(tabIndex, agentIds)}
          onDropAgent={(agentId) => addAgentToTab(tabIndex, agentId)}
        />
      )}
    </div>
  );
}

function TabPill({
  active,
  onDropAgent,
  children,
}: {
  active: boolean;
  onDropAgent: (agentId: string) => void;
  children: React.ReactNode;
}) {
  const { active: dropActive, dropProps } = useAgentDrop((agentId) => onDropAgent(agentId));
  return (
    <span
      {...dropProps}
      className={cn(
        "flex shrink-0 items-center overflow-hidden rounded-lg border text-xs transition-colors",
        active
          ? "border-border bg-accent text-accent-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        dropActive && "border-ring bg-accent text-foreground ring-2 ring-ring/40",
      )}
    >
      {children}
    </span>
  );
}

function PaneGrid({
  tabAgentIds,
  agentsById,
  allAgents,
  onChange,
  onDropAgent,
}: {
  tabAgentIds: string[];
  agentsById: Map<string, Agent>;
  allAgents: Agent[];
  onChange: (agentIds: string[]) => void;
  onDropAgent: (agentId: string) => void;
}) {
  const { active: dropActive, dropProps } = useAgentDrop(onDropAgent);
  const canAdd = tabAgentIds.length < MAX_PANES_PER_TAB;
  const slotCount = tabAgentIds.length + (canAdd ? 1 : 0);
  const candidates = allAgents.filter(
    (agent) => !tabAgentIds.includes(agent.id) && agent.archived_at === null,
  );

  return (
    <div {...dropProps} className="@container/view relative min-h-0 flex-1 overflow-hidden">
      {dropActive && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-ring bg-background/60">
          <span className="rounded-lg border border-border bg-popover px-3 py-1.5 text-sm shadow-lg">
            Drop to add to this tab
          </span>
        </div>
      )}
      <div
        className={cn(
          "flex h-full flex-col gap-px overflow-y-auto bg-border",
          "@2xl/view:grid @2xl/view:overflow-hidden",
          slotCount <= 1 && "@2xl/view:grid-cols-1",
          slotCount === 2 && "@2xl/view:grid-cols-2",
          slotCount >= 3 && "@2xl/view:grid-cols-2 @2xl/view:grid-rows-2",
        )}
      >
        {tabAgentIds.map((agentId, index) => (
          <ViewPane
            key={agentId}
            agent={agentsById.get(agentId)}
            agentId={agentId}
            className={cn(slotCount === 3 && index === 0 && "@2xl/view:row-span-2")}
            onRemove={() => onChange(tabAgentIds.filter((existing) => existing !== agentId))}
          />
        ))}
        {canAdd && (
          <div
            className={cn(
              "grid min-h-40 place-items-center bg-background @2xl/view:min-h-0",
              tabAgentIds.length === 0 && "min-h-[60dvh]",
            )}
          >
            <DropdownMenu
              side="bottom"
              align="start"
              menuClassName="w-72 max-h-80 overflow-y-auto"
              renderTrigger={(props) => (
                <button
                  {...props}
                  type="button"
                  className="flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
                >
                  <Plus className="size-4" aria-hidden />
                  Add agent
                </button>
              )}
            >
              {candidates.length === 0 && (
                <DropdownMenuLabel>No other agents available</DropdownMenuLabel>
              )}
              {candidates.map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  onSelect={() => onChange([...tabAgentIds, agent.id])}
                >
                  <AgentKindIcon
                    agent={agent}
                    className="size-5 rounded-md"
                    iconClassName="size-3"
                  />
                  <span className="min-w-0 flex-1 truncate">{agentTitle(agent)}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {agent.host_name ?? ""}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  );
}

function ViewPane({
  agent,
  agentId,
  className,
  onRemove,
}: {
  agent: Agent | undefined;
  agentId: string;
  className?: string;
  onRemove: () => void;
}) {
  const termRef = useRef<TerminalHandle>(null);
  const [displayState, setDisplayState] = useState<DisplayControlState | null>(null);

  return (
    <section
      aria-label={agent ? agentTitle(agent) : "Missing agent"}
      className={cn(
        "flex min-h-[50dvh] min-w-0 flex-col overflow-hidden bg-background @2xl/view:min-h-0",
        className,
      )}
    >
      {/* Mini pane header */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 bg-card/60 px-2">
        {agent ? (
          <>
            <span className="relative shrink-0">
              <AgentKindIcon agent={agent} className="size-5 rounded-md" iconClassName="size-3" />
              <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5 size-1.5" />
            </span>
            <span className="min-w-0 truncate text-xs font-medium">{agentTitle(agent)}</span>
            <span className="hidden min-w-0 truncate text-[10px] text-muted-foreground @xl/view:inline">
              {agentActivityDetail(agent)}
            </span>
            <span className="flex-1" />
            {displayState && !displayState.owner && (
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => termRef.current?.takeControl()}
              >
                Take control
              </button>
            )}
            <Link
              href={`/agents/${agent.id}`}
              aria-label={`Open ${agentTitle(agent)} full screen`}
              title="Open full screen"
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <Maximize2 className="size-3" aria-hidden />
            </Link>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              Agent no longer exists
            </span>
            <span className="flex-1" />
          </>
        )}
        <button
          type="button"
          aria-label="Remove pane"
          title="Remove from view"
          onClick={onRemove}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>

      {agent ? (
        <div className="relative min-h-0 flex-1 @container/term">
          <Terminal
            ref={termRef}
            agentId={agentId}
            rawInput
            mobileReturnMode="newline"
            mobileReturnBytes={MOBILE_PROMPT_NEWLINE}
            imagePasteMode="bracketed-path"
            onDisplayControl={setDisplayState}
          />
        </div>
      ) : (
        <div className="grid flex-1 place-items-center text-xs text-muted-foreground">
          This agent was deleted — remove the pane.
        </div>
      )}
    </section>
  );
}
