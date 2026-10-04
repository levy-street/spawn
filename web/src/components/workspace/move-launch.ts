"use client";

import type { QueryClient } from "@tanstack/react-query";
import { incarnationKey, openIntent } from "@/components/terminal/incarnation";
import { agents as agentsApi, sessions } from "@/lib/api";
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

/**
 * What this tab queues for one of its windows after a move, so its terminal
 * on the new host types it: the mover's claim on the new incarnation
 * (`openIntent`), the relaunch line (`pendingLaunch`), and the note with the
 * names its banners use (`pendingNote`). Put back, the window is restarted
 * on the host it never left, resuming the conversation that was moving.
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
      pendingLaunch.set(record.sessionId, record.targetHostId, plan.line);
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
    restartOnSource: async (record) => {
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
      });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    refetch: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  };
}
