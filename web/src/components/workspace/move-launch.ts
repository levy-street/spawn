"use client";

import type { QueryClient } from "@tanstack/react-query";
import { incarnationKey, openIntent } from "@/components/terminal/incarnation";
import { agents as agentsApi, sessions } from "@/lib/api";
import { HostControlClient } from "@/lib/hostControl";
import type { CarrierClient } from "@/lib/move/conv";
import type { LocalLaunch } from "@/lib/move/move-hub";
import { pendingNote } from "@/lib/move/note-delivery";
import type { MoveServerPort } from "@/lib/move/server";
import { displayPath } from "@/lib/places";
import { restartSessionAgent } from "./agent-restart";
import { pendingLaunch } from "./pending-launch";

/** The server's move routes, as the orchestrator and the resolver call them. */
export const moveServer: MoveServerPort = {
  begin: (id, expected) => sessions.moveBegin(id, expected),
  commit: (id, body) => sessions.move(id, body),
  abort: (id, expected) => sessions.moveAbort(id, expected),
  get: (id) => sessions.get(id),
  fresh: (id, body) => sessions.move(id, body),
};

/** How long a host has to answer a read of a small file. */
const READ_MS = 10_000;

/** A host's file as text, read over a move's or a resolver's own channel. */
export async function readHostText(
  client: CarrierClient,
  path: string,
  limit: number,
): Promise<string | null> {
  if (!(client instanceof HostControlClient)) return null;
  const head = await client.readHead(path, limit, { timeoutMs: READ_MS });
  return new TextDecoder().decode(head.bytes);
}

/**
 * What this tab queues for one of its windows after a move, so its terminal
 * on the new host types it: the mover's claim on the new incarnation
 * (`openIntent`), the relaunch line (`pendingLaunch.claim`), and the note
 * with the names its banners use (`pendingNote`). Put back, the window is
 * restarted on the host it never left with the line that resumes the
 * conversation that was moving, in the mode its record carries there
 * (`put-back.ts`).
 *
 * Whoever settles a move leaves the window running its agent: the line is
 * claimed, so this tab's view of the window takes the display to type it even
 * while another device is looking at the window. Where this tab has no view
 * of the window (a host's page), it is typed when the window is opened here.
 */
export function createLocalLaunch(queryClient: QueryClient): LocalLaunch {
  const targets = new Map<string, string>();
  return {
    prepare: async (record, plan) => {
      // A read that left before the commit must not put the window back
      // on the host it is leaving when it lands after it.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["sessions"] }),
        queryClient.cancelQueries({ queryKey: ["session", record.sessionId], exact: true }),
      ]);
      // Before the commit: this tab can hear of the move before the
      // commit's own answer, and the terminal that mounts for the target
      // then must take control, not follow.
      openIntent.mark(incarnationKey(record.sessionId, record.targetHostId));
      targets.set(record.sessionId, record.targetHostId);
      if (!plan) return;
      pendingLaunch.claim(record.sessionId, record.targetHostId, plan.line);
      if (plan.note)
        pendingNote.set(record.sessionId, {
          hostId: record.targetHostId,
          text: plan.note.text,
          delivery: plan.note.delivery,
          line: plan.line,
          target: record.targetName,
          cwd: displayPath(record.targetCwd),
        });
    },
    abandon: (sessionId) => {
      pendingLaunch.clear(sessionId);
      pendingNote.clear(sessionId);
      const host = targets.get(sessionId);
      if (host) openIntent.clear(incarnationKey(sessionId, host));
      targets.delete(sessionId);
    },
    restartOnSource: async (record, line) => {
      if (line) {
        // Queued before the restart, as a restart queues its own: the new
        // shell's first keystrokes are the line, and a restart that never
        // happened leaves nothing behind.
        pendingLaunch.claim(record.sessionId, record.sourceHostId, line);
        try {
          const saved = await sessions.restart(record.sessionId);
          queryClient.setQueryData(["session", record.sessionId], saved);
        } catch (error) {
          pendingLaunch.clear(record.sessionId);
          throw error;
        } finally {
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        }
        return;
      }
      const [session, definitions] = await Promise.all([
        sessions.get(record.sessionId),
        queryClient
          .ensureQueryData({ queryKey: ["agents"], queryFn: agentsApi.list })
          .catch(() => []),
      ]);
      await restartSessionAgent({
        session,
        agents: definitions,
        // The conversation that was being moved: the one to come back to.
        inspect: async () => ({
          agent: "claude-code",
          conversation_id: record.conversationId,
          state: "idle",
          cli_version: null,
          live_elsewhere: false,
          source: "move",
        }),
        restart: async () => {
          const saved = await sessions.restart(record.sessionId);
          queryClient.setQueryData(["session", record.sessionId], saved);
          return saved;
        },
        claimDisplay: true,
      });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    refetch: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  };
}
