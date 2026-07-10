"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Download,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
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
import { agentAccess, agents, hosts, screens } from "@/lib/api";
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
  const toolsQ = useQuery({
    queryKey: ["host-tools", q.data?.host_id],
    queryFn: () => hosts.tools(q.data!.host_id),
    enabled: Boolean(q.data?.host_id && q.data?.preset_id),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const accessQ = useQuery({
    queryKey: ["agent-access", id],
    queryFn: () => agentAccess.get(id as string),
    enabled: !!id,
    refetchInterval: 10_000,
  });
  const currentTool = toolsQ.data?.tools.find((tool) => tool.preset_id === q.data?.preset_id);
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
  const updateToolM = useMutation({
    mutationFn: () => hosts.installTool(q.data!.host_id, q.data!.preset_id!),
    onSuccess: () => {
      setActionError(null);
      if (q.data) qc.invalidateQueries({ queryKey: ["host-tools", q.data.host_id] });
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
          tabs: [
            {
              name: null,
              root: {
                type: "split",
                direction: "row",
                ratio: 0.5,
                a: { type: "pane", agent_id: id as string },
                b: { type: "pane", agent_id: droppedId },
              },
            },
          ],
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
          {currentTool?.update_available && (
            <Button
              variant="secondary"
              size="sm"
              className="hidden sm:inline-flex"
              disabled={updateToolM.isPending}
              title={
                currentTool.latest_version
                  ? `Latest version: ${currentTool.latest_version}`
                  : "Update available"
              }
              onClick={() => updateToolM.mutate()}
            >
              <Download className="size-4" />
              {updateToolM.isPending
                ? "Updating..."
                : currentTool.auto_update
                  ? "Auto updating"
                  : "Update"}
            </Button>
          )}
          <TerminalDisplayControl
            state={displayState}
            onTakeControl={() => termRef.current?.takeControl()}
          />
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
            {currentTool?.update_available && (
              <DropdownMenuItem
                className="sm:hidden"
                disabled={updateToolM.isPending}
                onSelect={() => updateToolM.mutate()}
              >
                <Download className="size-4" aria-hidden />
                Update {currentTool.preset_name}
              </DropdownMenuItem>
            )}
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
      <div {...splitDropProps} className="relative min-h-0 flex-1 @container/term">
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
        />
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

function TerminalDisplayControl({
  state,
  onTakeControl,
}: {
  state: DisplayControlState | null;
  onTakeControl: () => void;
}) {
  if (!state) return null;
  if (!state.owner) {
    const size =
      typeof state.cols === "number" && typeof state.rows === "number"
        ? `${state.cols}x${state.rows}`
        : "shared";
    return (
      <div className="flex items-center gap-1">
        <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
          Viewer · {size}
        </span>
        <Button variant="secondary" size="sm" onClick={onTakeControl}>
          Take control
        </Button>
      </div>
    );
  }

  const otherViewers = Math.max(0, state.viewers - 1);
  if (otherViewers === 0) return null;
  return (
    <span className="hidden whitespace-nowrap px-2 text-xs text-muted-foreground sm:inline">
      {otherViewers} viewer{otherViewers === 1 ? "" : "s"}
    </span>
  );
}
