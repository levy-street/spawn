import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLAUDE_SCREEN_TABLE,
  type ClaudeScreenState,
  classifyClaudeScreen,
  claudeScreenAsksPerson,
} from "@/data/selectors/claude-screen";

// The vectors are the contract with the browser's copy of the table, which
// classifies the same screens (web/src/lib/move/screen.test.ts).
interface Fixture {
  name: string;
  lines: string[];
  expect: ClaudeScreenState;
}

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../../proto/claude-screen-vectors.json"), "utf8"),
) as Record<string, unknown> & { fixtures: Fixture[] };

describe("proto/claude-screen-vectors.json", () => {
  it("is the table this module embeds", () => {
    const {
      description: _description,
      source: _source,
      checked_against: _checked,
      fixtures: _fixtures,
      ...table
    } = vectors;
    expect(JSON.parse(JSON.stringify(CLAUDE_SCREEN_TABLE))).toEqual(table);
  });

  it("compiles every pattern as a unicode JavaScript expression", () => {
    const { input_box, while_input_shows, bottom } = CLAUDE_SCREEN_TABLE;
    const sources = [
      input_box.rule,
      input_box.prompt,
      input_box.empty_prompt,
      ...[...while_input_shows, ...bottom].flatMap((rule) => rule.line_regex ?? []),
    ];
    for (const source of sources) expect(() => new RegExp(source, "u")).not.toThrow();
  });

  it("has fixtures for every state, and several for unknown", () => {
    for (const state of CLAUDE_SCREEN_TABLE.states) {
      const count = vectors.fixtures.filter((fixture) => fixture.expect === state).length;
      expect(count).toBeGreaterThanOrEqual(state === "unknown" ? 4 : 2);
    }
    for (const fixture of vectors.fixtures) {
      expect(CLAUDE_SCREEN_TABLE.states).toContain(fixture.expect);
    }
  });

  it.each(vectors.fixtures.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      expect(classifyClaudeScreen(fixture.lines)).toBe(fixture.expect);
    },
  );
});

describe("classifyClaudeScreen", () => {
  const box = [
    "──────────────────────────────",
    "❯  ",
    "──────────────────────────────",
    "  ⏸ manual mode on · ? for shortcuts",
  ];

  it("reads a box with more than two lines under it as no box at all", () => {
    expect(classifyClaudeScreen([...box, "", "※ recap: the tests pass"])).toBe("agent_ready");
    expect(classifyClaudeScreen([...box, "one", "two"])).toBe("unknown");
  });

  it("never reads a dialog's selected option as the empty prompt", () => {
    expect(
      classifyClaudeScreen(["──────────────", "❯ 1. Yes", "──────────────", "  Esc to cancel"]),
    ).toBe("unknown");
  });

  it("reads only what is under the newest echo of a resume line", () => {
    const echo =
      "me$ claude --resume 6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60 --permission-mode default";
    expect(classifyClaudeScreen([echo, "zsh: command not found: claude", "me$"])).toBe(
      "agent_missing",
    );
    expect(classifyClaudeScreen([echo, "zsh: command not found: claude", "me$", echo])).toBe(
      "unknown",
    );
  });

  it("tells the questions a person answers from the rest", () => {
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
