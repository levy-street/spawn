/**
 * Where Claude Code is, read off the screen of the window it was resumed in
 * after a move: whether a device may type the move note now, and which
 * banner to show when it may not.
 *
 * A note is typed only at Claude Code's empty prompt while it is not
 * working. Every question Claude Code asks before that — trusting the
 * folder, confirming Bypass Permissions, resuming a long conversation from a
 * summary, signing in, a tool's permission, any other numbered choice — is
 * the person's to answer: SPAWN D says so in a banner and never presses a key
 * in it (the trust and Bypass Permissions warnings select "No, exit" first,
 * so a blind Enter would quit). Anything the table does not recognise is
 * `unknown`, and nothing is typed into it.
 *
 * The table is a contract with the phone, which embeds the same one
 * (`mobile/src/data/selectors/claude-screen.ts`), pinned by
 * `proto/claude-screen-vectors.json`: screens captured from Claude Code
 * 2.1.289 in a stub-API sandbox, and screens laid out like them from the
 * installed binaries' strings. `proto/README.md`, "Reading Claude Code's
 * screen after a move", states the algorithm; a rule changes in all three at
 * once, with a fixture that shows why. Like `agent-notice.ts`, this reads the
 * rendered screen in front of the person, never the byte stream: the daemon
 * and server stay content-blind (docs/TRUST.md).
 */

export type ClaudeScreenState =
  | "agent_ready"
  | "busy"
  | "trust_prompt"
  | "bypass_prompt"
  | "resume_summary_prompt"
  | "login_required"
  | "dialog"
  | "conversation_not_found"
  | "agent_missing"
  | "unknown";

interface ScreenRule {
  readonly state: ClaudeScreenState;
  /** Matches when the lines' words hold any of these. */
  readonly any?: readonly string[];
  /** Matches when they hold every one of these. */
  readonly all?: readonly string[];
  /** Matches when any one line matches any of these. */
  readonly line_regex?: readonly string[];
}

/** The table, exactly as proto/claude-screen-vectors.json holds it, minus
 *  its description, source, checked_against and fixtures (a test compares
 *  the two). */
export const CLAUDE_SCREEN_TABLE = {
  version: 2,
  states: [
    "agent_ready",
    "busy",
    "trust_prompt",
    "bypass_prompt",
    "resume_summary_prompt",
    "login_required",
    "dialog",
    "conversation_not_found",
    "agent_missing",
    "unknown",
  ] as readonly ClaudeScreenState[],
  asks_person: [
    "trust_prompt",
    "bypass_prompt",
    "resume_summary_prompt",
    "login_required",
    "dialog",
  ] as readonly ClaudeScreenState[],
  // The shell's echo of the line the device typed: every carried resume names
  // its permission mode. Only what is under the newest one is read — the echo
  // carries server-chosen host names, and what came before it is not this
  // attempt's.
  read_below_last_line_containing: ["--permission-mode"] as readonly string[],
  edge_characters: "│┃║╭╮╰╯",
  input_box: {
    rule: "^\\s*[─━]{10,}(?:\\s+\\S.*?\\s+[─━]{1,4})?\\s*$",
    prompt: "^\\s*[❯>](?:\\s.*)?$",
    empty_prompt: "^\\s*[❯>]\\s*$",
    footer_lines_max: 2,
    context_lines_above: 4,
  },
  while_input_shows: [
    {
      state: "login_required",
      any: ["Not logged in", "Invalid API key", "Authentication required"],
    },
    {
      state: "busy",
      any: ["esc to interr", "enter to interrupt"],
      line_regex: ["^\\s*\\S\\s+\\S+…\\s*(?:\\(\\d|$)"],
    },
  ] as readonly ScreenRule[],
  bottom_lines: 14,
  bottom: [
    {
      state: "conversation_not_found",
      any: ["No conversation found with session ID", "No conversation found to continue"],
    },
    {
      state: "agent_missing",
      line_regex: [
        "(?:^|[\\s:])claude: (?:command )?not found\\b",
        "command not found: claude\\b",
        "Unknown command:? '?claude'?(?:\\s|$)",
        "The term 'claude' is not recognized",
        "'claude' is not recognized as an internal or external command",
        "Command `claude` not found",
      ],
    },
    {
      state: "trust_prompt",
      any: [
        "Yes, I trust this folder",
        "Quick safety check: Is this a project you created or one you trust?",
      ],
    },
    { state: "bypass_prompt", all: ["Bypass Permissions mode", "Yes, I accept"] },
    { state: "resume_summary_prompt", any: ["Resume from summary", "Resume full session as-is"] },
    {
      state: "login_required",
      any: [
        "Select login method",
        "Not logged in",
        "Choose the text style that looks best with your terminal",
        "Authentication required",
        "Browser didn't open? Use the url below to sign in",
      ],
    },
    {
      state: "dialog",
      any: ["Do you want to proceed?", "Do you want to use this API key?"],
      line_regex: ["^\\s*❯\\s*\\d+\\.\\s"],
    },
  ] as readonly ScreenRule[],
} as const;

const compiled = new Map<string, RegExp>();

/** Every pattern in the table is a JavaScript expression with the u flag. */
function regex(source: string): RegExp {
  let pattern = compiled.get(source);
  if (!pattern) {
    pattern = new RegExp(source, "u");
    compiled.set(source, pattern);
  }
  return pattern;
}

const EDGES = new Set(Array.from(CLAUDE_SCREEN_TABLE.edge_characters));

function edge(point: string | undefined): boolean {
  return point !== undefined && (EDGES.has(point) || /\s/u.test(point));
}

/** A line without blanks or a dialog's border at either end. */
function core(line: string): string {
  const points = Array.from(line);
  let start = 0;
  let end = points.length;
  while (start < end && edge(points[start])) start += 1;
  while (end > start && edge(points[end - 1])) end -= 1;
  return points.slice(start, end).join("");
}

/** Lines as words: borders gone, every run of spacing one space, so a phrase
 *  Claude Code wrapped across lines still reads as one. */
function words(lines: readonly string[]): string {
  return lines.map(core).filter(Boolean).join(" ").replace(/\s+/gu, " ");
}

function matches(rule: ScreenRule, lines: readonly string[]): boolean {
  const text = words(lines);
  if (rule.any?.some((phrase) => text.includes(phrase))) return true;
  if (rule.all && rule.all.length > 0 && rule.all.every((phrase) => text.includes(phrase))) {
    return true;
  }
  return Boolean(
    rule.line_regex?.some((source) => lines.some((line) => regex(source).test(core(line)))),
  );
}

/** Claude Code's input box at the bottom of the screen — a rule, the prompt,
 *  a rule — with at most `footer_lines_max` lines that are not blank under
 *  it; its rules' indexes, or null. */
function inputBox(cores: readonly string[]): { top: number; bottom: number } | null {
  const { rule, prompt, footer_lines_max } = CLAUDE_SCREEN_TABLE.input_box;
  let footer = 0;
  for (let bottom = cores.length - 1; bottom >= 2; bottom -= 1) {
    if (
      regex(rule).test(cores[bottom] ?? "") &&
      regex(prompt).test(cores[bottom - 1] ?? "") &&
      regex(rule).test(cores[bottom - 2] ?? "")
    ) {
      return { top: bottom - 2, bottom };
    }
    if ((cores[bottom] ?? "") === "") continue;
    footer += 1;
    if (footer > footer_lines_max) return null;
  }
  return null;
}

/**
 * The state a screen shows, from its logical lines (`readScreenLines`), top
 * to bottom.
 *
 * Only what is under the newest echo of a resume line is this attempt's.
 * Claude Code's input box at the bottom means the agent is up: signed out or
 * working while the few lines around the box say so, ready when the prompt
 * is empty. A question replaces that box, so without it only the bottom of
 * the screen is read, never the conversation above: a history that quotes a
 * dialog, a numbered request, or Claude asking in prose cannot pass for one.
 */
export function classifyClaudeScreen(lines: readonly string[]): ClaudeScreenState {
  const table = CLAUDE_SCREEN_TABLE;
  let start = 0;
  lines.forEach((line, index) => {
    if (table.read_below_last_line_containing.some((marker) => line.includes(marker))) {
      start = index + 1;
    }
  });
  const shown = lines.slice(start);
  while (shown.length > 0 && core(shown[shown.length - 1] ?? "") === "") shown.pop();
  if (shown.length === 0) return "unknown";

  const cores = shown.map(core);
  const box = inputBox(cores);
  if (box) {
    const context = [
      ...shown.slice(Math.max(0, box.top - table.input_box.context_lines_above), box.top),
      ...shown.slice(box.bottom + 1),
    ];
    for (const rule of table.while_input_shows) {
      if (matches(rule, context)) return rule.state;
    }
    return regex(table.input_box.empty_prompt).test(cores[box.top + 1] ?? "")
      ? "agent_ready"
      : "unknown";
  }

  const bottom = shown.slice(-table.bottom_lines);
  for (const rule of table.bottom) {
    if (matches(rule, bottom)) return rule.state;
  }
  return "unknown";
}

/** Whether the screen shows a question only the person answers: a banner
 *  says so, and nothing is typed while it is up. */
export function claudeScreenAsksPerson(state: ClaudeScreenState): boolean {
  return CLAUDE_SCREEN_TABLE.asks_person.includes(state);
}

/** What `readScreenLines` needs of an xterm buffer. */
export interface ScreenBuffer {
  readonly baseY: number;
  getLine(
    y: number,
  ): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * The visible screen as logical lines, the input `classifyClaudeScreen`
 * reads: each row without the empty cells at its end, a row the terminal
 * wrapped joined to the one before it, and a line that began above the
 * first visible row read from its start — so the echo of a long resume line
 * scrolled half out of view still carries its marker, and the host names
 * inside it are never read as the screen's. The phone's terminal worker
 * reads its screen the same way (`readScreen` in worker-session.js).
 */
export function readScreenLines(buffer: ScreenBuffer, rows: number): string[] {
  const end = buffer.baseY + rows;
  let y = buffer.baseY;
  while (y > 0 && buffer.getLine(y)?.isWrapped) y -= 1;
  const lines: string[] = [];
  for (; y < end; y += 1) {
    const line = buffer.getLine(y);
    const text = line?.translateToString(true) ?? "";
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}
