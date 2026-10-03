import {
  CONVERSATION_CAPABILITY,
  type ConversationInspection,
} from "@/terminal/transport/conversation-codec";
import { createHostConsumerTransport } from "@/terminal/transport/host-transport";
import { retainHostTransport } from "@/terminal/transport/host-transport-registry";

/** How long a restart waits on the host before carrying on without it. */
const INSPECT_OPEN_TIMEOUT_MS = 4_000;
const INSPECT_REQUEST_TIMEOUT_MS = 4_000;

export interface InspectedHost {
  readonly hostId: string;
  readonly hostIdentityPublicKey: string;
}

/**
 * Ask a window's host which conversation it is in, on a consumer channel of
 * the app's retained connection to that host (`DaemonConnections`), opened
 * for this question and closed after. It never takes the connection's worker
 * seat. Null whenever the answer is not to be had — no ready connection, a
 * daemon without `conv.v1`, a timeout, an error — so the caller falls back to
 * what it had.
 */
export async function inspectWindowConversation(
  host: InspectedHost,
  sessionId: string,
): Promise<ConversationInspection | null> {
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
    if (!transport.hasCapability(CONVERSATION_CAPABILITY)) return null;
    return await transport.inspectConversation(sessionId, {
      timeoutMs: INSPECT_REQUEST_TIMEOUT_MS,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    transport.close();
    lease.release();
  }
}
