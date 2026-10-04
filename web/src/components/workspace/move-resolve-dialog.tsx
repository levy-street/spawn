"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useDaemonConnections } from "@/components/hosts/DaemonConnectionsProvider";
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
import { agents as agentsApi, type Host, hosts, type Session } from "@/lib/api";
import { HostControlClient } from "@/lib/hostControl";
import type { CarrierClient } from "@/lib/move/conv";
import {
  CANCEL_LABEL,
  conflictsLine,
  DISMISS_LABEL,
  GIVE_UP_LABEL,
  giveUpBody,
  RESOLVE_LABEL,
  RESOLVE_TITLE,
  resolveBody,
  resolveOutcomeCopy,
  resolvingLine,
  TRY_AGAIN_LABEL,
  takeThereLabel,
} from "@/lib/move/copy";
import {
  giveUpMove,
  type ResolveOutcome,
  type ResolvePorts,
  resolveMove,
  takeWindowToConversation,
} from "@/lib/move/resolver";
import { sessionAgent } from "@/lib/sessions";
import { createLocalLaunch, moveServer } from "./move-launch";

const READY_MS = 10_000;

/** A host's file as text, read over the resolver's own channel. */
async function readText(client: CarrierClient, path: string, limit: number) {
  if (!(client instanceof HostControlClient)) return null;
  const head = await client.readHead(path, limit, { timeoutMs: READY_MS });
  return new TextDecoder().decode(head.bytes);
}

/**
 * Resolve a move that did not finish, from any device: the source's own
 * record of the move and the target's say whether it arrived, and the move
 * is finished or put back accordingly (`lib/move/resolver.ts`). A host
 * that cannot be reached cannot say; the person may give the move up, and
 * the conversation waits where it is — set aside on the source, or on the
 * host it was going to — until a Resolve reaches both.
 *
 * `session` is the moving window, or null for a transfer the host's page
 * found with no window moving (`transferId` names it).
 */
export function MoveResolveDialog({
  open,
  onOpenChange,
  session,
  source,
  transferId,
  targetCwd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session | null;
  source: Host;
  transferId?: string;
  /** The folder the mover picked, when this browser heard it. */
  targetCwd?: string | null;
}) {
  const queryClient = useQueryClient();
  const connections = useDaemonConnections();
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 30_000 });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ResolveOutcome | null>(null);
  const [targetName, setTargetName] = useState<string | null>(null);

  const hostById = (id: string) => {
    const host = hostsQ.data?.find((item) => item.id === id);
    return host ? { hostId: host.id, name: host.name, os: host.os ?? null } : null;
  };

  type Choice = "resolve" | "give_up" | "take_there";

  const run = async (choice: Choice) => {
    setBusy(true);
    const opened: HostControlClient[] = [];
    try {
      if (choice === "give_up" && session) {
        setOutcome(
          await giveUpMove(
            { sessionId: session.id, source: { hostId: source.id, name: source.name, os: null } },
            moveServer,
          ),
        );
        return;
      }
      const definitions = await queryClient
        .ensureQueryData({ queryKey: ["agents"], queryFn: agentsApi.list })
        .catch(() => []);
      const agent = (session ? sessionAgent(session, definitions) : null) ?? {
        kind: "claude-code",
        command: "claude",
        env: {},
      };
      const launch = createLocalLaunch(queryClient);
      const ports: ResolvePorts = {
        server: moveServer,
        host: async (hostId) => {
          const connection = connections.get(hostId);
          if (!connection || connection.getSnapshot().state !== "ready")
            throw new Error("not connected");
          const client = new HostControlClient(hostId, { sharedConnection: connection });
          opened.push(client);
          await client.waitUntilReady(READY_MS);
          return client;
        },
        readText,
        launcher: {
          prepareOn: (hostId, plan) => {
            const target = hostById(hostId);
            return launch.prepare(
              {
                sessionId: session?.id ?? "",
                targetHostId: hostId,
                targetName: target?.name ?? "",
                targetCwd: targetCwd ?? session?.cwd ?? "~",
              },
              plan,
            );
          },
          abandon: () => {
            if (session) launch.abandon(session.id);
          },
          restartOnSource: async () => {
            if (!session) return;
            await launch.restartOnSource({
              sessionId: session.id,
              conversationId: session.agent_session_id ?? "",
            });
          },
          refetch: () => launch.refetch(),
        },
      };
      if (choice === "take_there" && session && outcome?.kind === "on_target") {
        const target = hostById(outcome.targetHostId);
        if (!target) return;
        setOutcome(
          await takeWindowToConversation(
            {
              sessionId: session.id,
              source: { hostId: source.id, name: source.name, os: source.os ?? null },
              agent,
              target,
              cwd: outcome.cwd,
              conversationId: outcome.conversationId,
            },
            ports,
          ),
        );
        return;
      }
      const result = await resolveMove(
        {
          sessionId: session?.id ?? "",
          source: { hostId: source.id, name: source.name, os: source.os ?? null },
          hostById: (id) => {
            const host = hostById(id);
            if (host) setTargetName(host.name);
            return host;
          },
          cwd: session?.cwd ?? "~",
          targetCwd: targetCwd ?? null,
          agent,
          serverMoving: session?.status === "moving",
          ...(transferId ? { transferId } : {}),
          windowOf: (id) => {
            const named = queryClient
              .getQueryData<Session[]>(["sessions"])
              ?.find((item) => item.id === id);
            return named ? { cwd: named.cwd, moving: named.status === "moving" } : null;
          },
        },
        ports,
      );
      setOutcome(result);
    } finally {
      for (const client of opened) client.close();
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  };

  // A host that cannot answer — gone for good, or only away — always leaves
  // a way out: give the move up without it.
  const unreachable =
    outcome?.kind === "source_unreachable" || outcome?.kind === "target_unreachable";

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setOutcome(null);
      setTargetName(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="sm" aria-describedby="move-resolve-body">
        <DialogHeader>
          <DialogTitle>{RESOLVE_TITLE}</DialogTitle>
          <DialogDescription id="move-resolve-body">
            {outcome
              ? resolveOutcomeCopy(outcome, { source: source.name, target: targetName })
              : busy
                ? resolvingLine(source.name)
                : resolveBody(source.name)}
          </DialogDescription>
        </DialogHeader>
        {outcome?.kind === "put_back" && outcome.conflicts && (
          <p role="alert" className="px-4 pb-2 text-xs text-warning">
            {conflictsLine(source.name)}
          </p>
        )}
        {unreachable && session?.status === "moving" && (
          <p className="px-4 pb-2 text-xs text-muted-foreground">
            {giveUpBody(source.name, targetName)}
          </p>
        )}
        <DialogFooter>
          {busy && <Spinner size={14} />}
          {outcome ? (
            <>
              {unreachable && session?.status === "moving" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run("give_up")}
                >
                  {GIVE_UP_LABEL}
                </Button>
              )}
              {(unreachable || outcome.kind === "source_busy" || outcome.kind === "failed") && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run("resolve")}
                >
                  {outcome.kind === "source_busy" || outcome.kind === "failed"
                    ? TRY_AGAIN_LABEL
                    : RESOLVE_LABEL}
                </Button>
              )}
              {outcome.kind === "on_target" && session && hostById(outcome.targetHostId) && (
                <Button size="sm" disabled={busy} onClick={() => void run("take_there")}>
                  {takeThereLabel(hostById(outcome.targetHostId)?.name ?? "")}
                </Button>
              )}
              <Button
                size="sm"
                variant={outcome.kind === "on_target" ? "outline" : "default"}
                disabled={busy}
                onClick={() => close(false)}
              >
                {DISMISS_LABEL}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => close(false)}>
                {CANCEL_LABEL}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void run("resolve")}>
                {RESOLVE_LABEL}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
