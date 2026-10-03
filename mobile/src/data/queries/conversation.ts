import type { QueryClient } from "@tanstack/react-query";

import { getHost } from "@/data/api/endpoints/hosts";
import { patchSession } from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import type { Session } from "@/data/types/domain";
import type { ConversationInspection } from "@/terminal/transport/conversation-codec";
import { askWindowHost, type WindowHostQuestions } from "@/terminal/transport/inspect-conversation";
import type { AgentTranscriptQuery, AgentTranscriptReport } from "@/terminal/transport/types";

export interface RestartConversationHooks {
  inspect: () => Promise<ConversationInspection | null>;
  transcripts: (query: AgentTranscriptQuery) => Promise<AgentTranscriptReport | null>;
  doneAsking: () => void;
  recordConversation: (conversationId: string) => Promise<void>;
}

/**
 * What a restart asks the window's host and how it writes the answer back:
 * the hooks `restartSessionAgent` takes. The questions go over this device's
 * own connection to the host, on one channel (`conv.inspect`, then
 * `agent.transcripts` for the id about to be resumed); only a changed Claude
 * Code id the host named is written to the server, as the window's
 * `agent_session_id` (`restartSessionAgent` decides).
 */
export function restartConversationHooks(
  client: QueryClient,
  session: Pick<Session, "id" | "host_id">,
): RestartConversationHooks {
  let questions: Promise<WindowHostQuestions | null> | null = null;
  let done = false;
  const host = () => {
    questions ??= (async () => {
      const found = await client.ensureQueryData({
        queryKey: qk.host(session.host_id),
        queryFn: () => getHost(session.host_id),
      });
      if (done || !found.host_public_key) return null;
      return askWindowHost(
        { hostId: found.id, hostIdentityPublicKey: found.host_public_key },
        session.id,
      );
    })().catch(() => null);
    return questions;
  };
  return {
    inspect: async () => (await host())?.inspect() ?? null,
    transcripts: async (query) => (await host())?.transcripts(query) ?? null,
    doneAsking: () => {
      done = true;
      void questions?.then((asked) => asked?.doneAsking());
    },
    recordConversation: async (conversationId) => {
      const saved = await patchSession(session.id, { agent_session_id: conversationId });
      client.setQueryData(qk.session(session.id), saved);
    },
  };
}
