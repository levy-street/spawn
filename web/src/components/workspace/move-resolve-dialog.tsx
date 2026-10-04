"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
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
import { toast } from "@/components/ui/toast";
import { agents as agentsApi, type Host, hosts, type Session, workspaces } from "@/lib/api";
import { HostControlClient } from "@/lib/hostControl";
import {
  CANCEL_LABEL,
  conflictsLine,
  DISMISS_LABEL,
  GIVE_UP_LABEL,
  giveUpBody,
  OPEN_WINDOW_LABEL,
  RESOLVE_LABEL,
  RESOLVE_TITLE,
  resolveBody,
  resolveOutcomeCopy,
  resolveToast,
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
import { sessionAgent, sessionHref } from "@/lib/sessions";
import { createLocalLaunch, moveServer, readHostText } from "./move-launch";
import { pendingLaunch } from "./pending-launch";

const READY_MS = 10_000;

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
 *
 * Whoever settles the move leaves the window running its agent: finished,
 * the resume is queued for the window on its new host; put back, the window
 * is restarted with the line that resumes its conversation, mode explicit.
 * Either is this device's to type, and its view of the window takes the
 * display to type it (`pendingLaunch.claim`). In the window's own pane that
 * view is right here. On a host's page (`inPane` false) there is none: the
 * outcome is a toast, since the row it came from goes with the move, and
 * says that the agent resumes when the window is opened here, with the way
 * to open it.
 */
export function MoveResolveDialog({
  open,
  onOpenChange,
  session,
  source,
  transferId,
  targetCwd,
  inPane = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session | null;
  source: Host;
  transferId?: string;
  /** The folder the mover picked, when this browser heard it. */
  targetCwd?: string | null;
  /** In the window's own pane, whose terminal types what the move owes it.
   *  False on a host's page. */
  inPane?: boolean;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
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
    const settle = (result: ResolveOutcome) => {
      if (!inPane && settledHere(result)) return;
      setOutcome(result);
    };
    try {
      if (choice === "give_up" && session) {
        settle(
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
        readText: readHostText,
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
          restartOnSource: async (line) => {
            if (!session) return;
            await launch.restartOnSource(
              {
                sessionId: session.id,
                sourceHostId: source.id,
                conversationId: session.agent_session_id ?? "",
              },
              line,
            );
          },
          refetch: () => launch.refetch(),
        },
      };
      if (choice === "take_there" && session && outcome?.kind === "on_target") {
        const target = hostById(outcome.targetHostId);
        if (!target) return;
        settle(
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
          conversationId: session?.agent_session_id ?? null,
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
      settle(result);
    } finally {
      for (const client of opened) client.close();
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  };

  /**
   * On a host's page, an outcome that asks for nothing more is said as a
   * toast and the dialog closes: true when it did. Where this device has the
   * window's resume waiting, the toast offers to open the window, and opening
   * it takes the display and types it.
   */
  const settledHere = (result: ResolveOutcome): boolean => {
    const host =
      result.kind === "finished"
        ? result.targetHostId
        : result.kind === "put_back"
          ? source.id
          : null;
    const waiting = session !== null && host !== null && pendingLaunch.claims(session.id, host);
    const said = resolveToast(
      result,
      {
        source: source.name,
        target:
          result.kind === "finished"
            ? (hostById(result.targetHostId)?.name ?? targetName)
            : targetName,
      },
      waiting,
    );
    if (!said) return false;
    const windowId = session?.id ?? null;
    const openWindow = async () => {
      if (!windowId) return;
      const list = await queryClient
        .ensureQueryData({ queryKey: ["workspaces"], queryFn: () => workspaces.list() })
        .catch(() => []);
      router.push(sessionHref(windowId, list));
    };
    toast(said.message, {
      ...(said.detail ? { detail: said.detail } : {}),
      ...(said.persistent ? { persistent: true } : {}),
      ...(said.openWindow && windowId
        ? {
            actions: [
              {
                label: OPEN_WINDOW_LABEL,
                variant: "primary" as const,
                onClick: () => void openWindow(),
              },
            ],
          }
        : {}),
    });
    onOpenChange(false);
    setOutcome(null);
    setTargetName(null);
    return true;
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
