/**
 * How SPAWN D brings an agent back in a fresh shell: the line a device types
 * at the prompt, and, after a move, the note that tells the agent where it is
 * now and how that note reaches it.
 *
 * One module for every relaunch — Restart today; moves, account switches and
 * place changes next — so a window comes back the same way whichever of them
 * brought it back, and from whichever device. The browser and the phone carry
 * this file byte for byte (web/src/lib/agent-relaunch.ts,
 * mobile/src/data/selectors/agent-relaunch.ts). It imports nothing, and both
 * copies are pinned by proto/agent-note-vectors.json, whose rules
 * proto/README.md states under "Relaunch lines and move notes".
 *
 * Nothing here reads a host. A move note is written only from what the device
 * already holds: the two hosts' names and OS from the server's rows, the
 * folder and memory path the target's daemon reported over the device's own
 * channel, and whether the agent was mid-turn when the person confirmed.
 * Nothing read from the source host — its transcript above all — enters the
 * note: the agent already reads that record as its own history, and the note
 * must not lend any of it SPAWN D's voice.
 */

/** The yolo half of an agent definition. Optional throughout: an agent from
 *  an older payload simply has no yolo mode. */
export interface AgentYolo {
  yolo?: boolean | undefined;
  yolo_args?: string | null | undefined;
  yolo_env?: Readonly<Record<string, string>> | null | undefined;
}

/** The parts of an agent definition a line is built from. */
export interface RelaunchAgent extends AgentYolo {
  kind?: string | null | undefined;
  command: string;
  env: Readonly<Record<string, string>>;
}

/**
 * The shells a line is spelled for, by the login shell the target reports.
 * A note rides the line as the agent's first prompt only in the first three.
 * ksh is spelled as POSIX, but its note is typed: interactive ksh93 garbles
 * a long line that holds multibyte characters as it is typed at the prompt,
 * and its quoting with it, though it reads the same line back exactly under
 * `-c`. Every other line is spelled as for a POSIX shell — what every line
 * was before a target could say which shell it runs — and its note is typed
 * into the agent once the agent is ready.
 */
export type ShellFamily = "posix" | "fish" | "pwsh" | "ksh" | "cmd" | "nushell" | "unknown";

const SHELL_FAMILIES: ReadonlyMap<string, ShellFamily> = new Map<string, ShellFamily>([
  ["sh", "posix"],
  ["bash", "posix"],
  ["zsh", "posix"],
  ["dash", "posix"],
  ["mksh", "posix"],
  ["ash", "posix"],
  ["ksh", "ksh"],
  ["fish", "fish"],
  ["pwsh", "pwsh"],
  ["powershell", "pwsh"],
  ["cmd", "cmd"],
  ["nu", "nushell"],
]);

/**
 * The family of a login shell as a host names it: a path or a bare name, a
 * login shell's leading `-`, a Windows `.exe`. Anything unnamed or unfamiliar
 * (csh and tcsh among them) is `unknown`.
 */
export function shellFamily(loginShell: string | null | undefined): ShellFamily {
  const name = (loginShell ?? "").trim().split(/[\\/]/).pop() ?? "";
  const bare = name
    .replace(/^-+/, "")
    .toLowerCase()
    .replace(/\.exe$/, "");
  return SHELL_FAMILIES.get(bare) ?? "unknown";
}

/** Whether a note can ride the line, quoted, as the agent's first prompt:
 *  only in a shell whose quoting has been seen to hold when the line is typed
 *  at its interactive prompt, which is how a device delivers it. */
function quotesNotes(family: ShellFamily): boolean {
  return family === "posix" || family === "fish" || family === "pwsh";
}

/** The quoting a line is spelled in: its shell's own where SPAWN D knows it. */
function spellingFor(family: ShellFamily): "posix" | "fish" | "pwsh" {
  return family === "fish" || family === "pwsh" ? family : "posix";
}

/** Characters no shell gives a meaning, by family: a word of only these
 *  passes bare. PowerShell reads a bare word that starts with a digit as a
 *  number where it can, so there it must start with a letter. */
const POSIX_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const FISH_WORD = /^[A-Za-z0-9_+=:,./-]+$/;
const PWSH_WORD = /^[A-Za-z_][A-Za-z0-9_./:-]*$/;
/** PowerShell ends a single-quoted string at any of these, not only at '. */
const PWSH_QUOTES = /['‘’‚‛]/g;

function pwshLiteral(value: string): string {
  return `'${value.replace(PWSH_QUOTES, "$&$&")}'`;
}

/**
 * One word quoted for a shell, so the shell hands the program exactly
 * `value`. POSIX shells take `'…'` with `'\''` for a quote; fish takes `'…'`
 * with `\'` and `\\`; PowerShell takes `'…'` with every quote doubled. The
 * value is one line: a line break typed at an interactive prompt ends the
 * line whatever the quoting, so callers keep them out.
 */
export function shellQuote(value: string, family: ShellFamily = "posix"): string {
  switch (spellingFor(family)) {
    case "fish":
      return FISH_WORD.test(value) ? value : `'${value.replace(/[\\']/g, "\\$&")}'`;
    case "pwsh":
      return PWSH_WORD.test(value) ? value : pwshLiteral(value);
    default:
      return POSIX_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  }
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The environment a line sets for the agent, in the definition's own order,
 * trailing space included when non-empty. Keys that are not shell identifiers
 * are dropped: there is no way to type them safely. PowerShell has no
 * `KEY=value command` form, so there each one is its own statement.
 */
export function envPrefix(
  env: Readonly<Record<string, string>>,
  family: ShellFamily = "posix",
): string {
  const spelling = spellingFor(family);
  return Object.entries(env)
    .filter(([key]) => ENV_KEY.test(key))
    .map(([key, value]) =>
      spelling === "pwsh"
        ? `$env:${key}=${pwshLiteral(value)}; `
        : `${key}=${shellQuote(value, spelling)} `,
    )
    .join("");
}

/**
 * Whether this agent has a way to skip its permission prompts at all. Some
 * CLIs take a flag, opencode only reads an environment variable, and a custom
 * agent has whatever its owner typed — nothing, usually.
 */
export function agentYoloAvailable(agent: AgentYolo): boolean {
  return Boolean(agent.yolo_args?.trim()) || Object.keys(agent.yolo_env ?? {}).length > 0;
}

function runCommand(agent: RelaunchAgent, family: ShellFamily, honourYolo: boolean): string {
  const yolo = honourYolo && agent.yolo === true && agentYoloAvailable(agent);
  const env = yolo ? { ...agent.env, ...(agent.yolo_env ?? {}) } : agent.env;
  const args = yolo ? agent.yolo_args?.trim() : "";
  return `${envPrefix(env, family)}${agent.command}${args ? ` ${args}` : ""}`;
}

/**
 * What starting an agent types, before anything about its conversation. In
 * yolo mode its `yolo_env` is merged over its own environment and its
 * `yolo_args` appended, both visible in the terminal like everything else
 * typed there: turning permission prompts off is not something that should
 * happen where the person cannot read it. The command itself is the
 * definition's own shell text and is typed as written.
 */
export function agentRunCommand(agent: RelaunchAgent, family: ShellFamily = "posix"): string {
  return runCommand(agent, family, true);
}

/**
 * How an agent CLI names a conversation and the mode it starts in, by agent
 * kind. Every tool spells it differently, and most have no spelling at all.
 */
export interface AgentConversationGrammar {
  /** The flag that starts a fresh conversation under an id SPAWN D chose,
   *  written before the id: at launch, and on a restart whose conversation
   *  the host has no record of yet. Null when the CLI names its own. */
  launch: string | null;
  /** What reopens a known conversation, written before its id. Null when the
   *  CLI cannot. */
  resume: string | null;
  /** What reopens the most recent conversation in this folder, for a window
   *  whose conversation cannot be named. Null when the CLI cannot. */
  continueLatest: string | null;
  /** The flag that sets the permission mode the agent starts in, and each
   *  mode it takes with the spelling written; null when the CLI has no single
   *  flag for it. An explicit mode is the one a resumed conversation starts
   *  in, never the one its record carries. */
  permissionMode: { flag: string; modes: ReadonlyMap<string, string> } | null;
  /** Whether a first prompt may follow on the command line as an argument. */
  positionalPrompt: boolean;
}

const CONVERSATION_GRAMMARS: ReadonlyMap<string, AgentConversationGrammar> = new Map<
  string,
  AgentConversationGrammar
>([
  [
    "claude-code",
    {
      launch: "--session-id",
      resume: "--resume",
      continueLatest: "--continue",
      // Claude Code's help names "manual" where it reads "default"; releases
      // before that know only "default", so that is what is written.
      permissionMode: {
        flag: "--permission-mode",
        modes: new Map([
          ["acceptEdits", "acceptEdits"],
          ["auto", "auto"],
          ["bypassPermissions", "bypassPermissions"],
          ["default", "default"],
          ["dontAsk", "dontAsk"],
          ["manual", "default"],
          ["plan", "plan"],
        ]),
      },
      positionalPrompt: true,
    },
  ],
  // Codex names its own sessions, so it cannot be launched under an id, and
  // takes `resume` as a subcommand after the global flags. How it is told its
  // approval policy across a move is decided with Codex carry; until then a
  // line that must state a mode is not one Codex gets.
  [
    "codex",
    {
      launch: null,
      resume: "resume",
      continueLatest: "resume --last",
      permissionMode: null,
      positionalPrompt: false,
    },
  ],
]);

/** The conversation grammar for an agent kind, or null for a CLI SPAWN D
 *  knows no way to resume. */
export function agentConversationGrammar(
  kind: string | null | undefined,
): AgentConversationGrammar | null {
  return (kind && CONVERSATION_GRAMMARS.get(kind.trim().toLowerCase())) || null;
}

/** Whether a window of this kind can be brought back to its conversation at all. */
export function agentCanResume(kind: string | null | undefined): boolean {
  const grammar = agentConversationGrammar(kind);
  return Boolean(grammar && (grammar.resume || grammar.continueLatest));
}

/** A conversation id as Claude Code and Codex write one: a UUID, 8-4-4-4-12
 *  hex digits, hyphenated. Read in either case; written lower-case. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id a line may name, lower-case, or null. The id comes from the
 * server's record or a host's answer, and a CLI reads a word that starts with
 * `-` as one of its own options: `--resume --dangerously-skip-permissions`
 * would turn on the very mode an explicit `--permission-mode` is there to
 * rule out. So only a canonical UUID ever reaches a line, written lower-case
 * as both CLIs write theirs (one recorded in upper case is the same
 * conversation); anything else — a flag, a path, `..`, a braced or
 * unhyphenated UUID, a word with spaces or quotes, a value that is not a
 * string — is no id at all, and the line reopens the latest conversation in
 * the folder or starts one the CLI names itself.
 *
 * This is the one id rule on each client: everything else that reads a
 * conversation id — a host's `conv.inspect` answer, a transcripts query,
 * Restart — takes it from here (web `lib/conversation.ts`, mobile
 * `terminal/transport/conversation-id.ts`).
 */
export function canonicalConversationId(id: unknown): string | null {
  return typeof id === "string" && CONVERSATION_ID.test(id) ? id.toLowerCase() : null;
}

/** What the agent comes back as: a conversation reopened — this one, or the
 *  latest one in the folder when there is none (null, empty, or anything but
 *  a canonical UUID) — or a fresh one started, under this id where the CLI
 *  takes one and the id is a canonical UUID. */
export type RelaunchConversation = { resume: string | null } | { start: string | null };

export interface RelaunchLineOptions {
  /** The shell the line is typed into; POSIX when unsaid. */
  shell?: ShellFamily | undefined;
  /** The permission mode the agent starts in. It replaces the yolo flag,
   *  which Claude Code ranks above any mode it is given. */
  permissionMode?: string | null | undefined;
  /** The agent's first prompt, as the line's last argument. */
  prompt?: string | null | undefined;
}

/**
 * The line that brings an agent back, or null when it cannot be said as
 * asked: a conversation to reopen for a CLI SPAWN D cannot resume, a
 * permission mode the CLI has no flag or no such mode for, a prompt the CLI
 * or the shell cannot take on the command line. Nothing asked for is ever
 * silently left off, with one exception that is the point: an id that is
 * not a canonical UUID is never typed (`canonicalConversationId`).
 */
export function relaunchLine(
  agent: RelaunchAgent,
  conversation: RelaunchConversation,
  { shell = "posix", permissionMode = null, prompt = null }: RelaunchLineOptions = {},
): string | null {
  const grammar = agentConversationGrammar(agent.kind);
  const spelling = spellingFor(shell);
  let mode: string | null = null;
  if (permissionMode !== null) {
    mode = grammar?.permissionMode?.modes.get(permissionMode) ?? null;
    if (mode === null) return null;
  }
  if (prompt !== null && !(grammar?.positionalPrompt && quotesNotes(shell))) return null;
  const words = [runCommand(agent, spelling, mode === null)];
  if ("start" in conversation) {
    const id = canonicalConversationId(conversation.start);
    if (id && grammar?.launch) words.push(`${grammar.launch} ${shellQuote(id, spelling)}`);
  } else {
    if (!grammar) return null;
    const id = canonicalConversationId(conversation.resume);
    if (id && grammar.resume) words.push(`${grammar.resume} ${shellQuote(id, spelling)}`);
    else if (grammar.continueLatest) words.push(grammar.continueLatest);
    else return null;
  }
  if (mode !== null && grammar?.permissionMode) {
    words.push(`${grammar.permissionMode.flag} ${shellQuote(mode, spelling)}`);
  }
  if (prompt !== null) words.push(shellQuote(prompt, spelling));
  return words.join(" ");
}

/**
 * What starting an agent types when the window is to remember its
 * conversation: the run command with the id the CLI is told to use. Without
 * a grammar for the kind, or without an id, exactly the run command.
 */
export function agentLaunchCommand(agent: RelaunchAgent, conversationId: string | null): string {
  return relaunchLine(agent, { start: conversationId }) ?? agentRunCommand(agent);
}

/**
 * What a restart types to bring the agent back where it was: resume the
 * conversation it names, or the latest one in this folder when there is none
 * to name. Null when this kind of agent cannot be resumed at all, so the
 * caller falls back to a plain relaunch and says so.
 */
export function agentResumeCommand(
  agent: RelaunchAgent,
  conversationId: string | null,
): string | null {
  return relaunchLine(agent, { resume: conversationId });
}

/** The host names in a note are cut to this many code points; a folder
 *  longer than the other limit is left out rather than cut. */
const NAME_LIMIT = 40;
const PATH_LIMIT = 160;
/** The only ASCII a host name keeps in a note. A name comes from the
 *  server's row and the note speaks with SPAWN D's voice, so it keeps no
 *  shell syntax, no markup, no quotes and no slash. It can still say a few
 *  words of its own, up to 40 code points of them: the name is the server's
 *  word, not the host's, until names travel end to end. */
const NAME_ASCII = /^[A-Za-z0-9 ._()-]$/;

/** Characters that space words apart: each is one plain space in a name. */
function spacing(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/**
 * Characters a reader cannot see or that steer a terminal or a line editor:
 * controls; line and paragraph separators; every Default_Ignorable code
 * point of Unicode 15 (soft hyphen, combining grapheme joiner, Hangul and
 * Khmer fillers, Mongolian variation selectors, zero-width and
 * bidirectional formatting, variation selectors, tag characters — which can
 * spell text no one sees — shorthand and musical format controls); lone
 * surrogates, the interlinear annotation controls, private use and
 * noncharacters. Spelled as ranges rather than Unicode properties so every
 * JavaScript engine draws the same line.
 */
function invisible(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x34f ||
    cp === 0x61c ||
    (cp >= 0x115f && cp <= 0x1160) ||
    (cp >= 0x17b4 && cp <= 0x17b5) ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xfdd0 && cp <= 0xfdef) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfffb) ||
    (cp & 0xfffe) === 0xfffe ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) ||
    (cp >= 0xe0000 && cp <= 0xe0fff) ||
    cp >= 0xf0000
  );
}

/**
 * A host's name as a note says it: spacing made plain, everything invisible
 * and every ASCII character but letters, digits, space and `. _ ( ) -`
 * dropped, cut to 40 code points. A name with nothing left is `fallback`.
 */
export function noteHostName(name: string | null | undefined, fallback: string): string {
  let kept = "";
  for (const char of name ?? "") {
    const cp = char.codePointAt(0) ?? 0;
    if (spacing(cp)) kept += " ";
    else if (!invisible(cp) && (cp >= 0x80 || NAME_ASCII.test(char))) kept += char;
  }
  const words = kept.replace(/ +/g, " ").replace(/^ | $/g, "");
  if (!words) return fallback;
  const points = Array.from(words);
  return points.length > NAME_LIMIT ? `${points.slice(0, NAME_LIMIT - 1).join("")}…` : words;
}

const NOTE_OS: ReadonlyMap<string, string> = new Map([
  ["linux", "Linux"],
  ["darwin", "macOS"],
  ["macos", "macOS"],
  ["windows", "Windows"],
]);

/** A host's OS as a note names it, or null for one it does not name. */
export function noteOs(os: string | null | undefined): string | null {
  return os ? (NOTE_OS.get(os.trim().toLowerCase()) ?? null) : null;
}

/**
 * A folder as a note shows it: exactly as the daemon reported it, or not at
 * all. A path is never altered to fit, since the agent acts on it: one with
 * anything invisible, a double quote (which old PowerShell drops from an
 * argument) or more than 160 code points is left out.
 */
export function notePath(path: string | null | undefined): string | null {
  if (!path || path.trim() === "") return null;
  const points = Array.from(path);
  if (points.length > PATH_LIMIT) return null;
  return points.some((char) => char === '"' || invisible(char.codePointAt(0) ?? 0)) ? null : path;
}

export interface MoveNoteHost {
  /** The host's name, from the server's row. */
  name?: string | null | undefined;
  /** The host's OS, from the server's row. */
  os?: string | null | undefined;
}

export interface MoveNoteFacts {
  from: MoveNoteHost;
  to: MoveNoteHost;
  /** The folder the agent continues in, as the target's daemon reported it. */
  cwd?: string | null | undefined;
  /** Where the target keeps this project's memory, as its daemon reported
   *  it: from the repository root, not the folder. */
  memoryPath?: string | null | undefined;
  /** The agent's state on the source when the person confirmed, as
   *  `conv.inspect` names it. Only `running` and `blocked` are mid-turn;
   *  anything else, unknown included, is idle. */
  state?: string | null | undefined;
}

function midTurn(state: string | null | undefined): boolean {
  return state === "running" || state === "blocked";
}

function noteWhere(host: MoveNoteHost, fallback: string): { name: string; full: string } {
  const name = noteHostName(host.name, fallback);
  const os = noteOs(host.os);
  return { name, full: os ? `${name} (${os})` : name };
}

/**
 * The note an agent gets after a move. Mid-turn it is a full turn, told the
 * work was cut off; idle it is a bracketed prefix for the person's next
 * message, ending in a space so their words follow it. It never starts with
 * `/` or `!`, which Claude Code would read as a command.
 */
export function composeMoveNote(facts: MoveNoteFacts): string {
  const from = noteWhere(facts.from, "another host");
  const to = noteWhere(facts.to, "this host");
  const cwd = notePath(facts.cwd);
  const memory = notePath(facts.memoryPath);
  if (midTurn(facts.state)) {
    return [
      `[SPAWN D] This conversation just moved from ${from.full} to ${to.full}`,
      cwd ? ` and continues in ${cwd}.` : ".",
      ` Files were not copied, so anything not pushed from ${from.name} is missing here.`,
      ` Background tasks and ${from.name}-only MCP tools did not come along.`,
      memory
        ? ` The memory folder named in your instructions is on ${from.name}; save memories under ${memory} instead.`
        : "",
      facts.state === "running"
        ? " You were in the middle of a task: check whether your last action took effect, then carry on."
        : " You were waiting for an answer to a prompt when it moved, and it was not answered: ask again if you still need it.",
    ].join("");
  }
  return [
    `[SPAWN D: moved from ${from.full} to ${to.full}`,
    cwd ? `, now in ${cwd}.` : ".",
    ` Not carried: unpushed files, background tasks, ${from.name}-only MCP tools.`,
    memory ? ` Save memories under ${memory}.` : "",
    "] ",
  ].join("");
}

/**
 * How a note reaches the agent.
 *  - `positional`: the line's last argument, so the agent takes it as its
 *    first turn the moment it starts.
 *  - `typed`: typed into the agent once it shows its ready prompt, then Enter.
 *  - `typed_no_enter`: typed into the agent once it is ready, and never sent:
 *    the person's next message carries it.
 */
export type NoteDelivery = "positional" | "typed" | "typed_no_enter";

/**
 * Mid-turn, the note is the agent's first prompt where the CLI takes one on
 * its command line, the shell's quoting is one SPAWN D has seen hold at its
 * prompt, and the target (`os`, from the server's row) is Linux or macOS;
 * elsewhere it is typed and sent. On Windows the line can reach the agent
 * through npm's `.cmd` shim, and cmd rewrites `%NAME%` even inside quotes, so
 * until a Windows target is proven (spike S5) its note is typed, and so is a
 * note for a host whose OS no one named. Idle, it is typed and never sent:
 * an idle agent would otherwise spend a whole turn answering a note no one
 * asked it about.
 */
export function noteDelivery(
  agentKind: string | null | undefined,
  family: ShellFamily,
  state: string | null | undefined,
  os: string | null | undefined,
): NoteDelivery {
  if (!midTurn(state)) return "typed_no_enter";
  const target = noteOs(os);
  return agentConversationGrammar(agentKind)?.positionalPrompt &&
    quotesNotes(family) &&
    (target === "Linux" || target === "macOS")
    ? "positional"
    : "typed";
}

/**
 * The longest line a note may ride, in UTF-8 bytes. A device types the line
 * the moment the fresh shell's transport opens, often before the shell's line
 * editor has taken the terminal, so the line can wait in the kernel's
 * canonical-mode buffer — 1,024 bytes on macOS (MAX_INPUT), where anything
 * past it, Enter included, is dropped and the line never runs. busybox's
 * line editor stops at 1,024 bytes too. Past this budget the note is typed
 * into the agent instead.
 */
const POSITIONAL_LINE_BYTES = 900;

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export interface RelaunchRequest {
  agent: RelaunchAgent;
  conversation: RelaunchConversation;
  /** The permission mode the agent starts in; none keeps today's line, and
   *  is refused with a note. */
  permissionMode?: string | null | undefined;
  /** The target's login shell as its daemon reported it; null when it did
   *  not say, which spells the line as for POSIX and types any note. */
  shell?: string | null | undefined;
  /** What a move tells the agent; none for a relaunch with nothing to say. */
  note?: MoveNoteFacts | null | undefined;
}

export interface RelaunchPlan {
  /** Typed into the fresh shell, then Enter. */
  line: string;
  /** The note and how it reaches the agent, or null for none. */
  note: { text: string; delivery: NoteDelivery } | null;
}

/**
 * Everything a relaunch types, or null when the line cannot be said as asked
 * (`relaunchLine`). A note says the conversation was carried here, and a
 * carried conversation starts in the mode the Operator chose on this host,
 * never the one its record carries: a note without a permission mode has no
 * line, which is why Codex, with no mode to state until Codex carry, gets
 * none. A note that would take the line past its byte budget is typed.
 */
export function planRelaunch(request: RelaunchRequest): RelaunchPlan | null {
  const family = shellFamily(request.shell);
  const facts = request.note ?? null;
  const permissionMode = request.permissionMode ?? null;
  if (facts && permissionMode === null) return null;
  const text = facts ? composeMoveNote(facts) : null;
  let delivery = facts ? noteDelivery(request.agent.kind, family, facts.state, facts.to.os) : null;
  const compose = (prompt: string | null) =>
    relaunchLine(request.agent, request.conversation, { shell: family, permissionMode, prompt });
  let line = compose(delivery === "positional" ? text : null);
  if (line !== null && delivery === "positional" && utf8Bytes(line) > POSITIONAL_LINE_BYTES) {
    delivery = "typed";
    line = compose(null);
  }
  if (line === null) return null;
  return { line, note: text !== null && delivery !== null ? { text, delivery } : null };
}
