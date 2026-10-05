import {
  createPendingLaunchStore,
  type PendingLaunchStore,
} from "@/components/launcher/pending-launch";
import type { NoteDelivery } from "@/data/selectors/agent-relaunch";
import { secureStorage } from "@/lib/secure-storage";

/**
 * What a moved window still owes its agent once the resume line has gone
 * out: the move note — typed into Claude Code's prompt once it is ready
 * (sent, or left for the person's next message), or already on the line as
 * its first prompt — and the words its banners use while the agent comes
 * up. It sits beside the resume line in the durable pending-launch store's
 * sibling records: the same incarnation (`${sessionId}@${hostId}`), the same
 * 15-minute lapse, delivered at most once (the claim is written before a key
 * is typed). Like the resume line it rides with, it is written provisional
 * before the move's commit and typable only once the commit has answered.
 * Nothing in it is the conversation's: the note is composed on this device
 * from the hosts' names, OS and the target's own replies.
 */
export interface MoveArrival {
  readonly version: 1;
  /** The agent's name as people read it ("Claude Code"), for the banners. */
  readonly agent: string;
  readonly to: string;
  readonly from: string;
  /** The folder it continues in, as the banners name it. */
  readonly cwd: string;
  /** The note and how it reaches the agent; null for none. */
  readonly note: { readonly text: string; readonly delivery: NoteDelivery } | null;
  /** The resume line, retyped by "Try again" after "No conversation found". */
  readonly line: string;
}

const DELIVERIES: ReadonlySet<string> = new Set(["positional", "typed", "typed_no_enter"]);

export function encodeMoveArrival(arrival: MoveArrival): string {
  return JSON.stringify(arrival);
}

export function decodeMoveArrival(raw: string): MoveArrival | null {
  try {
    const value = JSON.parse(raw) as Partial<MoveArrival> | null;
    if (
      value?.version !== 1 ||
      typeof value.agent !== "string" ||
      typeof value.to !== "string" ||
      typeof value.from !== "string" ||
      typeof value.cwd !== "string" ||
      typeof value.line !== "string"
    ) {
      return null;
    }
    const note = value.note;
    if (
      note !== null &&
      (typeof note !== "object" ||
        typeof note?.text !== "string" ||
        typeof note.delivery !== "string" ||
        !DELIVERIES.has(note.delivery))
    ) {
      return null;
    }
    return {
      version: 1,
      agent: value.agent,
      to: value.to,
      from: value.from,
      cwd: value.cwd,
      note: note ? { text: note.text, delivery: note.delivery } : null,
      line: value.line,
    };
  } catch {
    return null;
  }
}

export function createPendingAgentInputStore(
  storage: Parameters<typeof createPendingLaunchStore>[0],
  options: { now?: () => number; ttlMs?: number } = {},
): PendingLaunchStore {
  return createPendingLaunchStore(storage, { ...options, prefix: "spawn.pendingAgentInput" });
}

let store: PendingLaunchStore | null = null;
const instance = () => {
  store ??= createPendingAgentInputStore(secureStorage);
  return store;
};

/** The app's store, made on first use. */
export const pendingAgentInputs: PendingLaunchStore = {
  persist: (sessionId, hostId, command, options) =>
    instance().persist(sessionId, hostId, command, options),
  confirm: (sessionId, hostId) => instance().confirm?.(sessionId, hostId) ?? Promise.resolve(),
  discard: (sessionId, hostId) => instance().discard?.(sessionId, hostId) ?? Promise.resolve(),
  take: (sessionId, hostId) => instance().take(sessionId, hostId),
  observe: (sessionId, hostId) => instance().observe?.(sessionId, hostId) ?? Promise.resolve(),
  complete: (sessionId) => instance().complete?.(sessionId) ?? Promise.resolve(),
  abandon: (sessionId) => instance().abandon?.(sessionId) ?? Promise.resolve(),
  clear: (sessionId) => instance().clear(sessionId),
};
