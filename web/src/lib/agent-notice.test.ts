import { describe, expect, test } from "bun:test";
import { detectAgentNotice, screenLines } from "@/lib/agent-notice";

describe("detectAgentNotice", () => {
  test("recognises Claude Code's status bar after a background update", () => {
    expect(
      detectAgentNotice([
        "  ⏵⏵ bypass permissions on · 1 monitor · ← for agents · ↓ to manage",
        "                              ✓ Update installed · Restart to update",
      ]),
    ).toBe("update_installed");
    expect(detectAgentNotice(["✓ Update installed · Restart to apply"])).toBe("update_installed");
  });

  test("tolerates a lost separator and surrounding chrome", () => {
    expect(detectAgentNotice(["│ ✓ Update installed  Restart to update │"])).toBe(
      "update_installed",
    );
    expect(detectAgentNotice(["Update installed·Restart to update"])).toBe("update_installed");
  });

  test("is quiet for ordinary output and near misses", () => {
    expect(detectAgentNotice([])).toBeNull();
    expect(detectAgentNotice(["$ npm install", "added 12 packages"])).toBeNull();
    expect(detectAgentNotice(["Update available · run npm i -g"])).toBeNull();
    expect(detectAgentNotice(["Restart to update your shell"])).toBeNull();
    expect(detectAgentNotice(["Update installed"])).toBeNull();
  });
});

describe("a Codex that refuses --no-daemon", () => {
  test("is recognised by clap's refusal on screen", () => {
    expect(
      detectAgentNotice([
        "$ codex --no-daemon",
        "error: unexpected argument '--no-daemon' found",
        "",
        "  tip: a similar argument exists: '--no-alt-screen'",
        "$",
      ]),
    ).toBe("codex_no_daemon_refused");
    expect(detectAgentNotice(["error: unexpected argument '--foo' found"])).toBeNull();
    // Trailing blanks do not matter.
    expect(detectAgentNotice(["error: unexpected argument '--no-daemon' found   "])).toBe(
      "codex_no_daemon_refused",
    );
    // The update notice still wins where both show.
    expect(
      detectAgentNotice([
        "error: unexpected argument '--no-daemon' found",
        "Update installed · Restart to update",
      ]),
    ).toBe("update_installed");
  });

  test("only the whole line from column 0 counts, not the words anywhere else", () => {
    for (const line of [
      // Mid-line, as typed or echoed at a shell.
      "$ echo error: unexpected argument '--no-daemon' found",
      "note: error: unexpected argument '--no-daemon' found",
      // Indented, or inside Codex's own interface: a thread about the error.
      "  error: unexpected argument '--no-daemon' found",
      "• error: unexpected argument '--no-daemon' found",
      "│ error: unexpected argument '--no-daemon' found │",
      "› Why does it say error: unexpected argument '--no-daemon' found?",
      // Longer than the refusal.
      "error: unexpected argument '--no-daemon' found in the logs",
      "unexpected argument '--no-daemon'",
    ]) {
      expect(detectAgentNotice([line])).toBeNull();
    }
  });

  test("a refusal wrapped across rows of a narrow pane is read whole", () => {
    const width = 20;
    const line = "error: unexpected argument '--no-daemon' found";
    const rows = [{ text: "$ codex --no-daemon", wrapped: false }];
    for (let at = 0; at < line.length; at += width) {
      rows.push({ text: line.slice(at, at + width).padEnd(width), wrapped: at > 0 });
    }
    rows.push({ text: "$ ", wrapped: false });
    expect(screenLines(rows)).toEqual(["$ codex --no-daemon", line, "$"]);
    expect(detectAgentNotice(screenLines(rows))).toBe("codex_no_daemon_refused");
    // Read row by row, it would not be.
    expect(detectAgentNotice(rows.map((row) => row.text))).toBeNull();
  });
});
