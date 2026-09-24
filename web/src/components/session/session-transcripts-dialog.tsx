"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, Eye, ScrollText, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatSize } from "@/components/files/FileExplorer";
import { FileViewerDialog } from "@/components/files/file-viewer-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { useHostControl } from "@/hooks/useHostControl";
import {
  type TranscriptNotice,
  transcriptEmptyState,
  transcriptQueryFor,
  transcriptRoleLabel,
  transcriptsNeedAnAgent,
  transcriptsUnavailable,
} from "@/lib/agent-transcripts";
import { agents as agentsApi, type Session } from "@/lib/api";
import {
  AGENT_TRANSCRIPTS_OP,
  type AgentTranscriptFile,
  type HostDirEntry,
} from "@/lib/hostControl";
import { deriveFileCapabilities } from "@/lib/preview/capabilities";

/**
 * The agent's own record of this window's conversation — the files the
 * harness writes on the host as it goes — located by the daemon and read here
 * like any other host file. Nothing in it crosses the server: the list comes
 * over the device's host channel and every byte of a transcript over the same
 * channel the file explorer uses (`docs/TRUST.md`).
 *
 * Mounted by the pane and the full-screen session beside their other dialogs,
 * and connects only while open: a host-control consumer channel on the
 * device's shared connection, released with the dialog.
 */
export function SessionTranscriptsDialog({
  open,
  session,
  onClose,
}: {
  open: boolean;
  session: Session;
  onClose: () => void;
}) {
  const hostName = session.host_name ?? "this host";
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: agentsApi.list, enabled: open });
  const target = useMemo(
    () => (agentsQuery.data ? transcriptQueryFor(session, agentsQuery.data) : null),
    [agentsQuery.data, session],
  );
  const { client, state, capabilities, os } = useHostControl(session.host_id, open);
  const supported = capabilities.has(AGENT_TRANSCRIPTS_OP);
  const caps = useMemo(() => deriveFileCapabilities(capabilities, os), [capabilities, os]);

  const reportQuery = useQuery({
    queryKey: ["agent-transcripts", session.id, target?.query ?? null],
    queryFn: () => {
      if (!client || !target) throw new Error("Host control channel is not ready");
      return client.agentTranscripts(target.query);
    },
    enabled: open && state === "ready" && supported && client !== null && target !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const [viewing, setViewing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // A closed dialog forgets its viewer and its last download word: the next
  // opening is a fresh look at whatever the agent has written since.
  useEffect(() => {
    if (!open) {
      setViewing(null);
      setStatus(null);
    }
  }, [open]);

  const transcripts = reportQuery.data?.transcripts ?? [];
  const viewingIndex = viewing === null ? -1 : transcripts.findIndex((f) => f.path === viewing);
  const viewingEntry = viewingIndex >= 0 ? entryOf(transcripts[viewingIndex]) : null;

  const download = async (file: AgentTranscriptFile) => {
    if (!client) return;
    setStatus(`Downloading ${file.name}…`);
    try {
      await client.saveFileToBrowser(file.path, file.name);
      setStatus(null);
    } catch (error) {
      setStatus(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let notice: TranscriptNotice | null = null;
  let busy: string | null = null;
  if (agentsQuery.isPending) busy = "Loading…";
  else if (!target) notice = transcriptsNeedAnAgent();
  else if (state === "error") {
    notice = {
      title: `Can't reach ${hostName}`,
      body: "Transcripts are read from the host directly, so it has to be online and trusted from this device.",
    };
  } else if (state !== "ready") busy = `Connecting to ${hostName}…`;
  else if (!supported) notice = transcriptsUnavailable(hostName);
  else if (reportQuery.isPending) busy = "Looking for transcripts…";
  else if (reportQuery.error) {
    notice = {
      title: "Couldn't list transcripts",
      body:
        reportQuery.error instanceof Error ? reportQuery.error.message : String(reportQuery.error),
    };
  } else if (reportQuery.data) {
    notice = transcriptEmptyState(reportQuery.data, target.agent.name, hostName);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent size="md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{target ? `${target.agent.name} transcript` : "Transcript"}</DialogTitle>
            <DialogDescription>
              The conversation as the agent wrote it on {hostName}. Read straight from the host; the
              server never sees it.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {busy ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Spinner size={16} label={busy} />
                {busy}
              </div>
            ) : notice ? (
              <EmptyState
                icon={state === "error" ? <Unplug /> : <ScrollText />}
                title={notice.title}
                body={notice.body}
              />
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {transcripts.map((file) => (
                  <li key={file.path} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium">{file.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {transcriptRoleLabel(file.role)}
                        </span>
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={file.path}
                      >
                        {file.path}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatSize(file.size)}
                        {file.modified_at != null && ` · ${formatModified(file.modified_at)}`}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`View ${file.name}`}
                      onClick={() => setViewing(file.path)}
                    >
                      <Eye className="size-4" aria-hidden />
                      View
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Download ${file.name}`}
                      onClick={() => void download(file)}
                    >
                      <Download className="size-4" aria-hidden />
                      Download
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {reportQuery.data?.truncated && !notice && !busy && (
              <p className="pt-2 text-xs text-muted-foreground">
                Only the newest are listed; older conversations stay on the host.
              </p>
            )}
            {status && (
              <p className="pt-2 text-xs text-muted-foreground" role="status">
                {status}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <FileViewerDialog
        open={viewingEntry !== null}
        hostId={session.host_id}
        entry={viewingEntry}
        client={client}
        caps={caps}
        hasPrev={viewingIndex > 0}
        hasNext={viewingIndex >= 0 && viewingIndex < transcripts.length - 1}
        relativePath={viewingEntry?.path ?? ""}
        onNavigate={(delta) => {
          const next = transcripts[viewingIndex + delta];
          if (next) setViewing(next.path);
        }}
        onClose={() => setViewing(null)}
        onDownload={() => {
          const file = transcripts[viewingIndex];
          if (file) void download(file);
        }}
        onReveal={() => viewingEntry && void client?.reveal(viewingEntry.path)}
        onOpenExternal={() => viewingEntry && void client?.openDefault(viewingEntry.path)}
        onCopyPath={() => viewingEntry && void navigator.clipboard?.writeText(viewingEntry.path)}
      />
    </>
  );
}

/** A transcript as the file viewer wants it: a regular file with a size. */
function entryOf(file: AgentTranscriptFile | undefined): HostDirEntry | null {
  if (!file) return null;
  return {
    name: file.name,
    path: file.path,
    kind: "file",
    is_dir: false,
    size: file.size,
    modified_at: file.modified_at ?? null,
  };
}

function formatModified(seconds: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(seconds * 1000),
  );
}
