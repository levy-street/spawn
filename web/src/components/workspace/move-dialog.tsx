"use client";

import { AlertTriangle, ArrowRightLeft, GitBranch, Info } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDaemonConnection } from "@/components/hosts/DaemonConnectionsProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { Agent, Host, Session } from "@/lib/api";
import { type ConversationState, canonicalConversationId } from "@/lib/conversation";
import type { DaemonConnection } from "@/lib/daemon-connection";
import { HostControlClient } from "@/lib/hostControl";
import { newTransferId, probeConversation } from "@/lib/move/conv";
import {
  CANCEL_LABEL,
  checkingLine,
  MOVE_WITH_CONVERSATION_LABEL,
  moveTitle,
  notConnectedBlock,
  PERMISSION_PICKER_LABEL,
  START_FRESH_LABEL,
  STARTS_IN_LABEL,
  sourceOfflineBody,
  startFreshOnLabel,
} from "@/lib/move/copy";
import type { LegInfo } from "@/lib/move/estimate";
import {
  defaultPermissionMode,
  PERMISSION_MODES,
  permissionModeLabel,
} from "@/lib/move/permission-modes";
import {
  gatherMoveFacts,
  type MoveDialogModel,
  type MoveFacts,
  moveDialogModel,
} from "@/lib/move/preflight";
import { displayPath } from "@/lib/places";
import type { StartMove } from "./moves-provider";

const CHECK_CONNECT_MS = 6_000;
const CHECK_REQUEST_MS = 6_000;
const RESAMPLE_MS = 2_500;

type Check =
  | { kind: "checking" }
  | { kind: "source_offline" }
  | { kind: "not_connected"; host: string }
  | { kind: "ready"; facts: MoveFacts; model: MoveDialogModel };

function leg(connection: DaemonConnection | null): LegInfo {
  const info = connection?.getSnapshot().info;
  return { kind: info?.kind ?? null, rttMs: info?.rttMs ?? null };
}

async function readyClient(
  hostId: string,
  connection: DaemonConnection | null,
  opened: HostControlClient[],
): Promise<HostControlClient | null> {
  if (connection?.getSnapshot().state !== "ready") return null;
  const client = new HostControlClient(hostId, { sharedConnection: connection });
  opened.push(client);
  try {
    await client.waitUntilReady(CHECK_CONNECT_MS);
    return client;
  } catch {
    return null;
  }
}

function readText(client: HostControlClient) {
  return async (path: string, limit: number): Promise<string | null> => {
    const head = await client.readHead(path, limit, { timeoutMs: CHECK_REQUEST_MS });
    return new TextDecoder().decode(head.bytes);
  };
}

/**
 * "Move Claude Code to mac?" — the carried move's one question, asked once
 * the hosts have answered what it needs (a second or so, "Checking dream and
 * mac…"). Confirming is the person's permission for this one carry; nothing
 * is ever carried without it. "Start fresh instead" is the move that starts a
 * new conversation there.
 */
export function MoveDialog({
  open,
  onOpenChange,
  session,
  agent,
  source,
  target,
  cwd,
  onStartFresh,
  onConfirmed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  agent: Agent;
  source: Host;
  target: Host;
  /** The folder picked on the target. */
  cwd: string;
  onStartFresh: () => void;
  onConfirmed: (move: StartMove) => void;
}) {
  const sourceConnection = useDaemonConnection(source.id);
  const targetConnection = useDaemonConnection(target.id);
  const [check, setCheck] = useState<Check>({ kind: "checking" });
  // Where the picker starts: the target's own default, once it has said.
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const clients = useRef<{ source: HostControlClient | null }>({ source: null });
  const shownCwd = displayPath(cwd);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the checks run once per opening.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const opened: HostControlClient[] = [];
    setCheck({ kind: "checking" });
    setConfirming(false);
    setChosen(null);
    void (async () => {
      if (source.status !== "online" || sourceConnection?.getSnapshot().state !== "ready") {
        if (!cancelled) setCheck({ kind: "source_offline" });
        return;
      }
      const [from, to] = await Promise.all([
        readyClient(source.id, sourceConnection, opened),
        readyClient(target.id, targetConnection, opened),
      ]);
      if (cancelled) return;
      if (!from) {
        setCheck({ kind: "source_offline" });
        return;
      }
      if (!to) {
        setCheck({ kind: "not_connected", host: target.name });
        return;
      }
      clients.current.source = from;
      const facts = await gatherMoveFacts({
        sessionId: session.id,
        recordedConversationId: session.agent_session_id,
        sourceCwd: session.cwd,
        targetCwd: cwd,
        source: {
          inspect: (id) => from.inspectConversation(id, { timeoutMs: CHECK_REQUEST_MS }),
          transcripts: (query) => from.agentTranscripts(query, { timeoutMs: CHECK_REQUEST_MS }),
          readText: readText(from),
        },
        target: {
          probe: (query) => probeConversation(to, query, { timeoutMs: CHECK_REQUEST_MS }),
          readText: readText(to),
        },
        legs: [leg(sourceConnection), leg(targetConnection)],
      });
      if (cancelled) return;
      setCheck({
        kind: "ready",
        facts,
        model: moveDialogModel(facts, { source: source.name, target: target.name, cwd: shownCwd }),
      });
    })();
    return () => {
      cancelled = true;
      clients.current.source = null;
      for (const client of opened) client.close();
    };
  }, [open, session.id, source.id, target.id, cwd]);

  const mode =
    chosen ?? defaultPermissionMode(agent, check.kind === "ready" ? check.facts.settings : null);

  const confirm = async () => {
    if (check.kind !== "ready" || !check.facts.conversationId) return;
    setConfirming(true);
    // Sampled again as the person confirms, before anything stops — the
    // dialog may have been open a while: the conversation the window is in
    // now is the one that goes, and its state decides whether the note is
    // sent or left typed. An answer that cannot be had leaves the dialog's.
    let state: ConversationState = check.facts.state;
    let conversationId = check.facts.conversationId;
    const from = clients.current.source;
    if (from) {
      const fresh = await from
        .inspectConversation(session.id, { timeoutMs: RESAMPLE_MS })
        .catch(() => null);
      if (fresh?.agent === "claude-code") {
        state = fresh.state;
        conversationId = canonicalConversationId(fresh.conversation_id) ?? conversationId;
      }
    }
    const transferId = newTransferId();
    onConfirmed({
      plan: {
        transferId,
        sessionId: session.id,
        agent: {
          kind: agent.kind,
          command: agent.command,
          env: agent.env,
          yolo: agent.yolo,
          yolo_args: agent.yolo_args,
          yolo_env: agent.yolo_env,
        },
        conversationId,
        source: { hostId: source.id, name: source.name, os: source.os ?? null, cwd: session.cwd },
        target: { hostId: target.id, name: target.name, os: target.os ?? null, cwd },
        state,
        permissionMode: mode,
        targetShell: check.facts.probe?.loginShell ?? null,
        memoryPath: check.facts.probe?.memory ?? null,
        wasRunning: session.status === "running" || session.status === "starting",
      },
      record: {
        transferId,
        sessionId: session.id,
        sourceHostId: source.id,
        sourceName: source.name,
        targetHostId: target.id,
        targetName: target.name,
        targetCwd: cwd,
        conversationId,
        state,
      },
    });
    onOpenChange(false);
  };

  const blocked = check.kind === "ready" && check.model.blocks.length > 0;
  const modeChoices = useMemo(() => PERMISSION_MODES, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" aria-describedby="move-dialog-body">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="size-4 text-muted-foreground" aria-hidden />
            {moveTitle(target.name)}
          </DialogTitle>
          {check.kind === "checking" && (
            <DialogDescription id="move-dialog-body" className="flex items-center gap-2">
              <Spinner className="size-3.5" />
              {checkingLine(source.name, target.name)}
            </DialogDescription>
          )}
          {check.kind === "source_offline" && (
            <DialogDescription id="move-dialog-body">
              {sourceOfflineBody(source.name, target.name)}
            </DialogDescription>
          )}
          {check.kind === "not_connected" && (
            <DialogDescription id="move-dialog-body">
              {notConnectedBlock(check.host)}
            </DialogDescription>
          )}
          {check.kind === "ready" && (
            <DialogDescription id="move-dialog-body">{check.model.body}</DialogDescription>
          )}
        </DialogHeader>

        {check.kind === "ready" && (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 pb-2 text-sm">
            {check.model.blocks.length === 0 && (
              <p className="text-foreground">{check.model.stateLine}</p>
            )}
            {check.model.folderLine && (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <GitBranch className="size-3.5 shrink-0" aria-hidden />
                {check.model.folderLine}
              </p>
            )}
            {[...check.model.blocks, ...check.model.warnings].map((line) => (
              <p
                key={line}
                role={check.model.blocks.includes(line) ? "alert" : undefined}
                className="flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-warning"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{line}</span>
              </p>
            ))}
            {check.model.notes.map((line) => (
              <p key={line} className="flex items-start gap-1.5 text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{line}</span>
              </p>
            ))}
            {!blocked && (
              <label className="mt-1 flex items-center gap-2 text-muted-foreground">
                <span>{STARTS_IN_LABEL}</span>
                <select
                  aria-label={PERMISSION_PICKER_LABEL}
                  value={mode}
                  onChange={(event) => setChosen(event.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                >
                  {modeChoices.map((choice) => (
                    <option key={choice.mode} value={choice.mode} title={choice.description}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                <span className="sr-only">{permissionModeLabel(mode)}</span>
              </label>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {CANCEL_LABEL}
          </Button>
          {check.kind === "source_offline" ? (
            <Button
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onStartFresh();
              }}
            >
              {startFreshOnLabel(target.name)}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={check.kind === "checking"}
                onClick={() => {
                  onOpenChange(false);
                  onStartFresh();
                }}
              >
                {START_FRESH_LABEL}
              </Button>
              <Button
                size="sm"
                disabled={check.kind !== "ready" || blocked || confirming}
                onClick={() => void confirm()}
              >
                {MOVE_WITH_CONVERSATION_LABEL}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
