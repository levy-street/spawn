import {
  formatProfileDuration,
  formatProfileMemory,
  profileStatsLine,
} from "@/components/settings/profile-format";
import { SETTINGS_PANEL_COUNT, SETTINGS_PANELS } from "@/components/settings/settings-inventory";
import { formatTemplateSummary } from "@/components/settings/templates-panel";
import type { ProfileOut } from "@/data/api/schemas/legion";
import type { WorkspaceTemplateOut } from "@/data/api/schemas/templates";

describe("settings inventory", () => {
  test("ships exactly the nine reference panels with a documented control inventory", () => {
    expect(SETTINGS_PANELS).toHaveLength(SETTINGS_PANEL_COUNT);
    // No Hosts panel: machines are the Legion tab's, not a setting. Subscription
    // is in the inventory but drawn only where the server has billing, so a
    // self-hosted deployment shows eight of these nine.
    expect(SETTINGS_PANELS.map((panel) => panel.label)).toEqual([
      "Account",
      "Subscription",
      "Appearance",
      "Notifications",
      "Agents",
      "Skills",
      "Templates",
      "Browser devices",
      "Device trust",
    ]);
    for (const panel of SETTINGS_PANELS) {
      expect(panel.controls.length).toBeGreaterThan(0);
      expect(new Set(panel.controls).size).toBe(panel.controls.length);
    }
    expect(SETTINGS_PANELS.map((panel) => panel.label)).not.toEqual(
      expect.arrayContaining(["Terminal", "Sessions", "Security"]),
    );
  });
});

describe("settings presentation formatters", () => {
  test("formats profile quantities and a privacy-safe share line", () => {
    const profile = {
      totals: { hosts: 2, cores: 12, memory_bytes: 16 * 1024 ** 3 },
      agents: [
        { command: "claude", count: 3 },
        { command: "codex", count: 2 },
      ],
    } as ProfileOut;

    expect(formatProfileMemory(16 * 1024 ** 3)).toBe("16 GB");
    expect(formatProfileDuration(3_720)).toBe("1h 2m");
    expect(profileStatsLine(profile)).toBe("2 hosts · 12 cores · 16 GB · 5 agent runs · spawnd");
    expect(profileStatsLine(profile)).not.toContain("claude");
  });

  test("counts template tabs, windows, and agents", () => {
    const template = {
      spec: {
        version: 2,
        tabs: [
          {
            name: "one",
            tiles: [
              { x: 0, y: 0, w: 1, h: 1, run: { kind: "shell" } },
              { x: 1, y: 0, w: 1, h: 1, run: { kind: "agent" } },
            ],
          },
          { name: "two", tiles: [] },
        ],
      },
    } as WorkspaceTemplateOut;
    expect(formatTemplateSummary(template)).toBe("2 tabs · 2 windows · 1 agent");
  });
});
