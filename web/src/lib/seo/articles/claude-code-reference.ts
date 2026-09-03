import type { ArticleEntry } from "../flat-types";

/*
 * Claude Code reference cluster (grimoire play 1): the tutorial, settings and
 * commands references, the explainer, the country fix. Pure data on the
 * article template; see definitions.ts for the exemplar.
 *
 * Facts checked 2026-09-03 against:
 *   https://code.claude.com/docs/en/setup
 *   https://code.claude.com/docs/en/quickstart
 *   https://code.claude.com/docs/en/overview
 *   https://code.claude.com/docs/en/authentication
 *   https://code.claude.com/docs/en/settings
 *   https://code.claude.com/docs/en/settings-reference
 *   https://code.claude.com/docs/en/settings-example
 *   https://code.claude.com/docs/en/managed-settings
 *   https://code.claude.com/docs/en/permission-modes
 *   https://code.claude.com/docs/en/hooks
 *   https://code.claude.com/docs/en/memory
 *   https://code.claude.com/docs/en/sessions
 *   https://code.claude.com/docs/en/commands
 *   https://code.claude.com/docs/en/cli-reference
 *   https://code.claude.com/docs/en/interactive-mode
 *   https://code.claude.com/docs/en/skills
 *   https://code.claude.com/docs/en/network-config
 *   https://code.claude.com/docs/en/errors
 *   https://code.claude.com/docs/en/troubleshoot-install
 *   https://code.claude.com/docs/en/amazon-bedrock
 *   https://code.claude.com/docs/en/google-vertex-ai
 *   https://code.claude.com/docs/en/microsoft-foundry
 *   https://www.anthropic.com/supported-countries
 *   https://platform.claude.com/docs/en/api/supported-regions
 *   https://claude.com/app-unavailable-in-region
 *   https://claude.com/pricing
 *   https://claude.com/product/overview
 *   https://support.claude.com/en/articles/11049741-what-is-the-max-plan
 *   https://support.claude.com/en/articles/8325609-how-do-i-sign-up-for-the-pro-plan
 *   https://github.com/anthropics/claude-code/issues/2279
 *
 * Not verifiable today: the exact current wording of the CLI's country note.
 * The errors reference documents the "Unable to connect to Anthropic services"
 * block and says the tool "may not be available in your country"; the verbatim
 * "Note: Claude Code might not be available in your country" line is quoted
 * from user reports (issue #2279). The fix page quotes the documented block and
 * describes the note without asserting its current punctuation.
 */

export const CLAUDE_CODE_REFERENCE: ArticleEntry[] = [
  {
    slug: "claude-vs-claude-code",
    kind: "explainer",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Claude vs Claude Code: which one you actually need",
    description:
      "What Claude is, what Claude Code is, where each runs, what each can touch, how each is paid for, and which one to reach for — plus the machine that separates them.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Claude vs",
      accent: "Claude Code",
      sub: "Same company, same models, two different products. Here is what each one is, where it runs, what it can touch, and how to tell which one your question is really about.",
    },
    body: [
      {
        kind: "prose",
        heading: "Two products, one name.",
        paragraphs: [
          "Claude is the assistant. It is the thing you talk to at [claude.ai](https://claude.ai), in the desktop apps for macOS and Windows, in the iOS and Android apps, and through the Chrome extension. Underneath it is a family of models — Opus, Sonnet, Haiku, and the Fable line — and the same models are sold separately through the API to people building their own software. When someone says “ask Claude”, they mean this: a chat window, a file you upload, an answer that comes back.",
          "Claude Code is a different product built on the same models. Anthropic’s own definition is the useful one: an agentic coding tool that reads your codebase, edits files, runs commands, and integrates with your development tools. It lives in a terminal. You point it at a project directory, describe a change, and it goes and makes it — reading files, running your tests, committing when you ask. It is an agent with hands, where Claude the app is an assistant with a text box.",
          "The confusion is fair, because the two share a login, a subscription, and a name, and because Claude Code now also has a desktop app, a web version at claude.ai/code, and VS Code and JetBrains extensions. The distinction that survives all of that: Claude answers you; Claude Code acts on a machine.",
        ],
      },
      {
        kind: "table",
        heading: "Side by side.",
        columns: ["Question", "Claude", "Claude Code"],
        rows: [
          [
            "What it is",
            "A chat assistant: apps and a web interface over the Claude models",
            "An agentic coding tool: a CLI that plans and carries out changes in a repository",
          ],
          [
            "Where it runs",
            "Anthropic’s service, reached from apps on web, macOS, Windows, iOS, and Android",
            "Your machine, in a terminal, in the directory you start it in — plus a hosted web version, a desktop app, and IDE extensions",
          ],
          [
            "What it can touch",
            "What you paste or upload, and the tools and connectors you enable",
            "The files in your project, your shell, git, your tests, MCP servers you connect — with a permission model deciding what runs without asking",
          ],
          [
            "How you talk to it",
            "Conversation; it replies",
            "Instructions; it works, shows diffs, asks before risky actions, and reports back",
          ],
          [
            "How it’s paid for",
            "Free tier for chat; Pro at $20 a month ($17 on annual billing); Max at $100 or $200; Team and Enterprise per seat",
            "Included with Pro, Max, Team, and Enterprise, not with the free plan; or pay per token through the Console API, Amazon Bedrock, Google Cloud, or Microsoft Foundry",
          ],
          [
            "Use it when",
            "You want an answer, a draft, an explanation, or a review of something you paste in",
            "You want the change made: a bug fixed across files, tests written and run, a refactor carried through",
          ],
        ],
        note: "Prices from [claude.com/pricing](https://claude.com/pricing) and Anthropic’s support pages; access rules from the [Claude Code setup docs](https://code.claude.com/docs/en/setup). Checked September 2026.",
      },
      {
        kind: "prose",
        heading: "What “on a machine” actually means.",
        paragraphs: [
          "The practical difference is not intelligence — it is the same model on both sides — but the surface. Claude the app has no filesystem: you carry context to it. Claude Code has one, and it is yours. It reads `CLAUDE.md` from the project root for standing instructions, keeps a transcript of every session under `~/.claude/projects/`, remembers which commands you allowed, and resumes a conversation with `claude --continue`. All of that is state on the machine where it ran.",
          "This is also why the permission model matters more in Claude Code. In Claude, a wrong answer is text you ignore. In Claude Code, a wrong action is a file changed or a command run, so the CLI has modes — Manual, accept-edits, plan, auto — and a settings file where you list what may run without asking. Read the [Claude Code overview](https://code.claude.com/docs/en/overview) once and the split stops being confusing: one is a place to think, the other is a worker on a box.",
        ],
      },
      {
        kind: "points",
        heading: "Common cases, sorted.",
        lead: "The question people are usually asking, and which product answers it.",
        items: [
          {
            title: "I want to learn or plan before touching code",
            body: "Claude. Paste the design, ask the questions, get the tradeoffs. Then take the plan to Claude Code — or start Claude Code in plan mode, which reads the repository and proposes without editing anything.",
          },
          {
            title: "I want a change made in my repository",
            body: "Claude Code. The whole point is that it can open the files, run the tests, and commit. Doing this by copying files into a chat window is the thing Claude Code was built to replace.",
          },
          {
            title: "I don’t have a terminal",
            body: "Claude, or Claude Code’s desktop app and web version. The web version at claude.ai/code runs in Anthropic’s cloud against a repository you connect; the desktop app bundles the CLI. Both need a paid plan.",
          },
          {
            title: "I’m paying for Pro or Max already",
            body: "Both. The subscription covers the apps and Claude Code. Whether the plan is enough for agent work is a separate question, covered at [/is-claude-code-free](/is-claude-code-free) and [/claude-code-max-plan](/claude-code-max-plan).",
          },
        ],
      },
      {
        kind: "prose",
        heading: "The machine can be anywhere.",
        paragraphs: [
          "Because Claude Code runs on a machine rather than in a chat window, the machine becomes the interesting variable. It can be the laptop in front of you, and for most people it is. It can also be a workstation at the office, a Mac mini under a desk, or the build box with the GPU — wherever the repository, the toolchain, and the credentials already live. Anthropic’s own Remote Control and web version cover part of this; the rest is the ordinary problem of reaching a machine you own without exposing it.",
          "That is the gap spawnd fills: one daemon on each host you own, dialing out so nothing listens, and any browser — including the one on your phone — as the console. Claude Code keeps running on the host as a persistent session; you keep watching it from wherever you are. How that works in practice is at [/claude-code-remote](/claude-code-remote), and the phone specifically is at [/claude-code-on-your-phone](/claude-code-on-your-phone).",
        ],
      },
    ],
    start: "Run Claude Code on the machine that has the code.",
    faq: [
      {
        q: "Is Claude Code just Claude in a terminal?",
        a: "No. It is a separate agentic tool built on the same models: it reads and edits files, runs commands, and manages git on the machine where it runs. Claude the app has no access to your filesystem.",
      },
      {
        q: "Do I need a separate subscription for Claude Code?",
        a: "No. Pro, Max, Team, and Enterprise plans include Claude Code. The free plan does not; the alternatives are pay-per-token access through the Console API or a cloud provider such as Amazon Bedrock.",
      },
      {
        q: "Can Claude Code run without my laptop?",
        a: "Yes, if it runs on a different machine. Sessions are stored on the host that runs them. spawnd keeps that host reachable from any browser and keeps each session alive in its own worker process, so the laptop can close.",
      },
    ],
    related: [
      {
        title: "Claude Code on your phone",
        blurb: "the agent on a host, the console in your pocket",
        href: "/claude-code-on-your-phone",
      },
      {
        title: "spawnd for Claude Code",
        blurb: "what the daemon adds to a session you already run",
        href: "/for/claude-code",
      },
      {
        title: "Is Claude Code free?",
        blurb: "subscription versus API, and what each actually costs",
        href: "/is-claude-code-free",
      },
    ],
    cardTitle: "Claude vs Claude Code",
    cardBlurb: "The assistant, the agent, and the machine that tells them apart.",
  },

  {
    slug: "how-to-run-claude-code",
    kind: "guide",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "How to run Claude Code: install, log in, first task",
    description:
      "Install Claude Code, sign in, run a first task, learn the permission loop and CLAUDE.md, resume sessions — every command verified — and where it stops.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "How to run",
      accent: "Claude Code",
      sub: "Install it, sign in, give it a first job, and learn the loop — every command checked against the current docs, and an honest note on where it stops.",
    },
    body: [
      {
        kind: "prose",
        heading: "What you need before you start.",
        paragraphs: [
          "Claude Code runs on macOS 13 or later, Windows 10 (1809) or Windows Server 2019 or later, and Ubuntu 20.04, Debian 10, or Alpine 3.19 and up, on x64 or ARM64 with 4 GB of RAM or more. It needs an internet connection, a shell (Bash, Zsh, PowerShell, or CMD), and an account in a [supported country](https://www.anthropic.com/supported-countries). The requirements in full are in the [setup docs](https://code.claude.com/docs/en/setup).",
          "You also need an account it can bill to. Claude Pro, Max, Team, and Enterprise all include Claude Code; the free claude.ai plan does not. The alternatives are a Claude Console account, which is pay-per-token API access, or a cloud provider — Amazon Bedrock, Google Cloud, or Microsoft Foundry — if your organization runs one. Node.js is not required for the recommended installer.",
        ],
      },
      {
        kind: "steps",
        heading: "The setup, in order.",
        steps: [
          {
            title: "Install it",
            body: "The native installer is the recommended route on macOS, Linux, and WSL, and it keeps itself updated in the background. Homebrew and WinGet work too but do not auto-update; `brew upgrade claude-code` and `winget upgrade Anthropic.ClaudeCode` do that by hand. The npm package (`npm install -g @anthropic-ai/claude-code`, Node 22 or later) installs the same native binary. On Windows PowerShell the command is `irm https://claude.ai/install.ps1 | iex`.",
            code: {
              caption: "macOS, Linux, WSL",
              lines: [
                "curl -fsSL https://claude.ai/install.sh | bash",
                "",
                "# or, on macOS with Homebrew",
                "brew install --cask claude-code",
              ],
            },
          },
          {
            title: "Check it landed",
            body: "`claude --version` prints a version followed by `(Claude Code)`. If the shell says command not found, the installer put its launcher in `~/.local/bin` and that directory is not on your PATH yet; open a new terminal or add it. `claude doctor` runs a read-only diagnostic of the install and your settings files without starting a session.",
            code: { lines: ["claude --version", "claude doctor"] },
          },
          {
            title: "Sign in",
            body: "Run `claude` in any directory. On first launch it opens a browser to sign in; pick your Claude.ai account for Pro, Max, Team, or Enterprise, or the Console for API billing. If the browser cannot reach the terminal’s local callback — common over SSH, in WSL2, and in containers — it shows a code to paste back. If `ANTHROPIC_API_KEY` is set in your environment, Claude Code skips the browser and asks you to approve the key instead. `/login` inside a session switches accounts; `/logout` signs out.",
            code: { lines: ["claude"] },
          },
          {
            title: "Start in a project",
            body: "Sessions are tied to the directory you start them in. Change into the repository and run `claude`. The prompt shows the version, the model, and the working directory. Type `/help` to list commands.",
            code: { lines: ["cd /path/to/your/project", "claude"] },
          },
          {
            title: "Ask before you act",
            body: "The first useful prompt is a question. Claude Code reads files as it needs them; you do not paste anything in. From there, ask for a change — it finds the file, shows the edit, and asks for a yes if the current mode requires one.",
            code: {
              caption: "First prompts, from the quickstart",
              lines: [
                "what does this project do?",
                "where is the main entry point?",
                "add a hello world function to the main file",
              ],
            },
          },
          {
            title: "Learn the permission loop",
            body: "Every action falls under a permission mode. Manual asks before edits, commands, and network access; accept-edits approves file edits and common filesystem commands; plan reads the codebase and proposes without changing anything; auto lets a second model review actions instead of you. On Pro, Max, and Team plans a terminal session starts in auto mode; elsewhere it starts in Manual. `Shift+Tab` cycles modes mid-session, `/plan` starts one prompt in plan mode, and the flag below starts a whole session there. The full set, including `dontAsk` and `bypassPermissions`, is under [permission modes](https://code.claude.com/docs/en/permission-modes).",
            code: { lines: ["claude --permission-mode plan"] },
          },
          {
            title: "Give it standing instructions",
            body: "`/init` reads the repository and writes a starting `CLAUDE.md` — build commands, test commands, conventions it can see; if one exists it suggests improvements instead. Claude Code loads that file at the start of every session, along with `~/.claude/CLAUDE.md` for personal preferences and a gitignored `CLAUDE.local.md` for private notes. Keep it under about 200 lines and concrete: “run `npm test` before committing” works, “test your changes” does not. `/memory` opens the files; `/context` shows what actually loaded.",
            code: { lines: ["/init"] },
          },
          {
            title: "Pick up where you left off",
            body: "Sessions are saved continuously to `~/.claude/projects/` on the machine. `claude --continue` reopens the most recent one in the current directory; `claude --resume` opens a picker; `claude --resume <name>` goes straight to a session you named with `/rename` or started with `claude -n <name>`. Inside a session, `/resume` switches conversations and `/clear` starts a fresh one without losing the old. For one-off questions from a script, `claude -p` prints an answer and exits.",
            code: {
              lines: [
                "claude --continue",
                "claude --resume auth-refactor",
                'cat error.log | claude -p "explain this failure"',
              ],
            },
          },
        ],
      },
      {
        kind: "table",
        heading: "The commands that matter on day one.",
        columns: ["Command", "What it does"],
        rows: [
          ["`/help`", "List available commands and skills"],
          ["`/clear`", "Start a new conversation with empty context; the old one stays resumable"],
          ["`/compact`", "Summarize the conversation so far to free up context"],
          ["`/model`", "Switch model and save it as your default"],
          ["`/permissions`", "Manage allow, ask, and deny rules"],
          ["`/config`", "Open settings: theme, model, editor mode, and more"],
          ["`/status`", "Show session status, login method, and which settings files loaded"],
          ["`/usage`", "Show token usage and cost for the session; `/cost` is an alias"],
          ["`/exit`", "Leave; `Ctrl+D` twice does the same"],
          ["`Esc`", "Interrupt Claude mid-turn without losing what it has done"],
        ],
        note: "The complete list, with flags and shortcuts, is at [/claude-code-commands](/claude-code-commands).",
      },
      {
        kind: "prose",
        heading: "It runs where you started it.",
        paragraphs: [
          "Here is the part the quickstart does not dwell on. An interactive Claude Code session is a process in the terminal that launched it. Close the terminal, let the laptop sleep on the train, drop the SSH connection, and the process is gone. The transcript survives — `claude --continue` will bring the conversation back — but whatever was running stops, and nothing happens while you are away.",
          "Anthropic’s answers to this are real and worth knowing. Remote Control (`/remote-control`) lets you follow a local session from your phone or another browser while the terminal stays up. Background agents (`claude --bg`, `/background`) hand a session to a per-user supervisor process that outlives your shell. Claude Code on the web runs the whole thing in Anthropic’s cloud against a repository you connect. And the oldest answer, tmux, still works: start `claude` inside a tmux session and reattach later.",
          "Every one of those still needs a machine that stays on and a way to reach it — and the tmux route needs you to remember it before the run that matters. That is where spawnd sits: one daemon on each host you own, dialing out so nothing listens; every session’s terminal owned by a worker process on the host, so it survives the closed tab, the dropped connection, and the laptop lid with scrollback intact; any browser or phone as the console. Claude Code authenticates on the host exactly as it does today — spawnd holds no provider credentials and uses your Pro or Max plan as the CLI uses it. The longer version is at [/use/keep-agents-running](/use/keep-agents-running) and [/claude-code-remote](/claude-code-remote).",
        ],
      },
    ],
    start: "Start it once, on a machine that stays on.",
    faq: [
      {
        q: "Do I need Node.js to run Claude Code?",
        a: "Not with the native installer, Homebrew, WinGet, or the Linux package repositories. Only the npm route asks for Node.js 22 or later, and even then the package installs a native binary that does not use Node at runtime.",
      },
      {
        q: "Can I use Claude Code on the free plan?",
        a: "No. The free claude.ai plan does not include Claude Code. Pro, Max, Team, and Enterprise do; a Console account with API credits or a cloud provider account works too.",
      },
      {
        q: "What happens to a session when I close the terminal?",
        a: "The interactive process ends and any running command stops. The transcript is saved on that machine, so claude --continue resumes the conversation. To keep a session alive while you are away it needs a host that stays on: tmux, Anthropic’s background agents, or spawnd, which owns each session in a worker process on the host.",
      },
    ],
    related: [
      {
        title: "Keep agents running",
        blurb: "sessions that survive the laptop, the tab, and the daemon",
        href: "/use/keep-agents-running",
      },
      {
        title: "Claude Code, remote",
        blurb: "Remote Control, the web version, and where they run out",
        href: "/claude-code-remote",
      },
      {
        title: "Claude Code commands",
        blurb: "slash commands, flags, and shortcuts in one place",
        href: "/claude-code-commands",
      },
    ],
    cardTitle: "How to run Claude Code",
    cardBlurb: "Install, sign in, first task, the loop, and where it stops.",
  },

  {
    slug: "claude-code-settings",
    kind: "reference",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Claude Code settings: the settings.json reference",
    description:
      "Where Claude Code reads settings.json, which scope wins, the permissions, env, hooks, model, and sandbox keys that matter, and copyable examples for you and a team.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Claude Code settings,",
      accent: "file by file",
      sub: "Where each settings.json lives, which one wins, the keys worth knowing, and examples you can copy — checked against the current settings reference.",
    },
    body: [
      {
        kind: "table",
        heading: "The files and who they affect.",
        lead: "Claude Code reads settings from JSON files at four scopes, plus a managed source an organization can deploy. Precedence, highest first: managed, then `--settings` on the command line, then project local, then shared project, then user.",
        columns: ["Scope", "Path", "Applies to"],
        rows: [
          [
            "Managed",
            "`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux and WSL, `C:\\Program Files\\ClaudeCode\\managed-settings.json` on Windows — or an MDM profile, or server-managed settings from the claude.ai console",
            "Everyone the organization deploys it to; nothing below overrides it",
          ],
          [
            "Command line",
            "`claude --settings <file-or-json>`",
            "That session only; overrides the files below, never managed",
          ],
          [
            "Project local",
            "`.claude/settings.local.json`",
            "You, in this project; kept out of version control",
          ],
          [
            "Shared project",
            "`.claude/settings.json`",
            "Everyone working in the repository, once you commit it",
          ],
          ["User", "`~/.claude/settings.json`", "You, in every project on this machine"],
        ],
        note: "Claude Code also keeps `~/.claude.json` for itself: sign-in state, MCP server configuration, and per-project trust decisions. You do not edit it. Full detail on the official [settings page](https://code.claude.com/docs/en/settings).",
      },
      {
        kind: "prose",
        heading: "How precedence really works.",
        paragraphs: [
          "A key set at a higher level replaces the same key set lower down, with two exceptions worth knowing. Lists merge rather than override: `permissions.allow` from your user file and your team’s project file are combined, and a `deny` rule wins over an `allow` rule wherever either comes from. And environment variables are not a level in the stack; each variable-and-key pair has its own rule, so `ANTHROPIC_MODEL` exported in your shell beats the `model` key from any file, while an `env` block inside a settings file is an ordinary key that follows the levels above.",
          "Two values are scope-limited: `permissions.defaultMode` of `auto` or `bypassPermissions` only takes effect from user settings, managed settings, or `--settings`, never from the project files a repository could commit. Files are strict JSON — a comment or a trailing comma is reported as a settings error at the next start. Claude Code watches the files and applies most edits, including permissions and hooks, to a running session. `/status` lists which files loaded; `claude doctor` lists entries it rejected.",
        ],
      },
      {
        kind: "table",
        heading: "The keys worth knowing.",
        lead: "The [settings reference](https://code.claude.com/docs/en/settings-reference) lists every key with its type, default, and scope. These are the ones people actually set.",
        columns: ["Key", "What it does", "Example"],
        rows: [
          [
            "`permissions.allow`",
            "Tool uses that run without a prompt",
            '`["Bash(npm run *)", "Read(~/.zshrc)"]`',
          ],
          ["`permissions.ask`", "Always prompt before these", '`["Bash(git push *)"]`'],
          [
            "`permissions.deny`",
            "Block these, including reads of files that hold secrets; beats allow",
            '`["Read(./.env)", "Read(./secrets/**)"]`',
          ],
          [
            "`permissions.defaultMode`",
            "Mode new sessions start in: `default` (Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`",
            '`"plan"`',
          ],
          [
            "`permissions.additionalDirectories`",
            "Directories outside the working one that Claude may read and edit",
            '`["~/projects/shared"]`',
          ],
          [
            "`permissions.disableBypassPermissionsMode`",
            "Remove bypass mode from every session; usually managed",
            '`"disable"`',
          ],
          [
            "`env`",
            "Environment variables for every session and its subprocesses — provider routing, proxies, telemetry",
            '`{"CLAUDE_CODE_USE_BEDROCK": "1"}`',
          ],
          [
            "`hooks`",
            "Your own commands at lifecycle events: `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, and others",
            "See the team example below",
          ],
          [
            "`model`",
            "Model new sessions start on; `--model` and `ANTHROPIC_MODEL` override it",
            '`"claude-sonnet-5"`',
          ],
          [
            "`availableModels`",
            "Restrict what `/model` and `--model` may pick",
            '`["opus", "sonnet"]`',
          ],
          [
            "`effortLevel`",
            "Default reasoning effort for models without a saved level of their own",
            '`"xhigh"`',
          ],
          [
            "`apiKeyHelper`",
            "A script that returns the API credential, re-run every five minutes by default",
            '`"~/.config/claude/get-key.sh"`',
          ],
          [
            "`cleanupPeriodDays`",
            "Days to keep session transcripts before deleting them; 30 by default",
            "`20`",
          ],
          [
            "`attribution`",
            "Change or hide the attribution added to commits and PRs; replaces the deprecated `includeCoAuthoredBy`",
            '`{"commit": "Claude Code"}`',
          ],
          [
            "`enableAllProjectMcpServers`",
            "Approve every server in a project’s `.mcp.json` without prompting",
            "`true`",
          ],
          [
            "`forceLoginMethod`, `forceLoginOrgUUID`",
            "Pin the login method and organization; enforced from managed settings",
            '`"claudeai"`',
          ],
          [
            "`statusLine`",
            "A command whose output renders below the prompt",
            '`{"type": "command", "command": "..."}`',
          ],
          [
            "`outputStyle`, `language`",
            "Change Claude’s role and tone, or have it answer in another language",
            '`"Spanish"`',
          ],
          [
            "`autoUpdatesChannel`",
            "`latest` (the default) or `stable`, about a week behind",
            '`"stable"`',
          ],
          [
            "`sandbox`",
            "Isolate Bash commands from the filesystem and network on macOS, Linux, and WSL2",
            '`{"enabled": true}`',
          ],
          ["`autoMemoryEnabled`", "Turn Claude’s own cross-session notes off", "`false`"],
          [
            "`claudeMdExcludes`",
            "Skip ancestor `CLAUDE.md` files by glob; useful in monorepos",
            '`["**/monorepo/CLAUDE.md"]`',
          ],
        ],
      },
      {
        kind: "prose",
        heading: "Permission rules, the syntax.",
        paragraphs: [
          "A rule is a tool name, optionally with a pattern in parentheses. `Bash(npm run *)` matches any npm script; `Bash(git push *)` matches pushes; `Read(./.env)` names one file relative to the project; `Edit(docs/**)` matches a tree; `WebFetch(domain:example.com)` scopes a domain; `mcp__server__tool` names one MCP tool. A bare tool name such as `Read` matches every use. Rules from every scope are merged, `deny` beats `allow`, and an `ask` rule from a project or managed file outranks an `allow` you saved locally with “don’t ask again” — which is the usual reason a prompt keeps coming back. The syntax in full is under [permission rule syntax](https://code.claude.com/docs/en/settings-reference#permission-rule-syntax).",
          "A personal file is small. The `$schema` line gives you autocomplete and validation in any editor that understands JSON schema; the rest is preference. This one starts every session on Sonnet in plan mode, follows the stable release channel, keeps transcripts for twenty days, and lets Claude Code run `git diff` and read your shell config without asking.",
        ],
        code: {
          caption: "~/.claude/settings.json",
          lines: [
            "{",
            '  "$schema": "https://json.schemastore.org/claude-code-settings.json",',
            '  "model": "claude-sonnet-5",',
            '  "editorMode": "vim",',
            '  "autoUpdatesChannel": "stable",',
            '  "cleanupPeriodDays": 20,',
            '  "permissions": {',
            '    "defaultMode": "plan",',
            '    "allow": ["Bash(git diff *)", "Read(~/.zshrc)"]',
            "  }",
            "}",
          ],
        },
      },
      {
        kind: "prose",
        heading: "A team file, with a hook.",
        paragraphs: [
          "The shared project file is the one to commit. It carries the permissions everyone should share, the environment the project needs, and hooks — shell commands Claude Code runs at fixed points, which, unlike `CLAUDE.md` instructions, are enforced regardless of what the model decides. The example below approves npm scripts, always confirms pushes, refuses to read secrets, and runs a script from the repository before every Bash command. Hooks nest three deep: the event, a matcher, and the handlers. Allow rules in a committed file take effect only after each person trusts the folder; deny and ask rules apply regardless.",
        ],
        code: {
          caption: ".claude/settings.json — committed with the repository",
          lines: [
            "{",
            '  "permissions": {',
            '    "allow": ["Bash(npm run *)"],',
            '    "ask": ["Bash(git push *)"],',
            '    "deny": ["Read(./.env)", "Read(./.env.*)", "Read(./secrets/**)"]',
            "  },",
            '  "env": {',
            '    "CLAUDE_CODE_ENABLE_TELEMETRY": "1"',
            "  },",
            '  "hooks": {',
            '    "PreToolUse": [',
            "      {",
            '        "matcher": "Bash",',
            '        "hooks": [',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: verbatim hook command from the docs; the shell expands it
            '          { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh" }',
            "        ]",
            "      }",
            "    ]",
            "  }",
            "}",
          ],
        },
      },
      {
        kind: "prose",
        heading: "Settings, CLAUDE.md, and flags.",
        paragraphs: [
          "Three things shape a session and they are easy to conflate. Settings are enforced configuration: permission rules, hooks, and the sandbox apply whatever the model intends. `CLAUDE.md` is instruction: loaded as context at the start of every session, followed well when it is specific, but not a hard boundary — the docs say so plainly and point you to a `PreToolUse` hook when something must never happen. Flags are one session’s overrides: `--permission-mode` beats `defaultMode`, `--model` beats `model`, `--allowedTools` and `--disallowedTools` add rules for the run, `--add-dir` grants directories without persisting them, and `--settings` layers a file or a JSON string above your files for the session. `/config` writes a few personal options to the user file, `/permissions` edits rules, and `/hooks` shows what is configured.",
          "One practical consequence: all of this lives on the host. The user file, the project files, the transcripts, the remembered approvals — they are on the machine where `claude` runs, not on the device you are looking at it from. Set a machine up once and every device that reaches it gets the same sessions, the same rules, the same history. That is the shape spawnd is built around: the host does the work and keeps the state, and a browser or a phone is only ever the console.",
        ],
      },
    ],
    start: "Set up the host once; every console inherits it.",
    faq: [
      {
        q: "Where is the Claude Code settings file?",
        a: "Personal settings are in ~/.claude/settings.json. Project settings are .claude/settings.json (shared, commit it) and .claude/settings.local.json (yours). Organizations deploy managed-settings.json in a system directory or push settings from the claude.ai console.",
      },
      {
        q: "Why isn’t my setting taking effect?",
        a: "Usually a higher scope sets the same key, or the key cannot apply from that file: auto and bypassPermissions in defaultMode only work from user or managed settings. Run /status to see which files loaded and claude doctor to see rejected entries.",
      },
      {
        q: "Do settings sync between machines?",
        a: "No. Settings and transcripts are files on each host. Committing .claude/settings.json shares project rules through git; personal settings stay per machine unless you copy them. Reaching one configured host from several devices is what spawnd is for.",
      },
    ],
    related: [
      {
        title: "Claude Code commands",
        blurb: "the slash commands and flags these settings shape",
        href: "/claude-code-commands",
      },
      {
        title: "spawnd for Claude Code",
        blurb: "the host does the work; the browser is the console",
        href: "/for/claude-code",
      },
      {
        title: "Run agents in parallel",
        blurb: "several sessions, one grid, one set of host-side rules",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "Claude Code settings",
    cardBlurb: "Every settings.json, which one wins, and the keys worth setting.",
  },

  {
    slug: "claude-code-commands",
    kind: "reference",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Claude Code commands: slash commands, flags, shortcuts",
    description:
      "Built-in slash commands, the CLI flags people actually use, keyboard shortcuts, and how custom commands work now that they are skills — checked against the docs.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Claude Code",
      accent: "commands",
      sub: "The built-in slash commands, the CLI flags people actually type, the keyboard shortcuts, and how to add your own — verified against the current reference.",
    },
    body: [
      {
        kind: "table",
        heading: "Built-in slash commands.",
        lead: "Type `/` in a session to open the menu. This is the set most people reach for; a few are bundled skills rather than commands, which changes nothing about how you type them. The complete table, aliases included, is the [commands reference](https://code.claude.com/docs/en/commands).",
        columns: ["Command", "What it does"],
        rows: [
          ["`/help`", "Show help and available commands"],
          ["`/clear`", "Start a new conversation with empty context; aliases `/reset`, `/new`"],
          [
            "`/compact [instructions]`",
            "Replace the history with a summary, optionally focused on what you name",
          ],
          ["`/context`", "Show what is consuming the context window, as a grid"],
          ["`/usage`", "Token usage and cost for the session; `/cost` is an alias"],
          ["`/status`", "Session status: login, model, provider, which settings files loaded"],
          ["`/config`", "Open the settings interface; alias `/settings`"],
          ["`/model [model]`", "Switch model and save it as the default for new sessions"],
          ["`/effort [level]`", "Set reasoning effort, `low` to `max`, or `auto`"],
          ["`/permissions`", "Manage allow, ask, and deny rules; alias `/allowed-tools`"],
          ["`/plan [description]`", "Enter plan mode from the prompt"],
          ["`/init`", "Generate a starting `CLAUDE.md` from the repository"],
          ["`/memory`", "Edit `CLAUDE.md` files and toggle auto memory"],
          ["`/resume [name]`", "Switch to an earlier conversation"],
          ["`/rename <name>`", "Name the current session so it can be resumed by name"],
          ["`/branch [name]`", "Copy the conversation so far into a new branch and continue there"],
          ["`/rewind`", "Roll code and conversation back to a checkpoint"],
          ["`/export [filename]`", "Save the conversation as plain text"],
          ["`/diff`", "Interactive diff of uncommitted changes and per-turn edits"],
          ["`/add-dir <path>`", "Grant file access to another directory for this session"],
          ["`/cd <path>`", "Move the session to a new working directory, keeping the conversation"],
          ["`/mcp`", "Manage MCP server connections and their authentication"],
          ["`/hooks`", "Browse configured hooks; read-only"],
          ["`/agents`", "Subagents, which now live in `.claude/agents/` or `~/.claude/agents/`"],
          ["`/skills`", "Manage custom skills and view the bundled ones"],
          ["`/plugin`", "Manage plugins"],
          ["`/login`, `/logout`", "Sign in to or out of your account"],
          [
            "`/doctor`",
            "A setup checkup that diagnoses problems and can fix them; alias `/checkup`",
          ],
          ["`/vim`", "Toggle Vim keybindings"],
          ["`/theme`, `/statusline`", "Colour theme; the status bar below the prompt"],
          ["`/terminal-setup`", "Configure terminal integration"],
          ["`/release-notes`", "Recent release notes"],
          ["`/bug [report]`", "Report a bug or share the conversation; alias `/share`"],
          ["`/exit`", "Leave; alias `/quit`"],
          ["`/remote-control`", "Continue this local session from another device"],
          [
            "`/background [prompt]`",
            "Detach the session to run as a background agent; alias `/bg`",
          ],
          ["`/tasks`", "List background work, including finished subagents"],
          [
            "`/fork [prompt]`",
            "Copy the conversation into a new background session and keep working here",
          ],
          ["`/teleport`", "Pull a web session into this terminal"],
          ["`/desktop`", "Continue the session in the desktop app; alias `/app`"],
          [
            "`/code-review`",
            "Review the current diff or a PR for bugs and cleanups; alias `/review`",
          ],
          ["`/loop [interval] [prompt]`", "Run a prompt repeatedly while the session stays open"],
          ["`/btw [question]`", "Ask a side question without adding it to the conversation"],
          ["`/fast [on|off]`", "Toggle fast mode"],
          ["`/copy [N]`", "Copy the last response to the clipboard"],
        ],
      },
      {
        kind: "table",
        heading: "CLI flags you will actually type.",
        columns: ["Invocation", "What it does"],
        rows: [
          ["`claude`", "Start an interactive session in the current directory"],
          ['`claude "query"`', "Start interactive with an initial prompt"],
          [
            '`claude -p "query"`',
            'Print mode: answer and exit; pipe input with `cat file | claude -p "…"`',
          ],
          ["`-c`, `--continue`", "Reopen the most recent conversation in this directory"],
          ["`-r`, `--resume [name or id]`", "Resume a specific session, or open the picker"],
          ["`-n <name>`", "Name the session at startup so `--resume <name>` finds it"],
          ["`--fork-session`", "When resuming, branch into a new session ID"],
          [
            "`--from-pr <number>`",
            "Open the picker filtered to sessions linked to that pull request",
          ],
          [
            "`--model <alias or id>`",
            "Model for this session: `sonnet`, `opus`, `haiku`, or a full name",
          ],
          [
            "`--permission-mode <mode>`",
            "Start in `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, or `bypassPermissions`",
          ],
          [
            "`--allowedTools`, `--disallowedTools`",
            "Add allow or deny rules for the run, in permission-rule syntax",
          ],
          ["`--add-dir <path>`", "Grant extra working directories for this session"],
          ["`--settings <file or json>`", "Layer settings above your files for this session"],
          [
            "`--mcp-config <file>`",
            "Load MCP servers from JSON; `--strict-mcp-config` ignores every other source",
          ],
          [
            "`--output-format json`",
            "Structured output in print mode: `text`, `json`, or `stream-json`",
          ],
          ["`--max-turns <n>`", "Cap agentic turns in print mode"],
          ['`--append-system-prompt "…"`', "Append text to the default system prompt"],
          [
            "`--dangerously-skip-permissions`",
            "Skip permission prompts; the same as `--permission-mode bypassPermissions`",
          ],
          [
            "`--bg`",
            "Start as a background session, hosted by a supervisor that outlives your shell",
          ],
          ["`--teleport`", "Pull a web session into this terminal; needs a claude.ai subscription"],
          ["`--debug`", "Write a debug log to `~/.claude/debug/`"],
          ["`claude update`", "Update now instead of waiting for the background check"],
          ["`claude doctor`", "Read-only diagnostics for the install and settings"],
          ["`claude mcp`", "Configure MCP servers from the shell"],
          [
            "`claude setup-token`",
            "Mint a one-year OAuth token for CI, used as `CLAUDE_CODE_OAUTH_TOKEN`",
          ],
        ],
        note: "Every flag, with examples: the [CLI reference](https://code.claude.com/docs/en/cli-reference).",
      },
      {
        kind: "table",
        heading: "Keyboard shortcuts.",
        columns: ["Keys", "Effect"],
        rows: [
          [
            "`Ctrl+C`",
            "Interrupt; with nothing running, the first press clears the prompt and the second exits",
          ],
          ["`Ctrl+D`", "Exit, on a second press within 800 ms"],
          ["`Esc`", "Stop the current response or tool call; work so far is kept"],
          ["`Esc` `Esc`", "Clear the draft, or, with an empty prompt, open the rewind menu"],
          ["`Shift+Tab`", "Cycle permission modes"],
          ["`Ctrl+R`", "Reverse-search prompt history"],
          ["`Ctrl+O`", "Toggle the transcript viewer with tool detail"],
          ["`Ctrl+B`", "Background a running command or agent; tmux users press twice"],
          ["`Ctrl+G`", "Edit the prompt in your default editor"],
          ["`Ctrl+S`", "Stash the prompt; press again on an empty prompt to restore it"],
          ["`Ctrl+L`", "Redraw the screen"],
          ["`Ctrl+T`", "Toggle Claude’s task checklist"],
          ["`Ctrl+Z`", "Suspend to the shell; `fg` resumes (Unix)"],
          ["`Option+P` / `Alt+P`", "Switch model without clearing the prompt"],
          ["`Option+T` / `Alt+T`", "Toggle extended thinking"],
          ["`Up` / `Down`", "Move within a multiline prompt, then walk history"],
          ["`Tab`", "Accept an autocomplete suggestion"],
          [
            "`\\` then `Enter`, `Ctrl+J`, or `Shift+Enter`",
            "Insert a newline; `Shift+Enter` is native in iTerm2, WezTerm, Ghostty, Kitty, Warp, Apple Terminal, and Windows Terminal",
          ],
          ["`!` at the start", "Shell mode: run a command and add its output to the session"],
          ["`@`", "File path autocomplete"],
          ["`?` on empty input", "Toggle the shortcut help panel"],
        ],
        note: "Option-key shortcuts on macOS need Option configured as Meta in your terminal. `/vim` turns on Vim keybindings. Everything else: [interactive mode](https://code.claude.com/docs/en/interactive-mode).",
      },
      {
        kind: "prose",
        heading: "Custom commands are skills now.",
        paragraphs: [
          "A custom slash command is a Markdown file. The older form is `.claude/commands/deploy.md`, which creates `/deploy`; it still works. The current form is a skill: `.claude/skills/deploy/SKILL.md` in a project, or `~/.claude/skills/deploy/SKILL.md` for every project on the machine. Both create the same `/deploy`. A skill gets a directory for supporting files and can be loaded by Claude on its own when it is relevant, which a command file cannot. Personal skills beat project skills of the same name; a skill beats a command of the same name; plugin skills are namespaced as `/plugin-name:skill-name` so they never collide.",
          "The file is YAML frontmatter followed by instructions. `description` tells Claude when the skill applies; `argument-hint` shows in autocomplete; `allowed-tools` grants tools for the turn that invokes it; `model` overrides the model for that turn; `disable-model-invocation: true` makes it something only you can run, which is right for anything with side effects; `user-invocable: false` hides it from the menu for background knowledge. Arguments arrive as `$ARGUMENTS`, or positionally as `$0`, `$1`, and so on. The full frontmatter is under [skills](https://code.claude.com/docs/en/skills).",
        ],
        code: {
          caption: ".claude/skills/deploy/SKILL.md",
          lines: [
            "---",
            "description: Deploy the current branch to an environment",
            "argument-hint: [environment]",
            "disable-model-invocation: true",
            "allowed-tools: Bash(./scripts/deploy.sh *)",
            "---",
            "",
            "Deploy the current branch to the $0 environment.",
            "Run ./scripts/deploy.sh $0, then report the URL it prints.",
          ],
        },
      },
      {
        kind: "prose",
        heading: "One more thing about where these run.",
        paragraphs: [
          "Every command on this page runs inside a terminal on the machine where `claude` was started, and the session it belongs to lives there too. `/remote-control` is Anthropic’s way to follow one session from another device; spawnd is the way to keep every session on every host you own reachable from one browser, with the terminal itself owned by a worker process on the host so that backgrounding stops being a discipline. The keys are the same either way — a spawnd session is the real terminal, not a chat view of it. Details at [/claude-code-remote](/claude-code-remote).",
        ],
      },
    ],
    start: "Every command, on a host that stays on.",
    faq: [
      {
        q: "How do I see all Claude Code commands?",
        a: "Type / in a session to open the menu, or /help. A few commands are hidden from the menu until you type their full name; the docs’ commands reference lists everything, aliases included.",
      },
      {
        q: "What is the difference between /clear and /compact?",
        a: "/clear starts a new conversation with empty context and keeps the old one resumable with /resume. /compact keeps the conversation but replaces its history with a summary, optionally focused on instructions you pass.",
      },
      {
        q: "Where do custom slash commands live?",
        a: "In .claude/commands/<name>.md for the older form, or as a skill at .claude/skills/<name>/SKILL.md for a project or ~/.claude/skills/<name>/SKILL.md for yourself. Both create /<name>; a skill wins when the names collide.",
      },
    ],
    related: [
      {
        title: "Claude Code settings",
        blurb: "the files that decide what these commands may do",
        href: "/claude-code-settings",
      },
      {
        title: "How to run Claude Code",
        blurb: "install, sign in, first task, the loop",
        href: "/how-to-run-claude-code",
      },
      {
        title: "Claude Code on your phone",
        blurb: "the same commands, from a real terminal in your pocket",
        href: "/claude-code-on-your-phone",
      },
    ],
    cardTitle: "Claude Code commands",
    cardBlurb: "Slash commands, CLI flags, shortcuts, and your own.",
  },

  {
    slug: "claude-code-not-available-in-your-country",
    kind: "fix",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Fix: “Claude Code might not be available in your country”",
    description:
      "What the message means, where Claude Code checks region, the fixes in order — supported list, proxies, VPN egress, Bedrock and Vertex AI — and what no fix will do.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "“Claude Code might not be available",
      accent: "in your country”",
      sub: "What the message means, where the check actually happens, the fixes that work, in order, and what no fix will do.",
    },
    body: [
      {
        kind: "prose",
        heading: "What the message means.",
        paragraphs: [
          "The line shows up in the terminal on first run, under a connection failure: `Unable to connect to Anthropic services`, then the reason — `Failed to connect to api.anthropic.com: ECONNREFUSED`, or a timeout — then a note that Claude Code might not be available in your country, pointing at Anthropic’s [supported countries](https://www.anthropic.com/supported-countries). During setup Claude Code probes `api.anthropic.com` and `platform.claude.com` before it shows the sign-in step, gives each probe ten seconds, and exits if either fails. The country note is appended to that failure. It is a hint, not a verdict.",
          "That matters because the same message appears for reasons that have nothing to do with geography: a firewall, a corporate proxy, a TLS-inspecting gateway, Docker Desktop intercepting outbound traffic. The [GitHub issue](https://github.com/anthropics/claude-code/issues/2279) most people find was filed from a supported country with a refused connection. The real region signal looks different: an HTTP 403 whose body is an “App unavailable in region” page, or the install script failing with `syntax error near unexpected token '<'` because it downloaded that page instead of a script. On the account side, [claude.com](https://claude.com/app-unavailable-in-region) says it directly: Claude is only available in certain regions right now.",
          "The policy behind it, from Anthropic’s [support pages](https://support.claude.com/en/articles/8325609-how-do-i-sign-up-for-the-pro-plan): paid plans are only available to users physically located in a supported location, an account needs a phone number from a supported location, and the same list governs the API. Claude Code needs a paid plan or API access, so it inherits both rules.",
        ],
      },
      {
        kind: "steps",
        heading: "The fixes, in order.",
        steps: [
          {
            title: "Check the list, and the exceptions",
            body: "Read the [supported countries](https://www.anthropic.com/supported-countries) page rather than assuming. It is long, and it has partial entries — Ukraine is listed with occupied regions excluded. If your country is on it, the message is almost certainly a network problem; keep going. If it is not, skip to what not to expect.",
          },
          {
            title: "Prove it is the network, not the region",
            body: "From the same shell, ask the two hosts Claude Code probes. A refused connection or a timeout is local — a firewall, a proxy, a VPN, a container runtime. A 403 with an HTML body is the region check. If the request works in a browser but not in the terminal, something between the shell and the internet is filtering it.",
            code: {
              lines: ["curl -sI https://api.anthropic.com", "curl -sI https://platform.claude.com"],
            },
          },
          {
            title: "Give it the proxy",
            body: "Corporate networks usually need `HTTPS_PROXY` set before `claude` starts; when a probe went through a proxy, Claude Code names the variable in the error. TLS-inspecting proxies also need their root certificate trusted, through the OS store or `NODE_EXTRA_CA_CERTS`. SOCKS proxies are not supported. The hosts to allowlist are `api.anthropic.com`, `platform.claude.com`, `claude.ai`, `claude.com`, and `downloads.claude.ai`; the full table is in the [network configuration](https://code.claude.com/docs/en/network-config) docs.",
            code: {
              lines: [
                "export HTTPS_PROXY=http://proxy.example.com:8080",
                "export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem",
                "claude",
              ],
            },
          },
          {
            title: "Match the network to where you are",
            body: "A company VPN that exits in another country shows Anthropic that country, not yours. If you are in a supported location and the VPN’s egress is not, disconnect it or split-tunnel Anthropic’s hosts so traffic leaves from where you are. Check the account too: it needs a phone number from a supported location, and `/status` inside Claude Code shows which login is active.",
          },
          {
            title: "Run through a cloud region you are allowed to use",
            body: "Claude Code can send model traffic to Amazon Bedrock, Google Cloud, or Microsoft Foundry instead of to Anthropic directly. Authentication and model requests then go to your provider rather than to `api.anthropic.com` or `claude.ai`, and no browser login is needed. It is billed by the provider, needs Claude models enabled in a region that serves them, and is governed by the provider’s terms and Anthropic’s usage policies. Run `claude` and choose “3rd-party platform” for the Bedrock or Vertex AI wizard, or set the variables yourself: [Bedrock](https://code.claude.com/docs/en/amazon-bedrock), [Vertex AI](https://code.claude.com/docs/en/google-vertex-ai), [Foundry](https://code.claude.com/docs/en/microsoft-foundry).",
            code: {
              lines: [
                "# Amazon Bedrock",
                "export CLAUDE_CODE_USE_BEDROCK=1",
                "export AWS_REGION=us-east-1",
                "",
                "# Google Cloud (Vertex AI)",
                "export CLAUDE_CODE_USE_VERTEX=1",
                "export CLOUD_ML_REGION=global",
                "export ANTHROPIC_VERTEX_PROJECT_ID=your-project",
                "",
                "# Microsoft Foundry",
                "export CLAUDE_CODE_USE_FOUNDRY=1",
                "export ANTHROPIC_FOUNDRY_RESOURCE=your-resource",
              ],
            },
          },
        ],
      },
      {
        kind: "prose",
        heading: "What not to expect.",
        paragraphs: [
          "Reinstalling does not change the answer, and neither does the npm package instead of the native installer: the check is on the network path, not the binary. A consumer VPN pointed at a supported country is not a fix we will describe — the plans are for people physically located in supported places, and appearing elsewhere puts the account at odds with those terms. Support is for people in a supported country who are still blocked, not a route to an exception. And the free plan does not include Claude Code, so a free account gets no further.",
        ],
      },
      {
        kind: "prose",
        heading: "If the host is somewhere supported.",
        paragraphs: [
          "There is one honest arrangement the message does not cover. Claude Code runs on a machine, and the machine can be somewhere else: a build box at the office, a cloud VM in a region you are entitled to use, signed in with the account entitled to it. Reaching that host from wherever you are is a solved problem: spawnd puts one daemon on it, which dials out — no open ports, no VPN needed — and any browser becomes the console, end-to-end encrypted between your browser and the daemon. Claude Code authenticates on the host, as always; spawnd holds no provider credentials. It changes which machine does the work and how you reach it, not who is entitled to the account. The shape of it is at [/claude-code-remote](/claude-code-remote).",
        ],
      },
    ],
    start: "Reach the host that can run it.",
    faq: [
      {
        q: "Is Claude Code available in my country?",
        a: "If your country is on Anthropic’s supported-countries list, yes, with a paid plan or API access. The list covers claude.ai and the API together; Claude Code needs one of those, so it follows the same list.",
      },
      {
        q: "Why do I see this in a supported country?",
        a: "Because the note is appended to any failed connectivity probe. A firewall, a corporate proxy, TLS inspection, or a VPN exiting elsewhere produces the same message. Test api.anthropic.com with curl from the same shell and set HTTPS_PROXY if your network needs it.",
      },
      {
        q: "Does a VPN fix it?",
        a: "A work VPN that exits in your real country can, by making the network match where you are. Using a VPN to appear in a country you are not in is against the plans’ physical-location terms, and we do not recommend it. Bedrock, Vertex AI, and Foundry are the legitimate way to run Claude Code through a cloud region you are allowed to use.",
      },
    ],
    related: [
      {
        title: "Claude Code, remote",
        blurb: "reaching the host that runs it, from anywhere",
        href: "/claude-code-remote",
      },
      {
        title: "Remote access without open ports",
        blurb: "the outbound-only model behind that reach",
        href: "/use/remote-access-without-open-ports",
      },
      {
        title: "How to run Claude Code",
        blurb: "install, sign in, first task — once the connection works",
        href: "/how-to-run-claude-code",
      },
    ],
    cardTitle: "Not available in your country",
    cardBlurb: "What the message means, the fixes in order, and what no fix will do.",
  },
];
