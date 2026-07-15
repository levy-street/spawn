"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Columns3,
  FolderOpen,
  Grid2x2,
  Home,
  Maximize2,
  Minimize2,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Rows3,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AgentSurfaceHeader } from "@/components/agents/AgentSurfaceHeader";
import { AuthGate } from "@/components/auth/AuthGate";
import { AgentFilesAside } from "@/components/files/AgentFilesAside";
import { AppShell } from "@/components/nav/AppShell";
import { useLiveTerminal } from "@/components/terminal/LiveTerminalProvider";
import { ModifierBar } from "@/components/terminal/ModifierBar";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { agentNeedsAttention, agentTitle } from "@/lib/agents";
import { type Agent, ApiError, agents, type Screen, screens } from "@/lib/api";
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
import { defaultScreenName } from "@/lib/screens";
import { cn } from "@/lib/utils";

const MAX_PANES_PER_SCREEN = 8;
const WIDE_CONTAINER_PX = 672;

export default function ScreenDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  return (
    <AuthGate>
      <AppShell hideMobileNav mainClassName="overflow-hidden">
        {/* Keying on the screen id resets all editor state on navigation. */}
        <Suspense fallback={null}>{id ? <ScreenView key={id} id={id} /> : null}</Suspense>
      </AppShell>
    </AuthGate>
  );
}

function ScreenView({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();

  const [root, setRoot] = useState<LayoutNode | null | undefined>(undefined);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  // Live terminal handles per pane so the shared mobile ModifierBar can
  // target whichever pane holds focus.
  const paneHandles = useRef(new Map<string, TerminalHandle | null>());

  const q = useQuery({
    queryKey: ["screen", id],
    queryFn: () => screens.get(id),
    // Short and refetch-on-focus so a screen deleted elsewhere (or emptied)
    // is noticed promptly instead of lingering as a stale ghost tab.
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  // A screen that no longer exists must not strand the user on a dead tab
  // showing cached panes — bounce to the switchboard, which forwards to a
  // live screen or the empty state.
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 404) {
      qc.invalidateQueries({ queryKey: ["screens"] });
      router.replace("/screens");
    }
  }, [q.error, qc, router]);
  const screensQ = useQuery({ queryKey: ["screens"], queryFn: screens.list });
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
    if (q.data && root === undefined) setRoot(q.data.layout.root ?? null);
  }, [q.data, root]);

  // Remember the last screen for the /screens switchboard.
  useEffect(() => {
    window.localStorage.setItem("spawn.screens.last", id);
  }, [id]);

  const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : String(err));

  const saveM = useMutation({
    mutationFn: (next: LayoutNode | null) => screens.update(id, { layout: { root: next } }),
    onSuccess: (saved) => {
      setError(null);
      qc.setQueryData(["screen", id], saved);
      qc.invalidateQueries({ queryKey: ["screens"] });
    },
    onError: (err) => {
      // An emptied ephemeral screen self-destructs server-side (410); follow
      // it to whatever screen remains instead of showing an error.
      if (err instanceof ApiError && err.status === 410) {
        qc.invalidateQueries({ queryKey: ["screens"] });
        const remaining = (screensQ.data ?? []).filter((item) => item.id !== id);
        router.push(remaining.length > 0 ? `/screens/${remaining[0].id}` : "/screens");
        return;
      }
      onError(err);
    },
  });
  const otherScreenM = useMutation({
    mutationFn: ({ screenId, nextRoot }: { screenId: string; nextRoot: LayoutNode | null }) =>
      screens.update(screenId, { layout: { root: nextRoot } }),
    onSuccess: () => {
      setError(null);
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
  const keepM = useMutation({
    mutationFn: () => screens.update(id, { ephemeral: false }),
    onSuccess: (saved) => {
      setError(null);
      qc.setQueryData(["screen", id], saved);
      qc.invalidateQueries({ queryKey: ["screens"] });
    },
    onError,
  });
  const pinM = useMutation({
    mutationFn: (pinned: boolean) => screens.update(id, { pinned }),
    onSuccess: (saved) => {
      setError(null);
      qc.setQueryData(["screen", id], saved);
      qc.invalidateQueries({ queryKey: ["screens"] });
    },
    onError,
  });
  const createM = useMutation({
    mutationFn: () =>
      screens.create({ name: defaultScreenName(screensQ.data ?? []), layout: { root: null } }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["screens"] });
      router.push(`/screens/${created.id}`);
    },
    onError,
  });
  const deleteM = useMutation({
    mutationFn: () => screens.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["screens"] });
      const remaining = (screensQ.data ?? []).filter((screen) => screen.id !== id);
      router.push(remaining.length > 0 ? `/screens/${remaining[0].id}` : "/screens");
    },
    onError,
  });

  const commit = (next: LayoutNode | null) => {
    setRoot(next);
    saveM.mutate(next);
  };

  const screen = q.data;
  const currentRoot = root === undefined ? null : root;
  const screenAgentIds = useMemo(() => collectAgentIds(currentRoot), [currentRoot]);

  // Zoom is ephemeral; clear it when the pane leaves the screen.
  useEffect(() => {
    if (zoomedId && !screenAgentIds.includes(zoomedId)) setZoomedId(null);
  }, [screenAgentIds, zoomedId]);

  // Keep a valid focus target so the mobile modifier bar always has a pane.
  useEffect(() => {
    if (screenAgentIds.length === 0) {
      if (focusedId !== null) setFocusedId(null);
      return;
    }
    if (!focusedId || !screenAgentIds.includes(focusedId)) {
      setFocusedId(screenAgentIds[0]);
    }
  }, [screenAgentIds, focusedId]);

  // Deep links (?focus=<agentId>) land with that pane focused — used when
  // arriving from another page.
  const focusParam = useSearchParams()?.get("focus") ?? null;
  const focusParamApplied = useRef(false);
  const focusPane = useCallback((agentId: string) => {
    setFocusedId(agentId);
    requestAnimationFrame(() => paneHandles.current.get(agentId)?.focus());
  }, []);
  useEffect(() => {
    if (focusParamApplied.current || !focusParam) return;
    if (!screenAgentIds.includes(focusParam)) return;
    focusParamApplied.current = true;
    focusPane(focusParam);
  }, [focusParam, screenAgentIds, focusPane]);

  // Keyboard: Alt+arrows cycle pane focus, Alt+Z zooms, Alt+1..9 switches
  // screens. Capture phase so the focused terminal doesn't swallow them.
  const keyboardStateRef = useRef({ screenAgentIds, focusedId, zoomedId });
  keyboardStateRef.current = { screenAgentIds, focusedId, zoomedId };
  const allScreensRef = useRef<Screen[]>([]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const { screenAgentIds: ids, focusedId: focused } = keyboardStateRef.current;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit) {
        const target = allScreensRef.current[Number(digit) - 1];
        if (target && target.id !== id) {
          event.preventDefault();
          event.stopPropagation();
          router.push(`/screens/${target.id}`);
        }
        return;
      }
      if (ids.length === 0) return;
      if (event.code === "KeyZ") {
        if (focused) {
          event.preventDefault();
          event.stopPropagation();
          setZoomedId((z) => (z === focused ? null : focused));
        }
        return;
      }
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !backward) return;
      event.preventDefault();
      event.stopPropagation();
      const index = focused ? ids.indexOf(focused) : 0;
      const next = ids[(index + (forward ? 1 : ids.length - 1)) % ids.length];
      setFocusedId(next);
      requestAnimationFrame(() => paneHandles.current.get(next)?.focus());
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [id, router]);

  const submitRename = () => {
    const next = draftName.trim();
    if (!screen || !next || next === screen.name) {
      setEditingName(false);
      return;
    }
    renameM.mutate(next);
  };

  /** Insert or move `agentId` relative to `targetId` within this screen. */
  const placeAgent = (
    agentId: string,
    targetId: string | null,
    side: Side | "center",
    sourceScreen: string | null,
  ) => {
    const inScreen = screenAgentIds.includes(agentId);

    if (inScreen) {
      if (targetId === null || targetId === agentId) return;
      commit(movePane(currentRoot, agentId, targetId, side));
      return;
    }
    if (side === "center") return; // swap only applies to panes already here
    if (countPanes(currentRoot) >= MAX_PANES_PER_SCREEN) {
      setError(`A screen holds at most ${MAX_PANES_PER_SCREEN} panes — remove one first.`);
      return;
    }
    setError(null);
    commit(insertAtEdge(currentRoot, targetId, side, agentId));

    // Pane dragged over from another screen: pull it out of the source too.
    if (sourceScreen && sourceScreen !== id) {
      const source = (screensQ.data ?? []).find((item) => item.id === sourceScreen);
      if (source) {
        otherScreenM.mutate({
          screenId: sourceScreen,
          nextRoot: removePane(source.layout.root ?? null, agentId),
        });
      }
    }
  };

  /** Drop on another screen's tab pill: file the agent into that screen. */
  const sendToScreen = (target: Screen, agentId: string, sourceScreen: string | null) => {
    if (target.id === id) {
      placeAgent(agentId, null, "right", sourceScreen);
      return;
    }
    const targetRoot = target.layout.root ?? null;
    if (collectAgentIds(targetRoot).includes(agentId)) return;
    if (countPanes(targetRoot) >= MAX_PANES_PER_SCREEN) {
      setError(`${target.name} already holds ${MAX_PANES_PER_SCREEN} panes.`);
      return;
    }
    setError(null);
    otherScreenM.mutate({
      screenId: target.id,
      nextRoot: insertAtEdge(targetRoot, null, "right", agentId),
    });
    if (sourceScreen === id && screenAgentIds.includes(agentId)) {
      commit(removePane(currentRoot, agentId));
    }
  };

  const arrange = (build: (ids: string[]) => LayoutNode | null) => {
    commit(build(screenAgentIds));
  };

  const candidates = (agentsQ.data ?? []).filter(
    (agent) => !screenAgentIds.includes(agent.id) && agent.archived_at === null,
  );
  const allScreens = screensQ.data ?? [];
  allScreensRef.current = allScreens;
  const attentionCount = (item: Screen) =>
    collectAgentIds(item.layout.root ?? null).filter((agentId) => {
      const agent = agentsById.get(agentId);
      return agent && agentNeedsAttention(agent) !== null;
    }).length;

  const TAB_LIMIT = 5;
  const { visibleTabs, overflowTabs } = useMemo(() => {
    if (allScreens.length <= TAB_LIMIT) {
      return { visibleTabs: allScreens, overflowTabs: [] as Screen[] };
    }
    const active = allScreens.find((item) => item.id === id);
    const rest = allScreens.filter((item) => item.id !== id);
    const visible = (active ? [active, ...rest] : rest).slice(0, TAB_LIMIT);
    const ids = new Set(visible.map((item) => item.id));
    return { visibleTabs: visible, overflowTabs: allScreens.filter((item) => !ids.has(item.id)) };
  }, [allScreens, id]);

  const panelAgent =
    (focusedId ? agentsById.get(focusedId) : null) ??
    (screenAgentIds.length > 0 ? agentsById.get(screenAgentIds[0]) : null) ??
    null;

  return (
    <div className="flex h-vv flex-col bg-background pad-safe-top">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-2 pad-safe-x sm:px-3">
        {/* Mobile escape hatch: the shell chrome is hidden on this page. */}
        <Link
          href="/"
          aria-label="Home"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground @md/shell:hidden"
        >
          <Home className="size-4" aria-hidden />
        </Link>
        {/* Screens as tabs. Past a handful, keep the active one plus the
            most recent visible and fold the rest into an overflow menu so the
            strip never crowds out the pane area. */}
        <div
          role="tablist"
          aria-label="Screens"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1"
        >
          {visibleTabs.map((item) => {
            const active = item.id === id;
            return (
              <ScreenTabPill
                key={item.id}
                active={active}
                onDropAgent={(agentId, sourceScreen) => sendToScreen(item, agentId, sourceScreen)}
              >
                {active && editingName ? (
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
                    className="mx-1 h-6 w-36 text-xs"
                    disabled={renameM.isPending}
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={cn("max-w-44 truncate py-1.5 pl-3", active ? "pr-1.5" : "pr-3")}
                    onClick={() => {
                      if (!active) router.push(`/screens/${item.id}`);
                    }}
                    onDoubleClick={() => {
                      if (!active || !screen) return;
                      setDraftName(screen.name);
                      setEditingName(true);
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      <span className={cn(item.ephemeral && "italic opacity-80")}>{item.name}</span>
                      {item.ephemeral && (
                        <span
                          title="Temporary — dissolves when emptied. Rename or add a pane to keep it."
                          className="rounded bg-muted px-1 text-[8px] uppercase tracking-wide text-muted-foreground"
                        >
                          temp
                        </span>
                      )}
                      {attentionCount(item) > 0 && (
                        <span className="rounded-full bg-amber-400/20 px-1.5 text-[9px] font-semibold leading-4 text-amber-500">
                          {attentionCount(item)}
                        </span>
                      )}
                    </span>
                  </button>
                )}
                {active && !editingName && (
                  <DropdownMenu
                    align="start"
                    renderTrigger={(props) => (
                      <button
                        {...props}
                        type="button"
                        aria-label={`${item.name} options`}
                        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                      >
                        <ChevronDown className="size-3" aria-hidden />
                      </button>
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
                    <DropdownMenuItem onSelect={() => pinM.mutate(!screen?.pinned_at)}>
                      {screen?.pinned_at ? (
                        <PinOff className="size-4" aria-hidden />
                      ) : (
                        <Pin className="size-4" aria-hidden />
                      )}
                      {screen?.pinned_at ? "Unpin screen" : "Pin screen"}
                    </DropdownMenuItem>
                    {screen?.ephemeral && !screen?.pinned_at && (
                      <DropdownMenuItem onSelect={() => keepM.mutate()}>
                        <Pin className="size-4" aria-hidden />
                        Keep screen
                      </DropdownMenuItem>
                    )}
                    {candidates.length > 0 && screenAgentIds.length < MAX_PANES_PER_SCREEN && (
                      <AddAgentItems
                        candidates={candidates}
                        onAdd={(agentId) => placeAgent(agentId, null, "right", null)}
                        screenId={id}
                      />
                    )}
                    {screenAgentIds.length > 1 && (
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
                      disabled={deleteM.isPending}
                      onSelect={() => {
                        // `item` is the tab's own screen (always present),
                        // unlike `screen` which is undefined once the fetch
                        // 404s — so delete works even on a stale tab.
                        if (confirm(`Delete screen ${item.name}?`)) deleteM.mutate();
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      Delete screen
                    </DropdownMenuItem>
                  </DropdownMenu>
                )}
              </ScreenTabPill>
            );
          })}
          <button
            type="button"
            aria-label="Add screen"
            title="Add screen"
            disabled={createM.isPending}
            onClick={() => createM.mutate()}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Plus className="size-4" aria-hidden />
          </button>
          {overflowTabs.length > 0 && (
            <DropdownMenu
              align="end"
              menuClassName="max-h-80 w-56 overflow-y-auto"
              renderTrigger={(props) => (
                <button
                  {...props}
                  type="button"
                  aria-label={`${overflowTabs.length} more screens`}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  {overflowTabs.length} more
                  <ChevronDown className="size-3" aria-hidden />
                </button>
              )}
            >
              {overflowTabs.map((item) => (
                <DropdownMenuItem key={item.id} onSelect={() => router.push(`/screens/${item.id}`)}>
                  <span className={cn("min-w-0 flex-1 truncate", item.ephemeral && "italic")}>
                    {item.name}
                  </span>
                  {attentionCount(item) > 0 && (
                    <span className="shrink-0 rounded-full bg-amber-400/20 px-1.5 text-[9px] font-semibold text-amber-500">
                      {attentionCount(item)}
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenu>
          )}
        </div>

        <span
          className={cn(
            "hidden shrink-0 text-[11px] text-muted-foreground transition-opacity sm:inline",
            saveM.isPending || otherScreenM.isPending ? "opacity-100" : "opacity-0",
          )}
          aria-hidden={!(saveM.isPending || otherScreenM.isPending)}
        >
          Saving…
        </span>
        <button
          type="button"
          aria-label="Toggle files panel"
          aria-pressed={filesOpen}
          title="Files"
          disabled={!panelAgent}
          onClick={() => setFilesOpen((v) => !v)}
          className={cn(
            "hidden size-8 shrink-0 place-items-center rounded-lg transition-colors md:grid",
            filesOpen
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            !panelAgent && "opacity-40",
          )}
        >
          <FolderOpen className="size-4" aria-hidden />
        </button>
      </header>

      {(error || q.error) && (
        <p className="px-4 py-2 text-sm text-destructive" role="alert">
          {error ?? `Failed to load screen: ${String(q.error)}`}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <PaneArea
          root={currentRoot}
          agentsById={agentsById}
          candidates={candidates}
          screenId={id}
          zoomedId={zoomedId}
          focusedId={focusedId}
          paneCount={screenAgentIds.length}
          onFocusPane={setFocusedId}
          onToggleZoom={(agentId) => setZoomedId((z) => (z === agentId ? null : agentId))}
          onRootChange={commit}
          onPlaceAgent={placeAgent}
          registerPane={(agentId, handle) => {
            if (handle) paneHandles.current.set(agentId, handle);
            else paneHandles.current.delete(agentId);
          }}
          onPaneError={setError}
        />
        {filesOpen && panelAgent && <AgentFilesAside agent={panelAgent} />}
      </div>

      <ModifierBar
        className="hidden [@media(pointer:coarse)]:flex"
        onSend={(bytes) => {
          const handle = focusedId ? paneHandles.current.get(focusedId) : null;
          handle?.sendInput(bytes);
          requestAnimationFrame(() => handle?.focus());
        }}
        onPaste={(data) => {
          const handle = focusedId ? paneHandles.current.get(focusedId) : null;
          handle?.pasteDataTransfer(data);
        }}
        onPasteText={(text) => {
          const handle = focusedId ? paneHandles.current.get(focusedId) : null;
          handle?.pasteText(text);
        }}
        onPasteClick={() => {
          const handle = focusedId ? paneHandles.current.get(focusedId) : null;
          void handle?.pasteFromClipboard();
        }}
        onSubmit={() => {
          const handle = focusedId ? paneHandles.current.get(focusedId) : null;
          handle?.submit();
          requestAnimationFrame(() => handle?.focus());
        }}
      />
    </div>
  );
}

function AddAgentItems({
  candidates,
  onAdd,
  screenId,
}: {
  candidates: Agent[];
  onAdd: (agentId: string) => void;
  screenId: string;
}) {
  const router = useRouter();
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Add agent</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => router.push(`/agents/new?screen=${screenId}`)}>
        <Plus className="size-4" aria-hidden />
        New agent…
      </DropdownMenuItem>
      {candidates.slice(0, 8).map((agent) => (
        <DropdownMenuItem key={agent.id} onSelect={() => onAdd(agent.id)}>
          <AgentKindIcon agent={agent} className="size-5 rounded-md" iconClassName="size-3" />
          <span className="min-w-0 flex-1 truncate">{agentTitle(agent)}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

function ScreenTabPill({
  active,
  onDropAgent,
  children,
}: {
  active: boolean;
  onDropAgent: (agentId: string, sourceScreen: string | null) => void;
  children: ReactNode;
}) {
  const { active: dropActive, dropProps } = useAgentDrop((agentId, _title, sourceScreen) =>
    onDropAgent(agentId, sourceScreen),
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
  screenId: string;
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
    sourceScreen: string | null,
  ) => void;
  registerPane: (agentId: string, handle: TerminalHandle | null) => void;
  onPaneError: (message: string) => void;
};

/** A DOM slot a pane portals its content into, plus whether that slot is in
 *  the stacked (narrow) layout. */
type Slot = { el: HTMLElement; stacked: boolean };
type RegisterSlot = (agentId: string, el: HTMLElement | null, stacked: boolean) => void;

/** A positioned placeholder in the split tree / stack; the matching pane's
 *  terminal is portaled here. Keeping the terminal in a stable keyed layer
 *  (not in the reshaping tree) is what preserves its socket + WebRTC across
 *  pane moves — remounting on every layout change was dropping connections. */
function PaneSlot({
  agentId,
  stacked,
  registerSlot,
}: {
  agentId: string;
  stacked: boolean;
  registerSlot: RegisterSlot;
}) {
  // Stable ref: an inline `ref={el => ...}` is a fresh function each render,
  // so React would detach+reattach it every render (null→el) and the
  // registerSlot setState would loop. useCallback pins it so it fires only on
  // mount/unmount.
  const setRef = useCallback(
    (el: HTMLDivElement | null) => registerSlot(agentId, el, stacked),
    [agentId, stacked, registerSlot],
  );
  return (
    <div
      ref={setRef}
      className={stacked ? "flex min-h-[50dvh] w-full shrink-0" : "flex min-h-0 min-w-0 flex-1"}
    />
  );
}

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
  const { root, candidates, onPlaceAgent, onRootChange, screenId } = props;
  const router = useRouter();
  const areaRef = useRef<HTMLDivElement>(null);
  const wide = useIsWide(areaRef);
  const agentIds = useMemo(() => collectAgentIds(root), [root]);

  // Slot registry: pane content portals into these, keyed by agentId, so the
  // terminal instances persist even as the split tree reshapes on a move.
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const registerSlot = useCallback<RegisterSlot>((agentId, el, stacked) => {
    setSlots((prev) => {
      if (el === null) {
        if (!(agentId in prev)) return prev;
        const next = { ...prev };
        delete next[agentId];
        return next;
      }
      const cur = prev[agentId];
      if (cur && cur.el === el && cur.stacked === stacked) return prev;
      return { ...prev, [agentId]: { el, stacked } };
    });
  }, []);

  // Empty screen: whole area is one drop target plus a picker tile.
  const { active: emptyDropActive, dropProps: emptyDropProps } = useAgentDrop(
    (agentId, _title, sourceScreen) => onPlaceAgent(agentId, null, "right", sourceScreen),
  );

  if (!root) {
    return (
      <div
        ref={areaRef}
        {...emptyDropProps}
        className={cn(
          "relative grid min-h-0 min-w-0 flex-1 place-items-center bg-background",
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
          <DropdownMenuItem onSelect={() => router.push(`/agents/new?screen=${screenId}`)}>
            <Plus className="size-4" aria-hidden />
            New agent…
          </DropdownMenuItem>
          {candidates.length > 0 && <DropdownMenuLabel>Existing agents</DropdownMenuLabel>}
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

  return (
    <>
      {wide ? (
        <div
          ref={areaRef}
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
        >
          <NodeView node={root} path={[]} registerSlot={registerSlot} {...props} />
        </div>
      ) : (
        // Narrow containers stack panes in tree order; structure editing is a
        // desktop-width affair.
        <div
          ref={areaRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-px overflow-y-auto bg-border"
        >
          {agentIds.map((agentId) => (
            <PaneSlot key={agentId} agentId={agentId} stacked registerSlot={registerSlot} />
          ))}
        </div>
      )}
      {/* Keep-alive pane layer: one instance per agent, stable across moves,
          portaled into whichever slot the layout currently exposes. */}
      {agentIds.map((agentId) => (
        <ScreenPane key={agentId} agentId={agentId} slot={slots[agentId]} {...props} />
      ))}
    </>
  );
}

function NodeView({
  node,
  path,
  registerSlot,
  ...props
}: { node: LayoutNode; path: SplitPath; registerSlot: RegisterSlot } & PaneAreaProps) {
  if (node.type === "pane") {
    // The tree only positions a slot; the pane itself lives in the keep-alive
    // layer and portals here.
    return <PaneSlot agentId={node.agent_id} stacked={false} registerSlot={registerSlot} />;
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
          <NodeView node={node.a} path={[...path, "a"]} registerSlot={registerSlot} {...props} />
        </div>
        <div className={cn(zoomInB ? "flex min-h-0 min-w-0 flex-1" : "hidden")}>
          <NodeView node={node.b} path={[...path, "b"]} registerSlot={registerSlot} {...props} />
        </div>
      </div>
    );
  }

  return <SplitView node={node} path={path} registerSlot={registerSlot} {...props} />;
}

function SplitView({
  node,
  path,
  registerSlot,
  ...props
}: {
  node: Extract<LayoutNode, { type: "split" }>;
  path: SplitPath;
  registerSlot: RegisterSlot;
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
        <NodeView node={node.a} path={[...path, "a"]} registerSlot={registerSlot} {...props} />
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
        <NodeView node={node.b} path={[...path, "b"]} registerSlot={registerSlot} {...props} />
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
  slot,
  ...props
}: { agentId: string; slot: Slot | undefined } & PaneAreaProps) {
  const stacked = slot?.stacked ?? false;
  const {
    agentsById,
    screenId,
    zoomedId,
    focusedId,
    paneCount,
    onFocusPane,
    onToggleZoom,
    onPlaceAgent,
    onRootChange,
    onPaneError,
    root,
  } = props;
  const agent = agentsById.get(agentId);
  // Terminal comes from the shared warm pool — same instance as the agent
  // page, so switching between them (or moving the pane) never reconnects.
  const { attach, getHandle, connInfo, displayState } = useLiveTerminal(agentId);
  const displayOwner = displayState?.owner ?? null;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { registerPane } = props;
  useEffect(() => {
    registerPane(agentId, getHandle());
    return () => registerPane(agentId, null);
  });
  // Move the stable host into whatever slot the layout currently exposes.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host && slot?.el && host.parentElement !== slot.el) slot.el.appendChild(host);
  }, [slot]);
  const [zone, setZone] = useState<DropZone | null>(null);
  const depth = useRef(0);
  const zoomed = zoomedId === agentId;
  const attention = agent ? agentNeedsAttention(agent) : null;
  const restartM = useMutation({
    mutationFn: () => {
      const size = getHandle()?.getSize();
      return agents.restart(agentId, size ? { ...size, create_cwd: true } : undefined);
    },
    onError: (err) => onPaneError(String(err)),
  });

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
    const sourceScreen = event.dataTransfer.getData(PANE_SRC_MIME) || null;
    if (!droppedId || droppedId === agentId) return;
    onPlaceAgent(droppedId, agentId, dropZone, sourceScreen);
  };

  // Stable host node the section always portals into — created once and
  // never replaced, so the terminal (and its socket + WebRTC) never
  // remounts. On a move the host is *moved* between slot divs via
  // appendChild, which relocates the DOM without React reconciliation.
  if (!hostRef.current && typeof document !== "undefined") {
    const host = document.createElement("div");
    host.style.display = "contents";
    hostRef.current = host;
  }
  if (!hostRef.current) return null; // SSR only

  return createPortal(
    <section
      aria-label={agent ? agentTitle(agent) : "Missing agent"}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onFocusCapture={() => onFocusPane(agentId)}
      onPointerDownCapture={() => onFocusPane(agentId)}
      className={cn(
        "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background",
        stacked ? "min-h-[50dvh] flex-none" : "min-h-0",
        focusedId === agentId && paneCount > 1 && "ring-2 ring-inset ring-ring/60",
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

      {/* Pane header — the same AgentSurfaceHeader the full agent page uses,
          in its dense variant, so a pane and the standalone view are one
          surface at two sizes. The header itself is the drag handle. */}
      {agent ? (
        <AgentSurfaceHeader
          agent={agent}
          connInfo={connInfo}
          displayOwner={displayOwner}
          dense
          getHandle={getHandle}
          onError={onPaneError}
          onDeleted={() => onRootChange(removePane(root, agentId))}
          headerProps={{
            draggable: true,
            onDragStart: (event) =>
              setAgentDragData(
                (event as unknown as React.DragEvent).dataTransfer,
                agentId,
                agentTitle(agent),
                screenId,
              ),
            onDoubleClick: () => !stacked && onToggleZoom(agentId),
            className: "cursor-grab active:cursor-grabbing",
          }}
          trailing={
            <>
              {!stacked && (
                <button
                  type="button"
                  aria-label={zoomed ? "Restore pane" : "Zoom pane"}
                  title={zoomed ? "Restore" : "Zoom (fill the screen)"}
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
              <button
                type="button"
                aria-label="Remove pane"
                title="Remove from screen"
                onClick={() => onRootChange(removePane(root, agentId))}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            </>
          }
        />
      ) : (
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 bg-card/60 px-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Agent no longer exists
          </span>
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
      )}

      {agent ? (
        <div className="relative min-h-0 flex-1 @container/term">
          <div ref={attach} className="size-full" />
          {attention === "dead" && (
            <div className="absolute inset-x-0 bottom-4 z-20 flex justify-center">
              <button
                type="button"
                disabled={restartM.isPending}
                onClick={() => restartM.mutate()}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs shadow-lg transition-colors hover:bg-accent"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {restartM.isPending ? "Restarting…" : `Restart ${agentTitle(agent)}`}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center text-xs text-muted-foreground">
          This agent was deleted — remove the pane.
        </div>
      )}
    </section>,
    hostRef.current,
  );
}
