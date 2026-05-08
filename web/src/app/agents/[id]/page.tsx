"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ArrowLeft, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { ModifierBar } from "@/components/terminal/ModifierBar";
import { Terminal, type TerminalHandle } from "@/components/terminal/Terminal";
import { Button } from "@/components/ui/button";
import {
  agentActivityDetail,
  agentCommand,
  agentKind,
  agentTitle,
  isAgentArchived,
} from "@/lib/agents";
import { agents } from "@/lib/api";
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

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px) and (pointer: fine)").matches;
    if (desktop) requestAnimationFrame(() => termRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!id) return;
    setDisplayState(null);
  }, [id]);

  const q = useQuery({
    queryKey: ["agent", id],
    queryFn: () => agents.get(id as string),
    enabled: !!id,
    refetchInterval: 5_000,
  });

  const renameM = useMutation({
    mutationFn: (name: string) => agents.rename(id as string, name),
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["agent", id] });
    },
    onError: (err) => setActionError(String(err)),
  });

  const archiveM = useMutation({
    mutationFn: () => agents.archive(id as string),
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["hosts"] });
      qc.invalidateQueries({ queryKey: ["agent", id] });
    },
    onError: (err) => setActionError(String(err)),
  });

  const unarchiveM = useMutation({
    mutationFn: () => agents.unarchive(id as string),
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["hosts"] });
      qc.invalidateQueries({ queryKey: ["agent", id] });
    },
    onError: (err) => setActionError(String(err)),
  });

  const deleteM = useMutation({
    mutationFn: () => agents.remove(id as string),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["hosts"] });
      qc.invalidateQueries({ queryKey: ["agent", id] });
      router.push("/agents");
    },
    onError: (err) => setActionError(String(err)),
  });

  if (!id) return null;

  return (
    <div className="flex h-vv flex-col bg-background pad-safe-top">
      <header className="flex items-center justify-between border-b border-border bg-background/95 px-3 py-2 pad-safe-x">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label="Back">
            <ArrowLeft className="size-4" />
          </Button>
          {q.data && <AgentKindIcon agent={q.data} />}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{q.data ? agentTitle(q.data) : id}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {q.data ? agentCommand(q.data) : "loading..."}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {q.data
                ? `${agentActivityDetail(q.data)}${isAgentArchived(q.data) ? " · archived" : ""} · ${q.data.cwd}`
                : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <TerminalDisplayControl
            state={displayState}
            onTakeControl={() => termRef.current?.takeControl()}
          />
          <Button asChild variant="ghost" size="sm">
            <Link href="/agents">All agents</Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Rename agent"
            title="Rename agent"
            disabled={!q.data || renameM.isPending}
            onClick={() => {
              if (!q.data) return;
              const next = prompt("Rename agent", q.data.name ?? agentTitle(q.data));
              if (next === null) return;
              const name = next.trim();
              if (name) renameM.mutate(name);
            }}
          >
            <Pencil className="size-4" />
          </Button>
          {q.data && isAgentArchived(q.data) ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Unarchive agent"
              title="Unarchive agent"
              disabled={unarchiveM.isPending}
              onClick={() => unarchiveM.mutate()}
            >
              <ArchiveRestore className="size-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Archive agent"
              title="Archive agent"
              disabled={!q.data || archiveM.isPending}
              onClick={() => archiveM.mutate()}
            >
              <Archive className="size-4" />
            </Button>
          )}
          <Button
            variant="destructive"
            size="icon"
            aria-label="Delete agent"
            title="Delete agent"
            disabled={deleteM.isPending}
            onClick={() => {
              if (confirm("Delete this agent?")) deleteM.mutate();
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </header>

      {q.error && (
        <p className="p-4 text-sm text-destructive">Failed to load agent: {String(q.error)}</p>
      )}
      {actionError && <p className="px-4 py-2 text-sm text-destructive">{actionError}</p>}

      <div className="relative min-h-0 flex-1 @container/term">
        <Terminal
          ref={termRef}
          agentId={id}
          rawInput
          mobileReturnMode="newline"
          mobileReturnBytes={MOBILE_PROMPT_NEWLINE}
          imagePasteMode={q.data && agentKind(q.data) === "codex" ? "bracketed-path" : "deferred"}
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
