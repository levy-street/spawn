import { describe, expect, test } from "bun:test";
import type { Agent, Session } from "@/lib/api";
import type { LayoutV3 } from "@/lib/tabs";
import { templateSpecFromWorkspace } from "./workspace-templates";

const layout: LayoutV3 = {
  version: 3,
  active_tab: "t1",
  tabs: [
    {
      id: "t1",
      name: "Build",
      layout: {
        version: 2,
        tiles: [
          { session_id: "s1", x: 0, y: 0, w: 6, h: 12 },
          { session_id: "s2", x: 6, y: 0, w: 6, h: 12 },
        ],
      },
    },
    {
      id: "t2",
      name: "Files",
      layout: {
        version: 2,
        tiles: [
          {
            session_id: "w1",
            x: 0,
            y: 0,
            w: 12,
            h: 12,
            widget: { kind: "files", host_id: "h1", path: "/tmp" },
          },
        ],
      },
    },
  ],
};

const session = (id: string, foreground: string | null) =>
  ({ id, foreground_command: foreground }) as Session;
const claude = { id: "a1", command: "claude", name: "Claude Code" } as Agent;

describe("templateSpecFromWorkspace", () => {
  test("captures tabs, geometry, and what each tile runs", () => {
    const spec = templateSpecFromWorkspace(
      layout,
      new Map([
        ["s1", session("s1", "claude")],
        ["s2", session("s2", "zsh")],
      ]),
      [claude],
    );
    expect(spec).toEqual({
      version: 1,
      tabs: [
        {
          name: "Build",
          tiles: [
            { x: 0, y: 0, w: 6, h: 12, run: { kind: "agent", command: "claude" } },
            { x: 6, y: 0, w: 6, h: 12, run: { kind: "shell" } },
          ],
        },
        { name: "Files", tiles: [{ x: 0, y: 0, w: 12, h: 12, run: { kind: "files" } }] },
      ],
    });
  });

  test("matches agents by command basename and falls back to shell", () => {
    const npxAgent = { id: "a2", command: "/usr/local/bin/aider --model x" } as Agent;
    const spec = templateSpecFromWorkspace(layout, new Map([["s1", session("s1", "aider")]]), [
      npxAgent,
    ]);
    expect(spec.tabs[0]?.tiles[0]?.run).toEqual({
      kind: "agent",
      command: "/usr/local/bin/aider --model x",
    });
    // Unknown session (no foreground yet) -> shell.
    expect(spec.tabs[0]?.tiles[1]?.run).toEqual({ kind: "shell" });
  });
});
