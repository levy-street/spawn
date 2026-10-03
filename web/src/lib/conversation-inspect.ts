import { CONVERSATION_CAPABILITY, type ConversationInspection } from "@/lib/conversation";
import type { DaemonConnection } from "@/lib/daemon-connection";
import { HostControlClient } from "@/lib/hostControl";

/** The part of a host-control client one question needs. */
export type InspectingClient = Pick<
  HostControlClient,
  "waitUntilReady" | "hasCapability" | "inspectConversation" | "close"
>;

/** How long a restart waits on the host before carrying on without it. */
const INSPECT_CONNECT_TIMEOUT_MS = 4_000;
const INSPECT_REQUEST_TIMEOUT_MS = 4_000;

/**
 * Ask a window's host which conversation it is in, on a host-control channel
 * of the device's shared connection opened for this question and closed after.
 * Null whenever the answer is not to be had — no ready connection, a daemon
 * without `conv.v1`, a timeout, an error — so the caller falls back to what it
 * had.
 */
export async function inspectWindowConversation(
  hostId: string,
  connection: DaemonConnection | null,
  sessionId: string,
  openClient: (hostId: string, connection: DaemonConnection) => InspectingClient = (id, shared) =>
    new HostControlClient(id, { sharedConnection: shared }),
): Promise<ConversationInspection | null> {
  // A restart is often what someone reaches for when the host is unwell:
  // with no live connection to it there is no answer to wait for.
  if (connection?.getSnapshot().state !== "ready") return null;
  const client = openClient(hostId, connection);
  try {
    await client.waitUntilReady(INSPECT_CONNECT_TIMEOUT_MS);
    if (!client.hasCapability(CONVERSATION_CAPABILITY)) return null;
    return await client.inspectConversation(sessionId, { timeoutMs: INSPECT_REQUEST_TIMEOUT_MS });
  } catch {
    return null;
  } finally {
    client.close();
  }
}
