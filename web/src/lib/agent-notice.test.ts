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
