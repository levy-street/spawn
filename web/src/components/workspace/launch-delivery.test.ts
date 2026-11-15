import { describe, expect, mock, test } from "bun:test";
import { chooseLaunchCommand } from "@/hooks/usePendingLaunchDrain";

const launch = { command: "codex resume", codexNoDaemon: "codex --no-daemon resume" };

describe("chooseLaunchCommand", () => {
  test("types --no-daemon only when the host says the window's Codex accepts it", async () => {
    expect(await chooseLaunchCommand(launch, async () => true)).toBe("codex --no-daemon resume");
    for (const answer of [false, null]) {
      expect(await chooseLaunchCommand(launch, async () => answer)).toBe("codex resume");
    }
    expect(
      await chooseLaunchCommand(launch, async () => Promise.reject(new Error("offline"))),
    ).toBe("codex resume");
    expect(await chooseLaunchCommand(launch, null)).toBe("codex resume");
  });

  test("a launch with no --no-daemon form asks nothing", async () => {
    const ask = mock(async () => true);
    expect(await chooseLaunchCommand({ command: "claude", codexNoDaemon: null }, ask)).toBe(
      "claude",
    );
    expect(ask).not.toHaveBeenCalled();
  });
});
