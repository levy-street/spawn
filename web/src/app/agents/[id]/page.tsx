"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AuthGate } from "@/components/auth/AuthGate";
import { FileExplorer } from "@/components/files/FileExplorer";
import { AppShell } from "@/components/nav/AppShell";
import { type AgentConnectionInfo, ConnectionChip } from "@/components/terminal/ConnectionChip";
import { ModifierBar } from "@/components/terminal/ModifierBar";
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
import { agentActivityDetail, agentTitle, isAgentArchived } from "@/lib/agents";
import { agentAccess, agents, screens } from "@/lib/api";
import { useAgentDrop } from "@/lib/dnd";
import type { DisplayControlState } from "@/lib/ws";

const MOBILE_PROMPT_NEWLINE = "\x1b[200~\n\x1b[201~";

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

  const termRef = useRef<TerminalHandle>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [displayState, setDisplayState] = useState<DisplayControlState | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [connInfo, setConnInfo] = useState<AgentConnectionInfo | null>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px) and (pointer: fine)").matches;
    if (desktop) requestAnimationFrame(() => termRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!id) return;
    setDisplayState(null);
    setEditingName(false);
  }, [id]);

  const q = useQuery({
    queryKey: ["agent", id],
    queryFn: () => agents.get(id as string),
    enabled: !!id,
    refetchInterval: 5_000,
  });
  const accessQ = useQuery({
    queryKey: ["agent-access", id],
    queryFn: () => agentAccess.get(id as string),
    enabled: !!id,
    refetchInterval: 10_000,
  });
  const skillsSummary = accessQ.data?.skills.length
    ? accessQ.data.skills.map((skill) => skill.name).join(", ")
    : null;

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
  const pinM = useMutation({
    mutationFn: (pinned: boolean) =>
      pinned ? agents.pin(id as string) : agents.unpin(id as string),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(String(err)),
  });
  const archiveM = useMutation({
    mutationFn: () => agents.archive(id as string),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(String(err)),
  });
  const unarchiveM = useMutation({
    mutationFn: () => agents.unarchive(id as string),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(String(err)),
  });
  const deleteM = useMutation({
    mutationFn: () => agents.remove(id as string),
    onSuccess: () => {
      invalidate();
      router.push("/agents");
    },
    onError: (err) => setActionError(String(err)),
  });
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagSaved, setDiagSaved] = useState(false);
  // Manual terminal refresh that records before/after diagnostics and saves
  // them to the agent host (cwd/.spawn/attachments) for offline review.
  const runDiagnosticRefresh = async () => {
    const handle = termRef.current;
    if (!handle || diagBusy) return;
    setDiagBusy(true);
    setDiagSaved(false);
    try {
      const bundle = await handle.refreshDiagnostics();
      const json = new TextEncoder().encode(JSON.stringify(bundle, null, 2));
      let binary = "";
      for (let i = 0; i < json.length; i += 0x8000) {
        binary += String.fromCharCode(...json.subarray(i, i + 0x8000));
      }
      await agents.upload(id as string, {
        name: `terminal-diag-${new Date().toISOString().replaceAll(":", "-")}.json`,
        mime_type: "application/json",
        bytes_b64: btoa(binary),
      });
      setActionError(null);
      setDiagSaved(true);
      setTimeout(() => setDiagSaved(false), 2500);
    } catch (err) {
      setActionError(`diagnostic refresh: ${String(err)}`);
    } finally {
      setDiagBusy(false);
    }
  };
  const restartM = useMutation({
    mutationFn: () => {
      const size = termRef.current?.getSize();
      return agents.restart(id as string, size ? { ...size, create_cwd: true } : undefined);
    },
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(String(err)),
  });
  const splitM = useMutation({
    mutationFn: ({ droppedId, droppedTitle }: { droppedId: string; droppedTitle: string }) => {
      const current = q.data ? agentTitle(q.data) : "agent";
      const name = `${current} · ${droppedTitle || "split"}`.slice(0, 128);
      return screens.create({
        name,
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
  const { active: splitDropActive, dropProps: splitDropProps } = useAgentDrop(
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

        {agent && (
          <span className="relative shrink-0">
            <AgentKindIcon agent={agent} />
            <AgentStatusDot agent={agent} className="absolute -bottom-0.5 -right-0.5" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          {editingName ? (
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
          ) : (
            <button
              type="button"
              className="block max-w-full truncate rounded px-0.5 text-left text-sm font-medium leading-5 hover:bg-accent/50"
              title="Rename agent"
              onClick={() => {
                if (!agent) return;
                setDraftName(agent.name ?? agentTitle(agent));
                setEditingName(true);
              }}
            >
              {agent ? agentTitle(agent) : "…"}
            </button>
          )}
          <div className="truncate px-0.5 text-[11px] leading-4 text-muted-foreground">
            {agent
              ? `${agentActivityDetail(agent)}${archived ? " · archived" : ""} · ${agent.host_name ?? "?"} · ${agent.cwd}`
              : "loading…"}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <ConnectionChip info={connInfo} compact className="sm:hidden" />
          <ConnectionChip info={connInfo} className="hidden sm:block" />
          <TerminalDisplayControl state={displayState} />
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
          {agent && (
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="size-8 md:hidden"
              aria-label="Browse files"
            >
              <Link href={`/hosts/${agent.host_id}/files?path=${encodeURIComponent(agent.cwd)}`}>
                <FolderOpen className="size-4" />
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Refresh terminal"
            title={
              diagSaved
                ? "Diagnostics saved to the agent host"
                : "Refresh terminal (saves before/after diagnostics)"
            }
            disabled={diagBusy}
            onClick={runDiagnosticRefresh}
          >
            {diagSaved ? (
              <Check className="size-4 text-emerald-500" />
            ) : (
              <RefreshCw className={`size-4 ${diagBusy ? "animate-spin" : ""}`} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Restart agent"
            title="Restart agent"
            disabled={!agent || restartM.isPending}
            onClick={() => {
              if (confirm("Restart this agent?")) restartM.mutate();
            }}
          >
            <RotateCcw className={`size-4 ${restartM.isPending ? "animate-spin" : ""}`} />
          </Button>
          <DropdownMenu
            menuClassName="w-64"
            renderTrigger={(props) => (
              <Button
                {...props}
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Agent actions"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            )}
          >
            <DropdownMenuItem
              disabled={!agent || renameM.isPending}
              onSelect={() => {
                if (!agent) return;
                setDraftName(agent.name ?? agentTitle(agent));
                setEditingName(true);
              }}
            >
              <Pencil className="size-4" aria-hidden />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!agent || pinM.isPending}
              onSelect={() => pinM.mutate(!agent?.pinned_at)}
            >
              {agent?.pinned_at ? (
                <PinOff className="size-4" aria-hidden />
              ) : (
                <Pin className="size-4" aria-hidden />
              )}
              {agent?.pinned_at ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            {agent && (
              <DropdownMenuItem
                href={`/hosts/${agent.host_id}/files?path=${encodeURIComponent(agent.cwd)}`}
              >
                <FolderOpen className="size-4" aria-hidden />
                Browse files
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={!agent || archiveM.isPending || unarchiveM.isPending}
              onSelect={() => (archived ? unarchiveM.mutate() : archiveM.mutate())}
            >
              {archived ? (
                <ArchiveRestore className="size-4" aria-hidden />
              ) : (
                <Archive className="size-4" aria-hidden />
              )}
              {archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            {agent && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="space-y-1">
                  <div className="truncate font-mono" title={agent.argv.join(" ")}>
                    {agent.argv.join(" ")}
                  </div>
                  <div className="truncate font-mono" title={agent.cwd}>
                    {agent.cwd}
                  </div>
                  {agent.tmux_session && (
                    <div className="truncate font-mono" title={agent.tmux_session}>
                      tmux {agent.tmux_session}
                    </div>
                  )}
                  {skillsSummary && (
                    <div className="truncate" title={skillsSummary}>
                      skills: {skillsSummary}
                    </div>
                  )}
                </DropdownMenuLabel>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              disabled={deleteM.isPending}
              onSelect={() => {
                if (confirm("Delete this agent?")) deleteM.mutate();
              }}
            >
              <Trash2 className="size-4" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenu>
        </div>
      </header>

      {q.error && (
        <p className="p-4 text-sm text-destructive">Failed to load agent: {String(q.error)}</p>
      )}
      {actionError && <p className="px-4 py-2 text-sm text-destructive">{actionError}</p>}

      {/* imagePasteMode: Claude and Codex both convert a bracketed-pasted
          image path into their native attachment pill ([Image #1]), and
          pasting the path is also the sane behavior for plain shells. */}
      <div className="flex min-h-0 flex-1">
        <div {...splitDropProps} className="relative min-h-0 min-w-0 flex-1 @container/term">
          {splitDropActive && (
            <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-ring bg-background/60">
              <span className="rounded-lg border border-border bg-popover px-3 py-1.5 text-sm shadow-lg">
                Drop to open a split view
              </span>
            </div>
          )}
          <Terminal
            ref={termRef}
            agentId={id}
            rawInput
            mobileReturnMode="newline"
            mobileReturnBytes={MOBILE_PROMPT_NEWLINE}
            imagePasteMode="bracketed-path"
            onDisplayControl={setDisplayState}
            onConnectionInfo={setConnInfo}
          />
        </div>
        {filesOpen && agent && (
          <aside
            aria-label="Files panel"
            className="hidden w-72 shrink-0 flex-col border-l border-border md:flex"
          >
            <FileExplorer
              hostId={agent.host_id}
              rootPath={agent.cwd}
              dense
              className="min-h-0 flex-1"
            />
          </aside>
        )}
      </div>

      <ModifierBar
        className="hidden [@media(pointer:coarse)]:flex"
        onSend={(b) => {
          termRef.current?.sendInput(b);
          requestAnimationFrame(() => termRef.current?.focus());
        }}
        onPaste={(data) => {
          termRef.current?.pasteDataTransfer(data);
        }}
        onPasteText={(text) => {
          termRef.current?.pasteText(text);
        }}
        onPasteClick={() => {
          void termRef.current?.pasteFromClipboard();
        }}
        onSubmit={() => {
          termRef.current?.submit();
          requestAnimationFrame(() => termRef.current?.focus());
        }}
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
