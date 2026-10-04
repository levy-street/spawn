import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { formatFileSize } from "@/components/files/format";
import type { HostOfferSlotProps } from "@/components/hosts/cockpit/host-offer-slots";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { createMoveDeps, moveHostOf } from "@/components/workspace-detail/move-channels";
import type { MoveHost } from "@/components/workspace-detail/move-conversation";
import * as copy from "@/components/workspace-detail/move-copy";
import { settleIncoming, settleLeftover } from "@/components/workspace-detail/move-resolve";
import { useResolveMove } from "@/components/workspace-detail/use-resolve-move";
import { listAgents } from "@/data/api/endpoints/agents";
import { listHosts } from "@/data/api/endpoints/hosts";
import { listSessions } from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import { isMovingSession, sessionTitle } from "@/data/selectors/session";
import { moveUnderWay, useMovesStore } from "@/data/stores/moves";
import type { Session } from "@/data/types/domain";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import {
  CONVERSATION_CARRIER_CAPABILITY,
  type ConversationTransfers,
  type IncomingConversationTransfer,
  type OutgoingConversationTransfer,
} from "@/terminal/transport/conversation-codec";
import type {
  HostTransport,
  StreamingHostTransport,
  TransportState,
} from "@/terminal/transport/types";
import { sizing } from "@/theme/sizing";

/** What Resolve on a row acts on, asked first. */
export type UnfinishedTarget =
  /** A window of this host the server has moving: `resolveMove`. */
  | { readonly kind: "window"; readonly session: Session }
  /** A transfer this host set aside whose window no longer reads moving. */
  | { readonly kind: "leftover"; readonly transfer: OutgoingConversationTransfer }
  /** Staging this host holds for another: its source decides. */
  | { readonly kind: "incoming"; readonly transfer: IncomingConversationTransfer };

export interface UnfinishedRow {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string | null;
  /** Null while this phone is carrying the move: under way, not unfinished. */
  readonly target: UnfinishedTarget | null;
}

/**
 * The host page's unfinished moves, in the browser's four kinds: a
 * conversation moving to another host, one arriving from another, one that
 * could not be put back whole, and a window the server has moving with no
 * transfer here yet.
 */
export function unfinishedMoveRows({
  hostId,
  transfers,
  sessions,
  underWay,
  hostName,
  windowTitle,
}: {
  hostId: string;
  transfers: ConversationTransfers | null;
  sessions: readonly Session[];
  /** Transfer and window ids of the moves this phone is carrying now. */
  underWay: ReadonlySet<string>;
  hostName: (id: string | null) => string;
  windowTitle: (session: Session) => string;
}): UnfinishedRow[] {
  const sessionById = (id: string | null) =>
    (id && sessions.find((session) => session.id === id)) || null;
  const mine = (...keys: (string | null)[]) => keys.some((key) => key && underWay.has(key));
  const rows: UnfinishedRow[] = [];
  const covered = new Set<string>();
  for (const transfer of transfers?.outgoing ?? []) {
    const session = sessionById(transfer.sessionId);
    if (session) covered.add(session.id);
    const moving =
      session && isMovingSession(session) && session.host_id === hostId ? session : null;
    const short = copy.moveShortConversation(transfer.conversationId);
    rows.push({
      key: transfer.transferId,
      title:
        transfer.state === "stranded"
          ? copy.moveStrandedRow(short)
          : copy.moveOutgoingRow(short, hostName(transfer.toHostId)),
      subtitle: transfer.length !== null ? formatFileSize(transfer.length) : null,
      target: mine(transfer.transferId, transfer.sessionId)
        ? null
        : moving
          ? { kind: "window", session: moving }
          : { kind: "leftover", transfer },
    });
  }
  for (const transfer of transfers?.incoming ?? []) {
    if (transfer.state === "committed") continue;
    rows.push({
      key: transfer.transferId,
      title: copy.moveIncomingRow(
        copy.moveShortConversation(transfer.conversationId),
        hostName(transfer.fromHostId),
      ),
      subtitle: transfer.length !== null ? formatFileSize(transfer.length) : null,
      target: mine(transfer.transferId) ? null : { kind: "incoming", transfer },
    });
  }
  for (const session of sessions) {
    if (session.host_id !== hostId || !isMovingSession(session) || covered.has(session.id)) {
      continue;
    }
    rows.push({
      key: session.id,
      title: copy.moveMovingWindowRow(windowTitle(session)),
      subtitle: null,
      target: mine(session.id) ? null : { kind: "window", session },
    });
  }
  return rows;
}

/**
 * The host page's Unfinished moves (slot `moves`), from the host's own records
 * (`conv.transfers`): conversations it is the source of and has set aside,
 * ones it is staging for another host, and windows of this host the server
 * still has moving with no transfer here yet. Each can be resolved from here
 * — asked first, then finished where the other end committed or put back —
 * except a move this phone is carrying right now, which is not unfinished
 * but under way. Shown only when there is something to resolve, over a
 * channel held only while the page is on screen. The browser lists the same
 * rows (web/src/components/hosts/cockpit/unfinished-moves.tsx).
 */
export function UnfinishedMovesPanel({ host }: HostOfferSlotProps): React.JSX.Element | null {
  const client = useQueryClient();
  const [transport, setTransport] = useState<HostTransport | null>(null);
  const [state, setState] = useState<TransportState>("idle");
  const [transfers, setTransfers] = useState<ConversationTransfers | null>(null);
  const hosts = useQuery({ queryKey: qk.hosts(), queryFn: listHosts });
  const agents = useQuery({ queryKey: qk.agents(), queryFn: listAgents });
  const sessions = useQuery({ queryKey: qk.sessions(), queryFn: () => listSessions() });
  const moves = useMovesStore((store) => store.moves);
  const deps = useMemo(() => createMoveDeps(client, agents.data ?? []), [agents.data, client]);
  const hostMap = useMemo(
    () => new Map<string, MoveHost>((hosts.data ?? []).map((item) => [item.id, moveHostOf(item)])),
    [hosts.data],
  );
  const channel =
    state === "ready" && transport?.hasCapability?.(CONVERSATION_CARRIER_CAPABILITY)
      ? (transport as StreamingHostTransport)
      : null;

  const refresh = useCallback(async () => {
    if (!channel) return;
    setTransfers(await channel.conversationTransfers().catch(() => null));
  }, [channel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolver = useResolveMove({
    agents: agents.data ?? [],
    hosts: hosts.data ?? [],
    deps,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.sessions() });
      void refresh();
    },
  });

  const name = (id: string | null) => (id ? hostMap.get(id)?.name : null) ?? copy.MOVE_ANOTHER_HOST;
  // A move this phone is carrying now is under way, not unfinished.
  const underWay = new Set(
    Object.values(moves)
      .filter((entry) => moveUnderWay(entry.phase))
      .flatMap((entry) => [entry.run.transferId, entry.run.sessionId]),
  );

  /** A transfer whose window no longer reads "moving" from here. */
  const leftover = (transfer: OutgoingConversationTransfer) => {
    if (!channel) return;
    resolver.openTask({
      sourceName: host.name,
      session: null,
      work: async () => {
        const outcome = await settleLeftover(
          transfer,
          { channel, release: () => undefined },
          hostMap,
          deps,
          host.name,
        );
        void refresh();
        return outcome;
      },
    });
  };

  /** Staging for another host: its source decides (`settleIncoming`). */
  const incoming = (transfer: IncomingConversationTransfer) => {
    if (!channel) return;
    resolver.openTask({
      sourceName: name(transfer.fromHostId),
      session: null,
      work: async () => {
        try {
          return await settleIncoming(transfer, channel, hostMap, deps);
        } finally {
          void refresh();
        }
      },
    });
  };

  const rows = unfinishedMoveRows({
    hostId: host.id,
    transfers,
    sessions: sessions.data ?? [],
    underWay,
    hostName: name,
    windowTitle: (session) => sessionTitle(session, agents.data ?? []),
  });
  const resolve = (target: UnfinishedTarget) => {
    if (target.kind === "window") resolver.open(target.session);
    else if (target.kind === "leftover") leftover(target.transfer);
    else incoming(target.transfer);
  };

  const surface = host.host_public_key ? (
    <HostTransportSurface
      hostId={host.id}
      hostIdentityPublicKey={host.host_public_key}
      onStateChange={setState}
      onTransport={setTransport}
    />
  ) : null;
  if (rows.length === 0) {
    return (
      <>
        {surface}
        {resolver.sheet}
      </>
    );
  }

  return (
    <View style={styles.panel} testID="host-unfinished-moves">
      {surface}
      <SectionHeader title={copy.MOVE_UNFINISHED_TITLE} />
      {rows.map((row) => (
        <ListRow
          key={row.key}
          {...(row.subtitle ? { subtitle: row.subtitle } : {})}
          title={row.title}
          {...(row.target
            ? {
                trailing: (
                  <Button
                    onPress={() => {
                      if (row.target) resolve(row.target);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {copy.MOVE_RESOLVE}
                  </Button>
                ),
              }
            : {})}
        />
      ))}
      {resolver.sheet}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: sizing.space.tight,
  },
});
