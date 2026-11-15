import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  answerWithin,
  CODEX_ANSWER_DEADLINE_MS,
  chooseLaunchCommand,
  deliverQueuedLaunch,
  NO_DAEMON_REFUSAL_WINDOW_MS,
  type QueuedLaunchDelivery,
  type RefusalMoment,
  refusalWatch,
} from "@/components/workspace/launch-delivery";
import { pendingLaunch } from "@/components/workspace/pending-launch";

const SESSION = "33333333-3333-4333-8333-333333333333";
const HOST = "dream";
const launch = { command: "codex resume", codexNoDaemon: "codex --no-daemon resume" };

afterEach(() => pendingLaunch.clear(SESSION));

/** A view of the window: the shared queued-launch store, its own typing. */
function view(
  ask: QueuedLaunchDelivery["ask"],
  canType: () => boolean = () => true,
): { delivery: QueuedLaunchDelivery; typed: string[] } {
  const typed: string[] = [];
  return {
    typed,
    delivery: {
      peek: () => pendingLaunch.peekLaunch(SESSION, HOST),
      take: () => pendingLaunch.takeLaunch(SESSION, HOST),
      ask,
      canType,
      type: (command) => typed.push(command),
    },
  };
}

describe("a queued launch", () => {
  test("types --no-daemon only when the host says the window's Codex accepts it", () => {
    expect(chooseLaunchCommand(launch, true)).toBe("codex --no-daemon resume");
    for (const answer of [false, null]) {
      expect(chooseLaunchCommand(launch, answer)).toBe("codex resume");
    }
    expect(chooseLaunchCommand({ command: "claude", codexNoDaemon: null }, true)).toBe("claude");
  });

  test("a host that fails or is slow to answer is not waited on", async () => {
    expect(await answerWithin(async () => true, 50)).toBe(true);
    expect(await answerWithin(() => Promise.reject(new Error("offline")), 50)).toBeNull();
    expect(await answerWithin(() => new Promise<boolean>(() => undefined), 20)).toBeNull();
  });

  test("is typed plain when the host has not answered by the deadline", async () => {
    pendingLaunch.set(SESSION, HOST, launch);
    const { delivery, typed } = view(() => new Promise<boolean>(() => undefined));
    const started = Date.now();
    expect(await deliverQueuedLaunch(delivery)).toEqual({
      typed: "codex resume",
      plain: "codex resume",
    });
    expect(Date.now() - started).toBeLessThan(CODEX_ANSWER_DEADLINE_MS + 1_000);
    expect(typed).toEqual(["codex resume"]);
  });

  test("asks the host before it is claimed, so a view that cannot type after asking loses nothing", async () => {
    pendingLaunch.set(SESSION, HOST, launch);
    let canType = true;
    const gone = view(
      async () => {
        canType = false; // The view closed, or lost the display, while waiting.
        return true;
      },
      () => canType,
    );
    expect(await deliverQueuedLaunch(gone.delivery)).toBeNull();
    expect(gone.typed).toEqual([]);
    expect(pendingLaunch.peekLaunch(SESSION, HOST)).toEqual(launch);
    // The next view to be able to type types it.
    const next = view(async () => true);
    expect(await deliverQueuedLaunch(next.delivery)).toEqual({
      typed: "codex --no-daemon resume",
      plain: "codex resume",
    });
    expect(next.typed).toEqual(["codex --no-daemon resume"]);
    expect(pendingLaunch.peekLaunch(SESSION, HOST)).toBeNull();
  });

  test("two views asking at once type it once between them", async () => {
    pendingLaunch.set(SESSION, HOST, launch);
    const first = view(async () => true);
    const second = view(async () => true);
    await Promise.all([deliverQueuedLaunch(first.delivery), deliverQueuedLaunch(second.delivery)]);
    expect([...first.typed, ...second.typed]).toEqual(["codex --no-daemon resume"]);
  });

  test("a launch with no --no-daemon form asks nothing", async () => {
    pendingLaunch.set(SESSION, HOST, "claude");
    const ask = mock(async () => true);
    const { delivery, typed } = view(ask);
    await deliverQueuedLaunch(delivery);
    expect(typed).toEqual(["claude"]);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("Codex refusing --no-daemon", () => {
  const typedFlag = { typed: "codex --no-daemon resume", plain: "codex resume" };
  const at = 1_000_000;
  const moment = (overrides: Partial<RefusalMoment> = {}): RefusalMoment => ({
    now: at + 2_000,
    attachedHost: HOST,
    owner: true,
    foreground: "zsh",
    agentRunning: async () => false,
    ...overrides,
  });
  const answer = (overrides: Partial<RefusalMoment> = {}, delivered = typedFlag) => {
    const watch = refusalWatch();
    watch.arm(delivered, HOST, at);
    return watch.refused(moment(overrides));
  };

  test("is answered with the plain command, once", async () => {
    const watch = refusalWatch();
    watch.arm(typedFlag, HOST, at);
    expect(await watch.refused(moment())).toBe("codex resume");
    expect(await watch.refused(moment())).toBeNull();
  });

  test("is not answered after the window, or for a launch typed plain", async () => {
    expect(await answer({ now: at + NO_DAEMON_REFUSAL_WINDOW_MS + 1 })).toBeNull();
    expect(await answer({}, { typed: "codex resume", plain: "codex resume" })).toBeNull();
    const unarmed = refusalWatch();
    expect(await unarmed.refused(moment())).toBeNull();
  });

  test("is not answered unless this view can still type into the window there", async () => {
    expect(await answer({ owner: false })).toBeNull();
    expect(await answer({ attachedHost: null })).toBeNull();
    expect(await answer({ attachedHost: "mac" })).toBeNull();
  });

  test("is not answered unless the window's shell is in the foreground", async () => {
    // A Codex that took the flag and runs, showing a thread about the error.
    expect(await answer({ foreground: "codex" })).toBeNull();
    expect(await answer({ foreground: "node" })).toBeNull();
    // Not reported (a worker that never reports it): not known, not typed.
    expect(await answer({ foreground: null })).toBeNull();
    // The host says an agent runs there now, or cannot say.
    expect(await answer({ agentRunning: async () => true })).toBeNull();
    expect(await answer({ agentRunning: async () => null })).toBeNull();
    expect(await answer({ agentRunning: () => Promise.reject(new Error("offline")) })).toBeNull();
  });
});
