import {
  CONVERSATION_CAPABILITY,
  type ConversationInspection,
} from "@/terminal/transport/conversation-codec";
import { AGENT_TRANSCRIPTS_OP } from "@/terminal/transport/host-ctl-codec";
import { createHostConsumerTransport } from "@/terminal/transport/host-transport";
import { retainHostTransport } from "@/terminal/transport/host-transport-registry";
import type {
  AgentTranscriptQuery,
  AgentTranscriptReport,
  StreamingHostTransport,
} from "@/terminal/transport/types";

/** How long a restart waits on the host before carrying on without it: so
 *  long for the channel to open, then so long for everything it asks there. */
const INSPECT_OPEN_TIMEOUT_MS = 4_000;
const INSPECT_REQUEST_TIMEOUT_MS = 4_000;

export interface InspectedHost {
  readonly hostId: string;
  readonly hostIdentityPublicKey: string;
}

/** What a restart asks a window's host (`restartSessionAgent`'s hooks). */
export interface WindowHostQuestions {
  /** Which conversation the window is in (`conv.inspect`). */
  inspect: () => Promise<ConversationInspection | null>;
  /** The host's records of one conversation (`agent.transcripts`). */
  transcripts: (query: AgentTranscriptQuery) => Promise<AgentTranscriptReport | null>;
  /** Lets the channel and the connection go; nothing is asked after it. */
  doneAsking: () => void;
}

/**
 * Ask a window's host what a restart needs to know, on one consumer channel
 * of the app's retained connection to that host (`DaemonConnections`):
 * opened by the first question, closed by `doneAsking`. It never takes the
 * connection's worker seat. Every question after the channel opens shares one
 * budget, so asking the second never makes a restart wait longer than asking
 * the first alone did. Each answer is null whenever it is not to be had — no
 * ready connection, a daemon without the operation, the budget spent, an
 * error — so the caller falls back to what it had.
 */
export function askWindowHost(host: InspectedHost, sessionId: string): WindowHostQuestions {
  let opening: Promise<StreamingHostTransport | null> | null = null;
  let release: (() => void) | null = null;
  let deadline = 0;
  let done = false;

  const ready = () => {
    opening ??= (async () => {
      const lease = retainHostTransport(
        { hostId: host.hostId, hostIdentityPublicKey: host.hostIdentityPublicKey },
        false,
      );
      // A restart is often what someone reaches for when the host is unwell:
      // with no live connection to it there is no answer to wait for.
      if (lease.shared.transport.state !== "ready") {
        lease.release();
        return null;
      }
      const transport = createHostConsumerTransport(
        { ...host, bridge: lease.shared.bridge },
        lease.shared.transport,
      );
      release = () => {
        transport.close();
        lease.release();
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          transport.open(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("The host did not answer in time.")),
              INSPECT_OPEN_TIMEOUT_MS,
            );
          }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
      deadline = Date.now() + INSPECT_REQUEST_TIMEOUT_MS;
      return transport;
    })();
    return opening;
  };

  const ask = async <T>(
    operation: string,
    question: (transport: StreamingHostTransport, timeoutMs: number) => Promise<T> | undefined,
  ): Promise<T | null> => {
    if (done) return null;
    const transport = await ready();
    if (done || !transport?.hasCapability(operation)) return null;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    try {
      return (await question(transport, left)) ?? null;
    } catch {
      return null;
    }
  };

  return {
    inspect: () =>
      ask(CONVERSATION_CAPABILITY, (transport, timeoutMs) =>
        transport.inspectConversation(sessionId, { timeoutMs }),
      ),
    transcripts: (query) =>
      ask(AGENT_TRANSCRIPTS_OP, (transport, timeoutMs) =>
        transport.agentTranscripts?.(query, { timeoutMs }),
      ),
    doneAsking: () => {
      done = true;
      const letGo = release;
      release = null;
      letGo?.();
    },
  };
}
