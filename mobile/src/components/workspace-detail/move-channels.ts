import type { QueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { restartSessionAgent } from "@/components/launcher/agent-restart";
import { encodeMoveArrival, pendingAgentInputs } from "@/components/launcher/pending-agent-input";
import { pendingLaunches } from "@/components/launcher/pending-launch";
import type {
  MoveChannelLease,
  MoveChannels,
  MoveDeps,
  MoveHost,
} from "@/components/workspace-detail/move-conversation";
import { ApiError } from "@/data/api/client";
import {
  abortSessionMove,
  beginSessionMove,
  getSession,
  moveSession,
  restartSession,
} from "@/data/api/endpoints/sessions";
import { restartConversationHooks } from "@/data/queries/conversation";
import { qk } from "@/data/queryKeys";
import type { AgentDef, Host, Session } from "@/data/types/domain";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-error";
import { createHostConsumerTransport } from "@/terminal/transport/host-transport";
import { retainHostTransport } from "@/terminal/transport/host-transport-registry";
import type { TransportState } from "@/terminal/transport/types";

/** How long a move waits for a host's connection, then for its channel. */
const ROOT_READY_TIMEOUT_MS = 8_000;
const CHANNEL_OPEN_TIMEOUT_MS = 10_000;

export function moveHostOf(host: Pick<Host, "id" | "name" | "os" | "host_public_key">): MoveHost {
  return { id: host.id, name: host.name, os: host.os, publicKey: host.host_public_key };
}

function waitFor(
  transport: {
    readonly state: TransportState;
    on(ev: "state", fn: (s: TransportState) => void): () => void;
  },
  ready: (state: TransportState) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (ready(transport.state)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const finish = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = transport.on("state", (state) => {
      if (ready(state)) finish(true);
      else if (state === "failed" || state === "closed") finish(false);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A move's channels: one tool channel per host on the connection the app
 * already holds to it (`DaemonConnections`), never its worker seat. A host
 * whose connection is not up within a few seconds is offline as far as a
 * move is concerned.
 */
export function createMoveChannels(): MoveChannels {
  return {
    async open(host, signal): Promise<MoveChannelLease> {
      if (!host.publicKey) {
        throw new HostControlTransportError("host_unreachable", "The host has no identity key.");
      }
      const lease = retainHostTransport(
        { hostId: host.id, hostIdentityPublicKey: host.publicKey },
        false,
      );
      const root = lease.shared.transport;
      const up = await waitFor(root, (state) => state === "ready", ROOT_READY_TIMEOUT_MS, signal);
      if (!up) {
        lease.release();
        throw new HostControlTransportError("host_unreachable", "The host is not connected.");
      }
      const channel = createHostConsumerTransport(
        { hostId: host.id, hostIdentityPublicKey: host.publicKey, bridge: lease.shared.bridge },
        root,
      );
      const release = () => {
        channel.close();
        lease.release();
      };
      try {
        await Promise.race([
          channel.open(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new HostControlTransportError("host_unreachable", "No channel.")),
              CHANNEL_OPEN_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (error) {
        release();
        throw error;
      }
      return { channel, release };
    },
  };
}

/** Everything the orchestrator and the resolver reach outside themselves. */
export function createMoveDeps(client: QueryClient, agents: readonly AgentDef[]): MoveDeps {
  const remember = (session: Session) => {
    client.setQueryData(qk.session(session.id), session);
    client.setQueryData<Session[]>(qk.sessions(), (current) =>
      current?.map((item) => (item.id === session.id ? session : item)),
    );
    return session;
  };
  return {
    channels: createMoveChannels(),
    server: {
      begin: async (sessionId, expected) => remember(await beginSessionMove(sessionId, expected)),
      commit: async (sessionId, body) => remember(await moveSession(sessionId, body)),
      abort: async (sessionId, expected) => remember(await abortSessionMove(sessionId, expected)),
      get: async (sessionId) => {
        try {
          return remember(await getSession(sessionId));
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
    },
    launches: {
      // Provisional until the commit answers: a move that never lands here
      // leaves nothing a later opening of the window could type.
      queue: async (sessionId, hostId, line, arrival) => {
        await pendingAgentInputs.persist(sessionId, hostId, encodeMoveArrival(arrival), {
          provisional: true,
        });
        await pendingLaunches.persist(sessionId, hostId, line, { provisional: true });
      },
      // The note first: by the time the line can be typed, what follows it is.
      confirm: async (sessionId, hostId) => {
        await pendingAgentInputs.confirm?.(sessionId, hostId);
        await pendingLaunches.confirm?.(sessionId, hostId);
      },
      discard: async (sessionId, hostId) => {
        await Promise.allSettled([
          pendingLaunches.discard?.(sessionId, hostId),
          pendingAgentInputs.discard?.(sessionId, hostId),
        ]);
      },
    },
    restart: async (session) =>
      restartSessionAgent({
        session,
        agents,
        restart: async (sessionId) => remember(await restartSession(sessionId)),
        pending: pendingLaunches,
        ...restartConversationHooks(client, session),
      }),
    newTransferId: () => randomUUID().toLowerCase(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
