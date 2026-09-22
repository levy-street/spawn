import {
  interruptScheduled,
  runInShell,
  SHELL_HANDOFF_ATTEMPTS,
  SHELL_HANDOFF_INTERRUPTS,
  SHELL_HANDOFF_POLL_MS,
} from "@/components/launcher/shell-handoff";
import { makeSession } from "./fixtures";

describe("shell handoff", () => {
  const terminal = () => ({ sendInput: jest.fn(), focus: jest.fn() });

  test("types immediately when the session is already at a shell", async () => {
    const sink = terminal();
    const confirmStop = jest.fn(async () => true);
    const getSession = jest.fn(async () => makeSession());
    await expect(
      runInShell({
        session: makeSession({ foreground_command: "zsh" }),
        terminal: sink,
        command: "codex",
        purpose: "Starting Codex",
        confirmStop,
        getSession,
      }),
    ).resolves.toBe("sent");
    expect(sink.sendInput).toHaveBeenCalledWith("codex\n");
    expect(confirmStop).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  test("can cancel before interrupting a foreground agent", async () => {
    const sink = terminal();
    await expect(
      runInShell({
        session: makeSession({ foreground_command: "claude" }),
        terminal: sink,
        command: "codex",
        purpose: "Starting Codex",
        confirmStop: async () => false,
        getSession: async () => makeSession(),
      }),
    ).resolves.toBe("cancelled");
    expect(sink.sendInput).not.toHaveBeenCalled();
  });

  test("interrupts, polls, clears the old screen, and launches at the prompt", async () => {
    const sink = terminal();
    const wait = jest.fn(async () => undefined);
    const getSession = jest
      .fn<Promise<ReturnType<typeof makeSession>>, [string]>()
      .mockResolvedValueOnce(makeSession({ foreground_command: "claude" }))
      .mockResolvedValueOnce(makeSession({ foreground_command: null }));
    const onSession = jest.fn();
    await expect(
      runInShell({
        session: makeSession({ foreground_command: "claude" }),
        terminal: sink,
        command: "codex",
        purpose: "Starting Codex",
        confirmStop: async () => true,
        getSession,
        onSession,
        wait,
      }),
    ).resolves.toBe("sent");
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(SHELL_HANDOFF_POLL_MS);
    expect(sink.sendInput.mock.calls.map(([value]) => value)).toEqual([
      "\u0003",
      "\u0003",
      "clear\n",
      "codex\n",
    ]);
    expect(onSession).toHaveBeenCalledTimes(2);
  });

  test("gives up honestly after the bounded polling window", async () => {
    const sink = terminal();
    const getSession = jest.fn(async () => makeSession({ foreground_command: "claude" }));
    await expect(
      runInShell({
        session: makeSession({ foreground_command: "claude" }),
        terminal: sink,
        command: "",
        purpose: "Switching to Shell",
        confirmStop: async () => true,
        getSession,
        wait: async () => undefined,
      }),
    ).resolves.toBe("busy");
    expect(getSession).toHaveBeenCalledTimes(SHELL_HANDOFF_ATTEMPTS);
    expect(sink.sendInput).toHaveBeenCalledTimes(SHELL_HANDOFF_INTERRUPTS);
  });
});

describe("interrupt schedule", () => {
  test("opens with a Ctrl-C on each of the first polls, then a pair every eighth poll", () => {
    const sent = Array.from({ length: 40 }, (_, attempt) => attempt).filter(interruptScheduled);
    expect(sent).toEqual([0, 1, 2, 3, 8, 9, 16, 17, 24, 25, 32, 33]);
    expect(sent.slice(0, SHELL_HANDOFF_INTERRUPTS)).toEqual([0, 1, 2, 3]);
  });

  test("a long wait re-sends the pair instead of falling silent", async () => {
    const sink = { sendInput: jest.fn(), focus: jest.fn() };
    await expect(
      runInShell({
        session: makeSession({ foreground_command: "claude" }),
        terminal: sink,
        command: "claude --resume x",
        purpose: "Starting Claude Code",
        confirmStop: async () => true,
        getSession: async () => makeSession({ foreground_command: "claude" }),
        wait: async () => undefined,
        attempts: 20,
      }),
    ).resolves.toBe("busy");
    // 0-3, then 8-9 and 16-17: eight presses, all Ctrl-C, nothing typed.
    expect(sink.sendInput).toHaveBeenCalledTimes(8);
    expect(sink.sendInput.mock.calls.every(([data]: [string]) => data === "\u0003")).toBe(true);
  });
});
