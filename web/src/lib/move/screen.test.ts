import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CLAUDE_SCREEN_TABLE,
  type ClaudeScreenState,
  classifyClaudeScreen,
  claudeScreenAsksPerson,
  readScreenLines,
} from "./screen";

// The vectors are the contract with the phone's copy of the table, which
// classifies the same screens (mobile/src/data/selectors/__tests__/claude-screen.test.ts).
interface Fixture {
  name: string;
  lines: string[];
  expect: ClaudeScreenState;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../../proto/claude-screen-vectors.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { fixtures: Fixture[] };

describe("proto/claude-screen-vectors.json", () => {
  test("is the table this module embeds", () => {
    const {
      description: _description,
      source: _source,
      checked_against: _checked,
      fixtures: _fixtures,
      ...table
    } = vectors;
    expect(JSON.parse(JSON.stringify(CLAUDE_SCREEN_TABLE))).toEqual(table);
  });

  test("every pattern compiles as a unicode JavaScript expression", () => {
    const { input_box, while_input_shows, bottom } = CLAUDE_SCREEN_TABLE;
    const sources = [
      input_box.rule,
      input_box.prompt,
      input_box.empty_prompt,
      ...[...while_input_shows, ...bottom].flatMap((rule) => rule.line_regex ?? []),
    ];
    for (const source of sources) expect(() => new RegExp(source, "u")).not.toThrow();
  });

  test("every state has fixtures, and unknown has several", () => {
    for (const state of CLAUDE_SCREEN_TABLE.states) {
      const count = vectors.fixtures.filter((fixture) => fixture.expect === state).length;
      expect(count).toBeGreaterThanOrEqual(state === "unknown" ? 4 : 2);
    }
    for (const fixture of vectors.fixtures)
      expect(CLAUDE_SCREEN_TABLE.states).toContain(fixture.expect);
  });

  for (const fixture of vectors.fixtures) {
    test(`${fixture.name} → ${fixture.expect}`, () => {
      expect(classifyClaudeScreen(fixture.lines)).toBe(fixture.expect);
    });
  }
});

describe("classifyClaudeScreen", () => {
  const box = [
    "──────────────────────────────",
    "❯  ",
    "──────────────────────────────",
    "  ⏸ manual mode on · ? for shortcuts",
  ];

  test("reads a box with more than two lines under it as no box at all", () => {
    expect(classifyClaudeScreen([...box, "", "※ recap: the tests pass"])).toBe("agent_ready");
    expect(classifyClaudeScreen([...box, "one", "two"])).toBe("unknown");
  });

  test("never reads a dialog's selected option as the empty prompt", () => {
    expect(
      classifyClaudeScreen(["──────────────", "❯ 1. Yes", "──────────────", "  Esc to cancel"]),
    ).toBe("unknown");
  });

  test("reads only what is under the newest echo of a resume line", () => {
    const echo =
      "me$ claude --resume 6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60 --permission-mode default";
    expect(classifyClaudeScreen([echo, "zsh: command not found: claude", "me$"])).toBe(
      "agent_missing",
    );
    expect(classifyClaudeScreen([echo, "zsh: command not found: claude", "me$", echo])).toBe(
      "unknown",
    );
  });

  test("tells the questions a person answers from the rest", () => {
    for (const state of CLAUDE_SCREEN_TABLE.states) {
      expect(claudeScreenAsksPerson(state)).toBe(
        [
          "trust_prompt",
          "bypass_prompt",
          "resume_summary_prompt",
          "login_required",
          "dialog",
        ].includes(state),
      );
    }
  });
});

// The browser's own reader, over the real xterm.js the terminal draws with.
async function terminal(cols: number, rows: number, data: string) {
  const globals = globalThis as Record<string, unknown>;
  globals.window ??= globalThis;
  globals.self ??= globalThis;
  const { Terminal } = await import("@xterm/xterm");
  const term = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
  await new Promise<void>((done) => term.write(data, done));
  return term;
}

function physicalRows(term: Awaited<ReturnType<typeof terminal>>): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = buffer.baseY; y < buffer.baseY + term.rows; y += 1) {
    rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return rows;
}

describe("readScreenLines", () => {
  // Host names are the server's to choose, and the note naming them rides
  // the resume line the shell echoes back.
  const echo =
    "me@mac:~/code/spawn$ claude --resume 6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60 " +
    "--permission-mode default '[SPAWN D] This conversation just moved from No conversation " +
    "found with session ID (Linux) to Yes, I trust this folder (macOS).'";

  test("joins a row the terminal wrapped to the row before it", async () => {
    const term = await terminal(50, 10, echo);
    const rows = physicalRows(term);
    // Read row by row, the host names would pass for Claude's own words.
    expect(classifyClaudeScreen(rows)).not.toBe("unknown");
    const lines = readScreenLines(term.buffer.active, term.rows);
    expect(lines[0]).toBe(echo);
    expect(classifyClaudeScreen(lines)).toBe("unknown");
  });

  test("keeps a space the terminal wrapped at", async () => {
    const term = await terminal(10, 4, "abcdefghi jklmnop");
    expect(readScreenLines(term.buffer.active, term.rows)[0]).toBe("abcdefghi jklmnop");
  });

  test("reads a line that began above the screen from its start", async () => {
    const term = await terminal(50, 4, `${echo}\r\n`);
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    expect(term.buffer.active.getLine(term.buffer.active.baseY)?.isWrapped).toBe(true);
    expect(classifyClaudeScreen(physicalRows(term))).not.toBe("unknown");
    const lines = readScreenLines(term.buffer.active, term.rows);
    expect(lines[0]).toBe(echo);
    expect(classifyClaudeScreen(lines)).toBe("unknown");
  });

  test("reads the alternate screen Claude Code draws on", async () => {
    const term = await terminal(
      40,
      6,
      `${echo}\r\n\x1b[?1049h\x1b[H${"─".repeat(40)}\r\n❯ \r\n${"─".repeat(40)}\r\n  ? for shortcuts`,
    );
    expect(term.buffer.active.type).toBe("alternate");
    expect(classifyClaudeScreen(readScreenLines(term.buffer.active, term.rows))).toBe(
      "agent_ready",
    );
  });
});
