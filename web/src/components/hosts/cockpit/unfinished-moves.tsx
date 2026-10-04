"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useDaemonConnection } from "@/components/hosts/DaemonConnectionsProvider";
import { Button } from "@/components/ui/button";
import { MoveResolveDialog } from "@/components/workspace/move-resolve-dialog";
import { useMovesList } from "@/components/workspace/moves-provider";
import { type Host, hosts, type Session, sessions } from "@/lib/api";
import { HostControlClient } from "@/lib/hostControl";
import { type ConversationTransfers, listTransfers } from "@/lib/move/conv";
import {
  ANOTHER_HOST,
  incomingMoveRow,
  movingElsewhereLine,
  outgoingMoveRow,
  RESOLVE_LABEL,
  shortConversation,
  strandedMoveRow,
  UNFINISHED_MOVES_HEADING,
} from "@/lib/move/copy";
import { sessionMoving, sessionTitle } from "@/lib/sessions";
import { CockpitSection } from "./cockpit-section";

const READY_MS = 10_000;

interface Row {
  key: string;
  label: string;
  /** Who is asked to resolve it: the move's source. */
  source: Host | null;
  session: Session | null;
  transferId?: string;
}

/**
 * Moves that did not finish, as this host keeps them (`conv.transfers`): the
 * conversations it is sending and still holds aside, and those it is taking
 * in. Each can be resolved from here, whoever started it; so can a window of
 * this host the server still has moving with no transfer here yet — except
 * a move this browser is carrying right now, which is not unfinished but
 * under way: resolving it would tear it down. Draws nothing when there is
 * nothing unfinished, but for a Resolve that has just settled the last row:
 * its outcome is said all the same (`MoveResolveDialog`, `inPane` false).
 */
export function UnfinishedMoves({ host }: { host: Host }) {
  const connection = useDaemonConnection(host.id);
  const ready = connection?.getSnapshot().state === "ready";
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 30_000 });
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: () => sessions.list(),
    staleTime: 5_000,
  });
  const movingHere = (sessionsQ.data ?? []).filter(
    (session) => session.host_id === host.id && sessionMoving(session),
  );
  const [transfers, setTransfers] = useState<ConversationTransfers | null>(null);
  const [round, setRound] = useState(0);
  const [resolving, setResolving] = useState<Row | null>(null);
  const underWay = new Set(
    useMovesList()
      .filter((move) => !move.lost && move.view.phase !== "moved" && move.view.phase !== "ended")
      .flatMap((move) => [move.transferId, move.sessionId]),
  );
  const movingKey = movingHere.map((session) => session.id).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when a move here starts or ends, or after a Resolve.
  useEffect(() => {
    if (!connection || !ready) return;
    let cancelled = false;
    const client = new HostControlClient(host.id, { sharedConnection: connection });
    void (async () => {
      try {
        await client.waitUntilReady(READY_MS);
        const listed = await listTransfers(client);
        if (!cancelled) setTransfers(listed);
      } catch {
        // Nothing to show is the honest answer when the host cannot say.
      } finally {
        client.close();
      }
    })();
    return () => {
      cancelled = true;
      client.close();
    };
  }, [connection, ready, host.id, movingKey, round]);

  const hostById = (id: string | null) =>
    (id && hostsQ.data?.find((item) => item.id === id)) || null;
  const sessionById = (id: string | null) =>
    (id && sessionsQ.data?.find((session) => session.id === id)) || null;

  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const outgoing of transfers?.outgoing ?? []) {
    const session = sessionById(outgoing.sessionId);
    if (session) covered.add(session.id);
    rows.push({
      key: outgoing.transferId,
      label:
        outgoing.state === "stranded"
          ? strandedMoveRow(shortConversation(outgoing.conversationId))
          : outgoingMoveRow(
              shortConversation(outgoing.conversationId),
              hostById(outgoing.toHostId)?.name ?? ANOTHER_HOST,
            ),
      source: host,
      session,
      transferId: outgoing.transferId,
    });
  }
  for (const incoming of transfers?.incoming ?? []) {
    const source = hostById(incoming.fromHostId);
    rows.push({
      key: incoming.transferId,
      label: incomingMoveRow(
        shortConversation(incoming.conversationId),
        source?.name ?? ANOTHER_HOST,
      ),
      source,
      session: null,
      transferId: incoming.transferId,
    });
  }
  for (const session of movingHere) {
    if (covered.has(session.id)) continue;
    rows.push({
      key: session.id,
      label: `${sessionTitle(session)} · ${movingElsewhereLine(null)}`,
      source: host,
      session,
    });
  }
  // Mounted on its own, outside the rows: settling a move takes its row away,
  // and the dialog says how it ended (or still asks for something) after.
  const dialog = resolving?.source ? (
    <MoveResolveDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        setResolving(null);
        setRound((n) => n + 1);
      }}
      session={resolving.session}
      source={resolving.source}
      inPane={false}
      {...(resolving.transferId ? { transferId: resolving.transferId } : {})}
    />
  ) : null;
  if (rows.length === 0) return dialog;

  return (
    <CockpitSection
      id={`host-moves-${host.id}`}
      title={UNFINISHED_MOVES_HEADING}
      count={rows.length}
      className="@4xl/shell:col-span-2"
    >
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-3 px-4 py-3 text-sm">
            <ArrowRightLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.source &&
              !underWay.has(row.transferId ?? "") &&
              !underWay.has(row.session?.id ?? "") && (
                <Button variant="outline" size="sm" onClick={() => setResolving(row)}>
                  {RESOLVE_LABEL}
                </Button>
              )}
          </li>
        ))}
      </ul>
      {dialog}
    </CockpitSection>
  );
}
