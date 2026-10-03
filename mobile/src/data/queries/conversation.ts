import type { QueryClient } from "@tanstack/react-query";

import { getHost } from "@/data/api/endpoints/hosts";
import { patchSession } from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import type { Session } from "@/data/types/domain";
import type { ConversationInspection } from "@/terminal/transport/conversation-codec";
import { inspectWindowConversation } from "@/terminal/transport/inspect-conversation";

export interface RestartConversationHooks {
  inspect: () => Promise<ConversationInspection | null>;
  recordConversation: (conversationId: string) => Promise<void>;
}

/**
 * What a restart asks the window's host and how it writes the answer back:
 * the two hooks `restartSessionAgent` takes. The question goes over this
 * device's own connection to the host (`conv.inspect`); only a changed id is
 * written to the server, as the window's `agent_session_id`.
 */
export function restartConversationHooks(
  client: QueryClient,
  session: Pick<Session, "id" | "host_id">,
): RestartConversationHooks {
  return {
    inspect: async () => {
      const host = await client.ensureQueryData({
        queryKey: qk.host(session.host_id),
        queryFn: () => getHost(session.host_id),
      });
      if (!host.host_public_key) return null;
      return inspectWindowConversation(
        { hostId: host.id, hostIdentityPublicKey: host.host_public_key },
        session.id,
      );
    },
    recordConversation: async (conversationId) => {
      const saved = await patchSession(session.id, { agent_session_id: conversationId });
      client.setQueryData(qk.session(session.id), saved);
    },
  };
}
