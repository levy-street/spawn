"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronsUpDown, FolderOpen, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type TouchEvent as ReactTouchEvent, useEffect, useRef, useState } from "react";
import { AgentSurfaceHeader } from "@/components/agents/AgentSurfaceHeader";
import { AgentSwitchSheet, useAgentSwitcher } from "@/components/agents/AgentSwitcher";
import { AuthGate } from "@/components/auth/AuthGate";
import { AgentFilesAside } from "@/components/files/AgentFilesAside";
import { AppShell } from "@/components/nav/AppShell";
import { useLiveTerminal } from "@/components/terminal/LiveTerminalProvider";
import { ModifierBar } from "@/components/terminal/ModifierBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentActivityDetail, agentTitle, isAgentArchived } from "@/lib/agents";
import { agents, screens } from "@/lib/api";
import { useAgentDrop } from "@/lib/dnd";
import { collectAgentIds } from "@/lib/layout";
import { defaultScreenName } from "@/lib/screens";
import type { DisplayControlState } from "@/lib/ws";

export default function AgentDetailPage() {
  return (
    <AuthGate>
      <AppShell hideMobileNav mainClassName="overflow-hidden">
        <AgentTerminal />
      </AppShell>
    </AuthGate>
  );
}

function AgentTerminal() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const qc = useQueryClient();

  // The terminal is a shared warm instance from the pool; this page just
  // claims it into `attach` and reads its handle + live state. Switching to a
  // screen showing the same agent reuses the instance — no reconnect.
  const { attach, getHandle, connInfo, displayState } = useLiveTerminal(id ?? null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    setEditingName(false);
    const desktop = window.matchMedia("(min-width: 768px) and (pointer: fine)").matches;
    const t = setTimeout(() => desktop && getHandle()?.focus(), 160);
    return () => clearTimeout(t);
  }, [id, getHandle]);

  const q = useQuery({
    queryKey: ["agent", id],
    queryFn: () => agents.get(id as string),
    enabled: !!id,
    refetchInterval: 5_000,
  });
  const screensQ = useQuery({ queryKey: ["screens"], queryFn: screens.list, staleTime: 30_000 });
  const memberScreens = (screensQ.data ?? []).filter((item) =>
    collectAgentIds(item.layout.root ?? null).includes(id as string),
  );

  // Agent quick-switch: swipe the top bar left/right to hop to the adjacent
  // recent agent, or open the sheet for the full searchable list. Switching is
  // a plain route push — instant because the target terminal stays warm.
  const agentsListQ = useQuery({
    queryKey: ["agents", { includeArchived: false }],
    queryFn: () => agents.list(),
    refetchInterval: 5_000,
  });
  const {
    list: switchList,
    index: switchIndex,
    prevId,
    nextId,
  } = useAgentSwitcher(agentsListQ.data, id);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switchTo = (targetId: string) => {
    if (targetId && targetId !== id) router.push(`/agents/${targetId}`);
  };
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const headerSwipe = {
    onTouchStart: (event: ReactTouchEvent<HTMLElement>) => {
      const t = event.touches[0];
      swipeRef.current = t ? { x: t.clientX, y: t.clientY } : null;
    },
    onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => {
      const start = swipeRef.current;
      swipeRef.current = null;
      if (!start || switcherOpen) return;
      const t = event.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      // Require a clear, horizontal-dominant swipe so taps on the header
      // buttons and vertical gestures never switch agents.
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0 && nextId) switchTo(nextId);
      else if (dx > 0 && prevId) switchTo(prevId);
    },
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["hosts"] });
    qc.invalidateQueries({ queryKey: ["agent", id] });
  };

  const renameM = useMutation({
    mutationFn: (name: string) => agents.rename(id as string, name),
    onSuccess: () => {
      setActionError(null);
      setEditingName(false);
      invalidate();
    },
    onError: (err) => setActionError(String(err)),
  });

  const splitM = useMutation({
    mutationFn: ({ droppedId }: { droppedId: string; droppedTitle: string }) => {
      return screens.create({
        name: defaultScreenName(screensQ.data ?? []),
        // Ad-hoc: dissolves if emptied, promotes on rename or a third pane.
        ephemeral: true,
        layout: {
          root: {
            type: "split",
            direction: "row",
            ratio: 0.5,
            a: { type: "pane", agent_id: id as string },
            b: { type: "pane", agent_id: droppedId },
          },
        },
      });
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["screens"] });
      router.push(`/screens/${created.id}`);
    },
    onError: (err) => setActionError(String(err)),
  });
  const { active: splitDropActive, dropRef: splitDropRef } = useAgentDrop(
    (droppedId, droppedTitle) => {
      if (!q.data || droppedId === id || splitM.isPending) return;
      splitM.mutate({ droppedId, droppedTitle });
    },
  );

  const submitRename = () => {
    const next = draftName.trim();
    if (!q.data || !next || next === q.data.name) {
      setEditingName(false);
      return;
    }
    renameM.mutate(next);
  };

  if (!id) return null;
  const agent = q.data;
  const archived = agent ? isAgentArchived(agent) : false;

  return (
    <div className="flex h-vv flex-col bg-background pad-safe-top">
      {agent ? (
        <AgentSurfaceHeader
          agent={agent}
          connInfo={connInfo}
          getHandle={getHandle}
          onError={setActionError}
          onStartRename={() => {
            setDraftName(agent.name ?? agentTitle(agent));
            setEditingName(true);
          }}
          onDeleted={() => router.push("/agents")}
          headerProps={headerSwipe}
          leading={
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => router.back()}
              aria-label="Back"
            >
              <ArrowLeft className="size-4" />
            </Button>
          }
          titleSlot={
            editingName ? (
              <Input
                aria-label="Agent name"
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={submitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename();
                  if (e.key === "Escape") setEditingName(false);
                }}
                className="h-7 max-w-64 text-sm"
                disabled={renameM.isPending}
              />
            ) : undefined
          }
          meta={
            <div className="flex items-center gap-1 truncate px-0.5 text-[11px] leading-4 text-muted-foreground">
              <span className="truncate">
                {`${agentActivityDetail(agent)}${archived ? " · archived" : ""} · ${agent.host_name ?? "?"} · ${agent.cwd}`}
              </span>
              {memberScreens.slice(0, 2).map((item) => (
                <Link
                  key={item.id}
                  href={`/screens/${item.id}?focus=${id}`}
                  title={`Focus this pane on ${item.name}`}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border px-1 leading-4 transition-colors hover:bg-accent/60 hover:text-foreground"
                >
                  <LayoutGrid className="size-2.5" aria-hidden />
                  {item.name}
                </Link>
              ))}
            </div>
          }
          trailing={
            <>
              <TerminalDisplayControl state={displayState} />
              <button
                type="button"
                aria-label="Switch agent"
                title="Switch agent (or swipe the bar left/right)"
                onClick={() => setSwitcherOpen(true)}
                className="flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                {switchIndex >= 0 && switchList.length > 1 && (
                  <span className="text-[11px] tabular-nums leading-none">
                    {switchIndex + 1}/{switchList.length}
                  </span>
                )}
                <ChevronsUpDown className="size-4" aria-hidden />
              </button>
              <Button
                variant={filesOpen ? "secondary" : "ghost"}
                size="icon"
                className="hidden size-8 md:inline-flex"
                aria-label="Toggle files panel"
                title="Files"
                aria-pressed={filesOpen}
                onClick={() => setFilesOpen((v) => !v)}
              >
                <FolderOpen className="size-4" />
              </Button>
            </>
          }
        />
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-2 pad-safe-x sm:px-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={() => router.back()}
            aria-label="Back"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <span className="text-sm text-muted-foreground">loading…</span>
        </header>
      )}

      {q.error && (
        <p className="p-4 text-sm text-destructive">Failed to load agent: {String(q.error)}</p>
      )}
      {actionError && <p className="px-4 py-2 text-sm text-destructive">{actionError}</p>}

      {/* imagePasteMode: Claude and Codex both convert a bracketed-pasted
          image path into their native attachment pill ([Image #1]), and
          pasting the path is also the sane behavior for plain shells. */}
      <div className="flex min-h-0 flex-1">
        <div ref={splitDropRef} className="relative min-h-0 min-w-0 flex-1 @container/term">
          {splitDropActive && (
            <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-ring bg-background/60">
              <span className="rounded-lg border border-border bg-popover px-3 py-1.5 text-sm shadow-lg">
                Drop to open a split view
              </span>
            </div>
          )}
          <div ref={attach} className="size-full" />
        </div>
        {filesOpen && agent && <AgentFilesAside agent={agent} />}
      </div>

      <ModifierBar
        className="hidden [@media(pointer:coarse)]:flex"
        onSend={(b) => {
          getHandle()?.sendInput(b);
          requestAnimationFrame(() => getHandle()?.focus());
        }}
        onPaste={(data) => {
          getHandle()?.pasteDataTransfer(data);
        }}
        onPasteText={(text) => {
          getHandle()?.pasteText(text);
        }}
        onPasteClick={() => {
          void getHandle()?.pasteFromClipboard();
        }}
        onSubmit={() => {
          getHandle()?.submit();
          requestAnimationFrame(() => getHandle()?.focus());
        }}
      />
      <AgentSwitchSheet
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        list={switchList}
        currentId={id}
        onPick={switchTo}
      />
    </div>
  );
}

function TerminalDisplayControl({ state }: { state: DisplayControlState | null }) {
  // Viewer mode is handled by the terminal itself (dimmed overlay with a
  // centered take-control button); the header only reports extra viewers.
  if (!state?.owner) return null;
  const otherViewers = Math.max(0, state.viewers - 1);
  if (otherViewers === 0) return null;
  return (
    <span className="hidden whitespace-nowrap px-2 text-xs text-muted-foreground sm:inline">
      {otherViewers} viewer{otherViewers === 1 ? "" : "s"}
    </span>
  );
}
