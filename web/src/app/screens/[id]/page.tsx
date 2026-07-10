"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  Columns3,
  ExternalLink,
  Grid2x2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Rows3,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { type Agent, ApiError, agents, type ScreenLayout, screens } from "@/lib/api";
import {
  AGENT_DRAG_MIME,
  dragHasAgent,
  dragIsPane,
  PANE_SRC_MIME,
  setAgentDragData,
  useAgentDrop,
} from "@/lib/dnd";
import {
  buildEven,
  buildGrid,
  buildMainStack,
  collectAgentIds,
  countPanes,
  insertAtEdge,
  type LayoutNode,
  movePane,
  removePane,
  type Side,
  type SplitPath,
  setRatioAt,
} from "@/lib/layout";
import { cn } from "@/lib/utils";
import type { DisplayControlState } from "@/lib/ws";

const MOBILE_PROMPT_NEWLINE = "\x1b[200~\n\x1b[201~";
const MAX_PANES_PER_TAB = 8;
const WIDE_CONTAINER_PX = 672;

export default function ScreenDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  return (
    <AuthGate>
      <AppShell hideMobileNav mainClassName="overflow-hidden">
        {/* Keying on the screen id resets all editor state on navigation. */}
        {id ? <ScreenView key={id} id={id} /> : null}
      </AppShell>
    </AuthGate>
  );
}

function ScreenView({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();

  const [layout, setLayout] = useState<ScreenLayout | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["screen", id],
    queryFn: () => screens.get(id),
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

  // Seed the editable layout once per screen; PATCH responses stay canonical.
  useEffect(() => {
    if (q.data && layout === null) {
      setLayout(q.data.layout.tabs.length ? q.data.layout : { tabs: [{ name: null, root: null }] });
    }
  }, [q.data, layout]);

  const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : String(err));

  const saveM = useMutation({
    mutationFn: (next: ScreenLayout) => screens.update(id, { layout: next }),
    onSuccess: (saved) => {
      setError(null);
      qc.setQueryData(["screen", id], saved);
      qc.invalidateQueries({ queryKey: ["screens"] });
    },
    onError,
  });
  const renameM = useMutation({
    mutationFn: (name: string) => screens.update(id, { name }),
    onSuccess: (saved) => {
      setError(null);
      setEditingName(false);
      qc.setQueryData(["screen", id], saved);
      qc.invalidateQueries({ queryKey: ["screens"] });
    },
    onError,
  });
  const deleteM = useMutation({
    mutationFn: () => screens.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["screens"] });
      router.push("/screens");
    },
    onError,
  });

  const commit = (next: ScreenLayout) => {
    setLayout(next);
    saveM.mutate(next);
  };

  const screen = q.data;
  const tabs = layout?.tabs ?? [];
  const tabIndex = Math.min(activeTab, Math.max(0, tabs.length - 1));
  const tab = tabs[tabIndex];
  const root = tab?.root ?? null;
  const tabAgentIds = useMemo(() => collectAgentIds(root), [root]);

  // Zoom is per-tab and ephemeral; clear it when the pane leaves the tab.
  useEffect(() => {
    if (zoomedId && !tabAgentIds.includes(zoomedId)) setZoomedId(null);
  }, [tabAgentIds, zoomedId]);

  const submitRename = () => {
    const next = draftName.trim();
    if (!screen || !next || next === screen.name) {
      setEditingName(false);
      return;
    }
    renameM.mutate(next);
  };

  const setTabRoot = (index: number, nextRoot: LayoutNode | null) => {
    if (!layout) return;
    commit({
      tabs: layout.tabs.map((t, i) => (i === index ? { ...t, root: nextRoot } : t)),
    });
  };

  /** Insert or move `agentId` relative to `targetId` (null = tab root edge). */
  const placeAgent = (
    index: number,
    agentId: string,
    targetId: string | null,
    side: Side | "center",
    sourceTab: number | null,
  ) => {
    if (!layout) return;
    const targetRoot = layout.tabs[index]?.root ?? null;
    const inTab = collectAgentIds(targetRoot).includes(agentId);

    if (inTab) {
      if (targetId === null || targetId === agentId) return;
      setTabRoot(index, movePane(targetRoot, agentId, targetId, side));
      return;
    }
    if (side === "center") return; // swap only applies to panes already in the tab
    if (countPanes(targetRoot) >= MAX_PANES_PER_TAB) {
      setError(`A tab holds at most ${MAX_PANES_PER_TAB} panes — remove one first.`);
      return;
    }
    setError(null);

    // Cross-tab move: pull the pane out of its source tab in the same commit.
    if (sourceTab !== null && sourceTab !== index && layout.tabs[sourceTab]) {
      commit({
        tabs: layout.tabs.map((t, i) => {
          if (i === sourceTab) return { ...t, root: removePane(t.root ?? null, agentId) };
          if (i === index)
            return { ...t, root: insertAtEdge(t.root ?? null, targetId, side, agentId) };
          return t;
        }),
      });
      return;
    }
    setTabRoot(index, insertAtEdge(targetRoot, targetId, side, agentId));
  };

  const arrange = (build: (ids: string[]) => LayoutNode | null) => {
    setTabRoot(tabIndex, build(tabAgentIds));
  };

  const addTab = () => {
    if (!layout || layout.tabs.length >= 8) return;
    commit({ tabs: [...layout.tabs, { name: null, root: null }] });
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

  const candidates = (agentsQ.data ?? []).filter(
    (agent) => !tabAgentIds.includes(agent.id) && agent.archived_at === null,
  );

  return (
    <div className="flex h-vv flex-col bg-background pad-safe-top">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-2 pad-safe-x sm:px-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="All screens"
        >
          <Link href="/screens">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>

        {editingName ? (
          <Input
            aria-label="Screen name"
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
            title="Rename screen"
            onClick={() => {
              if (!screen) return;
              setDraftName(screen.name);
              setEditingName(true);
            }}
          >
            {screen?.name ?? "…"}
          </button>
        )}

        {/* Tab strip */}
        <div
          role="tablist"
          aria-label="Screen tabs"
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
                onDropAgent={(agentId, sourceTab) =>
                  placeAgent(i, agentId, null, "right", sourceTab)
                }
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
                    {candidates.length > 0 && tabAgentIds.length < MAX_PANES_PER_TAB && (
                      <AddAgentItems
                        candidates={candidates}
                        onAdd={(agentId) => placeAgent(i, agentId, null, "right", null)}
                      />
                    )}
                    {tabAgentIds.length > 1 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Arrange</DropdownMenuLabel>
                        <DropdownMenuItem onSelect={() => arrange((ids) => buildEven(ids, "row"))}>
                          <Columns3 className="size-4" aria-hidden />
                          Even columns
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => arrange((ids) => buildEven(ids, "column"))}
                        >
                          <Rows3 className="size-4" aria-hidden />
                          Even rows
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => arrange(buildMainStack)}>
                          <PanelLeft className="size-4" aria-hidden />
                          Main + stack
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => arrange(buildGrid)}>
                          <Grid2x2 className="size-4" aria-hidden />
                          Grid
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuSeparator />
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
              aria-label="Screen actions"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        >
          <DropdownMenuItem
            onSelect={() => {
              if (!screen) return;
              setDraftName(screen.name);
              setEditingName(true);
            }}
          >
            <Pencil className="size-4" aria-hidden />
            Rename screen
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
              if (screen && confirm(`Delete screen ${screen.name}?`)) deleteM.mutate();
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            Delete screen
          </DropdownMenuItem>
        </DropdownMenu>
      </header>

      {(error || q.error) && (
        <p className="px-4 py-2 text-sm text-destructive" role="alert">
          {error ?? `Failed to load screen: ${String(q.error)}`}
        </p>
      )}

      {tab && (
        <PaneArea
          key={`${id}-${tabIndex}`}
          root={root}
          agentsById={agentsById}
          candidates={candidates}
          tabIndex={tabIndex}
          zoomedId={zoomedId}
          focusedId={focusedId}
          paneCount={tabAgentIds.length}
          onFocusPane={setFocusedId}
          onToggleZoom={(agentId) => setZoomedId((z) => (z === agentId ? null : agentId))}
          onRootChange={(next) => setTabRoot(tabIndex, next)}
          onPlaceAgent={(agentId, targetId, side, sourceTab) =>
            placeAgent(tabIndex, agentId, targetId, side, sourceTab)
          }
        />
      )}
    </div>
  );
}

function AddAgentItems({
  candidates,
  onAdd,
}: {
  candidates: Agent[];
  onAdd: (agentId: string) => void;
}) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Add agent</DropdownMenuLabel>
      {candidates.slice(0, 8).map((agent) => (
        <DropdownMenuItem key={agent.id} onSelect={() => onAdd(agent.id)}>
          <AgentKindIcon agent={agent} className="size-5 rounded-md" iconClassName="size-3" />
          <span className="min-w-0 flex-1 truncate">{agentTitle(agent)}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

function TabPill({
  active,
  onDropAgent,
  children,
}: {
  active: boolean;
  onDropAgent: (agentId: string, sourceTab: number | null) => void;
  children: ReactNode;
}) {
  const { active: dropActive, dropProps } = useAgentDrop((agentId, _title, sourceTab) =>
    onDropAgent(agentId, sourceTab),
  );
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

// ---------------------------------------------------------------------------
// Pane area: split-tree renderer with dividers, drop zones, zoom, and focus.
// ---------------------------------------------------------------------------

type PaneAreaProps = {
  root: LayoutNode | null;
  agentsById: Map<string, Agent>;
  candidates: Agent[];
  tabIndex: number;
  zoomedId: string | null;
  focusedId: string | null;
  paneCount: number;
  onFocusPane: (agentId: string) => void;
  onToggleZoom: (agentId: string) => void;
  onRootChange: (root: LayoutNode | null) => void;
  onPlaceAgent: (
    agentId: string,
    targetId: string | null,
    side: Side | "center",
    sourceTab: number | null,
  ) => void;
};

function useIsWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setWide(width >= WIDE_CONTAINER_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return wide;
}

function PaneArea(props: PaneAreaProps) {
  const { root, candidates, onPlaceAgent, onRootChange } = props;
  const areaRef = useRef<HTMLDivElement>(null);
  const wide = useIsWide(areaRef);

  // Empty tab: whole area is one drop target plus a picker tile.
  const { active: emptyDropActive, dropProps: emptyDropProps } = useAgentDrop(
    (agentId, _title, sourceTab) => onPlaceAgent(agentId, null, "right", sourceTab),
  );

  if (!root) {
    return (
      <div
        ref={areaRef}
        {...emptyDropProps}
        className={cn(
          "relative grid min-h-0 flex-1 place-items-center bg-background",
          emptyDropActive && "bg-accent/20",
        )}
      >
        {emptyDropActive && (
          <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-ring">
            <span className="rounded-lg border border-border bg-popover px-3 py-1.5 text-sm shadow-lg">
              Drop to add the first pane
            </span>
          </div>
        )}
        <DropdownMenu
          side="bottom"
          align="start"
          menuClassName="w-72 max-h-80 overflow-y-auto"
          renderTrigger={(triggerProps) => (
            <button
              {...triggerProps}
              type="button"
              className="flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
            >
              <Plus className="size-4" aria-hidden />
              Add agent
            </button>
          )}
        >
          {candidates.length === 0 && <DropdownMenuLabel>No agents available</DropdownMenuLabel>}
          {candidates.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() => onRootChange({ type: "pane", agent_id: agent.id })}
            >
              <AgentKindIcon agent={agent} className="size-5 rounded-md" iconClassName="size-3" />
              <span className="min-w-0 flex-1 truncate">{agentTitle(agent)}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {agent.host_name ?? ""}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
      </div>
    );
  }

  if (!wide) {
    // Narrow containers stack panes in tree order; structure editing is a
    // desktop-width affair.
    const ids = collectAgentIds(root);
    return (
      <div ref={areaRef} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto bg-border">
        {ids.map((agentId) => (
          <ScreenPane key={agentId} agentId={agentId} stacked {...props} />
        ))}
      </div>
    );
  }

  return (
    <div ref={areaRef} className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      <NodeView node={root} path={[]} {...props} />
    </div>
  );
}

function NodeView({ node, path, ...props }: { node: LayoutNode; path: SplitPath } & PaneAreaProps) {
  if (node.type === "pane") {
    return <ScreenPane agentId={node.agent_id} {...props} />;
  }

  const zoomed = props.zoomedId;
  const zoomInA = zoomed ? collectAgentIds(node.a).includes(zoomed) : false;
  const zoomInB = zoomed ? collectAgentIds(node.b).includes(zoomed) : false;

  if (zoomed && (zoomInA || zoomInB)) {
    // The zoomed side fills this split; the sibling stays mounted (hidden) so
    // its terminal sockets and scrollback survive the zoom round-trip.
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className={cn(zoomInA ? "flex min-h-0 min-w-0 flex-1" : "hidden")}>
          <NodeView node={node.a} path={[...path, "a"]} {...props} />
        </div>
        <div className={cn(zoomInB ? "flex min-h-0 min-w-0 flex-1" : "hidden")}>
          <NodeView node={node.b} path={[...path, "b"]} {...props} />
        </div>
      </div>
    );
  }

  return <SplitView node={node} path={path} {...props} />;
}

function SplitView({
  node,
  path,
  ...props
}: {
  node: Extract<LayoutNode, { type: "split" }>;
  path: SplitPath;
} & PaneAreaProps) {
  const row = node.direction === "row";
  const containerRef = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);

  const startResize = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const size = row ? rect.width : rect.height;
    const start = row ? rect.left : rect.top;
    let latest = node.ratio;

    const onMove = (moveEvent: PointerEvent) => {
      const pos = row ? moveEvent.clientX : moveEvent.clientY;
      latest = Math.min(0.85, Math.max(0.15, (pos - start) / Math.max(1, size)));
      // Live preview via styles only; React state commits on release so the
      // terminals refit (debounced in Terminal) without re-render per move.
      if (aRef.current) aRef.current.style.flexGrow = String(latest);
      if (bRef.current) bRef.current.style.flexGrow = String(1 - latest);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      props.onRootChange(setRatioAt(props.root, path, latest));
    };
    document.body.style.cursor = row ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  };

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}
    >
      <div
        ref={aRef}
        className="flex min-h-0 min-w-0"
        style={{ flexGrow: node.ratio, flexShrink: 1, flexBasis: 0 }}
      >
        <NodeView node={node.a} path={[...path, "a"]} {...props} />
      </div>
      <button
        type="button"
        aria-label="Resize panes"
        title="Drag to resize · double-click to equalize"
        onPointerDown={startResize}
        onDoubleClick={() => props.onRootChange(setRatioAt(props.root, path, 0.5))}
        className={cn(
          "relative z-10 shrink-0 border-0 bg-border/60 transition-colors hover:bg-ring/70 active:bg-ring",
          row ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
        )}
      >
        {/* Generous invisible hit area around the 4px visual line. */}
        <span
          aria-hidden
          className={cn("absolute", row ? "-inset-x-1 inset-y-0" : "inset-x-0 -inset-y-1")}
        />
      </button>
      <div
        ref={bRef}
        className="flex min-h-0 min-w-0"
        style={{ flexGrow: 1 - node.ratio, flexShrink: 1, flexBasis: 0 }}
      >
        <NodeView node={node.b} path={[...path, "b"]} {...props} />
      </div>
    </div>
  );
}

type DropZone = Side | "center";

function zoneFromEvent(event: ReactDragEvent<HTMLElement>, allowCenter: boolean): DropZone {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / Math.max(1, rect.width);
  const y = (event.clientY - rect.top) / Math.max(1, rect.height);
  const edges: Array<[number, DropZone]> = [
    [x, "left"],
    [1 - x, "right"],
    [y, "top"],
    [1 - y, "bottom"],
  ];
  edges.sort((p, q) => p[0] - q[0]);
  const [distance, side] = edges[0];
  if (allowCenter && distance > 0.3) return "center";
  return side;
}

const ZONE_CLASS: Record<DropZone, string> = {
  left: "inset-y-1 left-1 w-[calc(50%-0.5rem)]",
  right: "inset-y-1 right-1 w-[calc(50%-0.5rem)]",
  top: "inset-x-1 top-1 h-[calc(50%-0.5rem)]",
  bottom: "inset-x-1 bottom-1 h-[calc(50%-0.5rem)]",
  center: "inset-6",
};

function ScreenPane({
  agentId,
  stacked = false,
  ...props
}: { agentId: string; stacked?: boolean } & PaneAreaProps) {
  const {
    agentsById,
    tabIndex,
    zoomedId,
    focusedId,
    paneCount,
    onFocusPane,
    onToggleZoom,
    onPlaceAgent,
    onRootChange,
    root,
  } = props;
  const agent = agentsById.get(agentId);
  const termRef = useRef<TerminalHandle>(null);
  const [displayState, setDisplayState] = useState<DisplayControlState | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);
  const depth = useRef(0);
  const zoomed = zoomedId === agentId;

  const onDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasAgent(event.dataTransfer)) return;
    event.preventDefault();
    depth.current += 1;
  };
  const onDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasAgent(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = dragIsPane(event.dataTransfer) ? "move" : "copy";
    setZone(zoneFromEvent(event, dragIsPane(event.dataTransfer)));
  };
  const onDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasAgent(event.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setZone(null);
  };
  const onDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasAgent(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current = 0;
    const dropZone = zoneFromEvent(event, dragIsPane(event.dataTransfer));
    setZone(null);
    const droppedId = event.dataTransfer.getData(AGENT_DRAG_MIME);
    const sourceRaw = event.dataTransfer.getData(PANE_SRC_MIME);
    const sourceTab = sourceRaw === "" ? Number.NaN : Number.parseInt(sourceRaw, 10);
    if (!droppedId || droppedId === agentId) return;
    onPlaceAgent(droppedId, agentId, dropZone, Number.isInteger(sourceTab) ? sourceTab : null);
  };

  return (
    <section
      aria-label={agent ? agentTitle(agent) : "Missing agent"}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onFocusCapture={() => onFocusPane(agentId)}
      className={cn(
        "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background",
        stacked ? "min-h-[50dvh] flex-none" : "min-h-0",
        focusedId === agentId && paneCount > 1 && "ring-1 ring-inset ring-ring/40",
      )}
    >
      {/* Drop-zone highlight */}
      {zone && (
        <div
          className={cn(
            "pointer-events-none absolute z-30 rounded-lg border-2 border-ring bg-ring/15",
            ZONE_CLASS[zone],
          )}
        />
      )}

      {/* Mini pane header — draggable to rearrange or move across tabs.
          Double-click mirrors the zoom button; every action has a button
          equivalent, so the handler is a pointer convenience only. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle with button equivalents */}
      <div
        draggable={Boolean(agent)}
        onDragStart={(event) => {
          if (!agent) return;
          setAgentDragData(event.dataTransfer, agentId, agentTitle(agent), tabIndex);
        }}
        onDoubleClick={() => !stacked && onToggleZoom(agentId)}
        className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-border/70 bg-card/60 px-2 active:cursor-grabbing"
      >
        {agent ? (
          <>
            <span className="relative shrink-0">
              <AgentKindIcon agent={agent} className="size-5 rounded-md" iconClassName="size-3" />
              <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5 size-1.5" />
            </span>
            <span className="min-w-0 truncate text-xs font-medium">{agentTitle(agent)}</span>
            <span className="hidden min-w-0 truncate text-[10px] text-muted-foreground lg:inline">
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
            {!stacked && (
              <button
                type="button"
                aria-label={zoomed ? "Restore pane" : "Zoom pane"}
                title={zoomed ? "Restore" : "Zoom (fill the tab)"}
                onClick={() => onToggleZoom(agentId)}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                {zoomed ? (
                  <Minimize2 className="size-3" aria-hidden />
                ) : (
                  <Maximize2 className="size-3" aria-hidden />
                )}
              </button>
            )}
            <Link
              href={`/agents/${agentId}`}
              aria-label={`Open ${agentTitle(agent)} full screen`}
              title="Open full page"
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <ExternalLink className="size-3" aria-hidden />
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
          title="Remove from screen"
          onClick={() => onRootChange(removePane(root, agentId))}
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
