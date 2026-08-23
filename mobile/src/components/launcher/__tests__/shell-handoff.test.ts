import {
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
