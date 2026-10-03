import { CONVERSATION_CAPABILITY, type ConversationInspection } from "@/lib/conversation";
import type { DaemonConnection } from "@/lib/daemon-connection";
import {
  AGENT_TRANSCRIPTS_OP,
  type AgentTranscriptQuery,
  type AgentTranscriptReport,
  HostControlClient,
} from "@/lib/hostControl";

/** The part of a host-control client a restart's questions need. */
export type InspectingClient = Pick<
  HostControlClient,
  "waitUntilReady" | "hasCapability" | "inspectConversation" | "agentTranscripts" | "close"
>;

/** How long a restart waits on the host before carrying on without it: so
 *  long for the channel to open, then so long for everything it asks there. */
const INSPECT_CONNECT_TIMEOUT_MS = 4_000;
const INSPECT_REQUEST_TIMEOUT_MS = 4_000;

/** What a restart asks a window's host (`restartSessionAgent`'s hooks). */
export interface WindowHostQuestions {
  /** Which conversation the window is in (`conv.inspect`). */
  inspect: () => Promise<ConversationInspection | null>;
  /** The host's records of one conversation (`agent.transcripts`). */
  transcripts: (query: AgentTranscriptQuery) => Promise<AgentTranscriptReport | null>;
  /** Lets the channel go; nothing is asked after it. */
  doneAsking: () => void;
}

/**
 * Ask a window's host what a restart needs to know, on one host-control
 * channel of the device's shared connection: opened by the first question,
 * closed by `doneAsking`. Every question after the channel opens shares one
 * budget, so asking the second never makes a restart wait longer than asking
 * the first alone did. Each answer is null whenever it is not to be had — no
 * ready connection, a daemon without the operation, the budget spent, an
 * error — so the caller falls back to what it had.
 */
export function askWindowHost(
  hostId: string,
  connection: DaemonConnection | null,
  sessionId: string,
  {
    openClient = (id, shared) => new HostControlClient(id, { sharedConnection: shared }),
    now = Date.now,
  }: {
    openClient?: (hostId: string, connection: DaemonConnection) => InspectingClient;
    now?: () => number;
  } = {},
): WindowHostQuestions {
  let opening: Promise<InspectingClient | null> | null = null;
  let client: InspectingClient | null = null;
  let deadline = 0;
  let done = false;

  const ready = () => {
    opening ??= (async () => {
      // A restart is often what someone reaches for when the host is unwell:
      // with no live connection to it there is no answer to wait for.
      if (connection?.getSnapshot().state !== "ready") return null;
      const opened = openClient(hostId, connection);
      client = opened;
      try {
        await opened.waitUntilReady(INSPECT_CONNECT_TIMEOUT_MS);
      } catch {
        return null;
      }
      deadline = now() + INSPECT_REQUEST_TIMEOUT_MS;
      return opened;
    })();
    return opening;
  };

  const ask = async <T>(
    operation: string,
    question: (client: InspectingClient, timeoutMs: number) => Promise<T>,
  ): Promise<T | null> => {
    if (done) return null;
    const asked = await ready();
    if (done || !asked?.hasCapability(operation)) return null;
    const left = deadline - now();
    if (left <= 0) return null;
    try {
      return await question(asked, left);
    } catch {
      return null;
    }
  };

  return {
    inspect: () =>
      ask(CONVERSATION_CAPABILITY, (asked, timeoutMs) =>
        asked.inspectConversation(sessionId, { timeoutMs }),
      ),
    transcripts: (query) =>
      ask(AGENT_TRANSCRIPTS_OP, (asked, timeoutMs) => asked.agentTranscripts(query, { timeoutMs })),
    doneAsking: () => {
      done = true;
      client?.close();
    },
  };
}
