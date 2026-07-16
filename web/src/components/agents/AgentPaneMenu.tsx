"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  ArchiveRestore,
  ExternalLink,
  FolderOpen,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { agentTitle } from "@/lib/agents";
import { type Agent, agents } from "@/lib/api";
import { runDiagnosticRefresh } from "@/lib/diagnostics";

/**
 * The agent actions a screen pane shares with the full agent page: parity is
 * the point — anything you'd leave a screen to do belongs here.
 */
export function AgentPaneMenuItems({
  agent,
  getHandle,
  onError,
  onDeleted,
}: {
  agent: Agent;
  getHandle?: () => TerminalHandle | null;
  onError: (message: string) => void;
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["agents"] });
    qc.invalidateQueries({ queryKey: ["agent", agent.id] });
  };
  const restartM = useMutation({
    mutationFn: () => agents.restart(agent.id, { create_cwd: true }),
    onSuccess: invalidate,
    onError: (err) => onError(String(err)),
  });
  const renameM = useMutation({
    mutationFn: (name: string) => agents.rename(agent.id, name),
    onSuccess: invalidate,
    onError: (err) => onError(String(err)),
  });
  const pinM = useMutation({
    mutationFn: () => (agent.pinned_at ? agents.unpin(agent.id) : agents.pin(agent.id)),
    onSuccess: invalidate,
    onError: (err) => onError(String(err)),
  });
  const archiveM = useMutation({
    mutationFn: () => (agent.archived_at ? agents.unarchive(agent.id) : agents.archive(agent.id)),
    onSuccess: invalidate,
    onError: (err) => onError(String(err)),
  });
  const deleteM = useMutation({
    mutationFn: () => agents.remove(agent.id),
    onSuccess: () => {
      invalidate();
      onDeleted?.();
    },
    onError: (err) => onError(String(err)),
  });

  return (
    <>
      <DropdownMenuItem onSelect={() => router.push(`/agents/${agent.id}`)}>
        <ExternalLink className="size-4" aria-hidden />
        Open full page
      </DropdownMenuItem>
      <DropdownMenuItem
        href={`/hosts/${agent.host_id}/files?path=${encodeURIComponent(agent.cwd)}`}
      >
        <FolderOpen className="size-4" aria-hidden />
        Browse files
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={restartM.isPending} onSelect={() => restartM.mutate()}>
        <RotateCcw className="size-4" aria-hidden />
        Restart agent
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          const next = prompt("Rename agent", agent.name ?? agentTitle(agent));
          if (next?.trim()) renameM.mutate(next.trim());
        }}
      >
        <Pencil className="size-4" aria-hidden />
        Rename…
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => pinM.mutate()}>
        {agent.pinned_at ? (
          <PinOff className="size-4" aria-hidden />
        ) : (
          <Pin className="size-4" aria-hidden />
        )}
        {agent.pinned_at ? "Unpin" : "Pin"}
      </DropdownMenuItem>
      {getHandle && (
        <DropdownMenuItem
          onSelect={() => {
            const handle = getHandle();
            if (!handle) return;
            runDiagnosticRefresh(handle, agent.id).catch((err) =>
              onError(`diagnostic refresh: ${String(err)}`),
            );
          }}
        >
          <Activity className="size-4" aria-hidden />
          Refresh + diagnostics
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => archiveM.mutate()}>
        {agent.archived_at ? (
          <ArchiveRestore className="size-4" aria-hidden />
        ) : (
          <Archive className="size-4" aria-hidden />
        )}
        {agent.archived_at ? "Unarchive" : "Archive"}
      </DropdownMenuItem>
      <DropdownMenuItem
        destructive
        onSelect={() => {
          if (confirm(`Delete ${agentTitle(agent)}? This cannot be undone.`)) deleteM.mutate();
        }}
      >
        <Trash2 className="size-4" aria-hidden />
        Delete agent
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="space-y-1">
        <div className="truncate font-mono" title={agent.argv.join(" ")}>
          {agent.argv.join(" ")}
        </div>
        <div className="truncate font-mono" title={agent.cwd}>
          {agent.cwd}
        </div>
      </DropdownMenuLabel>
    </>
  );
}
