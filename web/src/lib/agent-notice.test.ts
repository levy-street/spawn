import { describe, expect, test } from "bun:test";
import { detectAgentNotice } from "@/lib/agent-notice";

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
    // The update notice still wins where both show.
    expect(
      detectAgentNotice([
        "error: unexpected argument '--no-daemon' found",
        "Update installed · Restart to update",
      ]),
    ).toBe("update_installed");
  });
});
