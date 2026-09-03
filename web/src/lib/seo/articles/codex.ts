import type { ArticleEntry, HubEntry } from "../flat-types";

/*
 * Codex CLI cluster (grimoire play 2): the pillar hub, install, sessions.
 * Pure data on the article template; see definitions.ts for the exemplar.
 *
 * Facts checked 2026-09-03 against:
 *   https://github.com/openai/codex — README (install commands incl. Windows
 *     PowerShell, plan list, Apache-2.0) and releases (rust-v0.153.0, 2026-09-03)
 *   https://learn.chatgpt.com/docs/codex/cli — standalone installer, update, surfaces
 *     (developers.openai.com/codex/* now redirects here)
 *   https://learn.chatgpt.com/docs/auth — login flags, auth.json, port 1455, device auth
 *   https://learn.chatgpt.com/docs/pricing — plan table (CLI ticked for Plus, Pro,
 *     Business, Enterprise/Edu, API key; not Free/Go), five-hour window, credits
 *   https://learn.chatgpt.com/docs/developer-commands?surface=cli — subcommands,
 *     flags, resume --last/--all/SESSION_ID, fork, update, --full-auto deprecated
 *   https://learn.chatgpt.com/docs/sandboxing and /docs/agent-approvals-security —
 *     sandbox modes, approval policies, presets, Seatbelt/bubblewrap/Windows
 *   https://learn.chatgpt.com/docs/permissions — :read-only/:workspace/:danger-full-access
 *   https://learn.chatgpt.com/docs/config-file/config-basic and
 *     /docs/config-file/config-reference — paths, precedence, keys, profiles
 *   https://learn.chatgpt.com/docs/extend/mcp?surface=cli — mcp_servers keys, codex mcp
 *   https://learn.chatgpt.com/docs/windows/windows-sandbox and /docs/windows/wsl —
 *     Windows 11/10 1809+, elevated vs unelevated, WSL1 dropped at 0.115, /mnt/c
 *   https://learn.chatgpt.com/docs/non-interactive-mode — codex exec, --ephemeral,
 *     exec resume --last, read-only default
 *   https://learn.chatgpt.com/docs/models, /docs/cloud, /docs/codex/ide, /docs/app
 *   https://releases.openai.com/codex/install.sh and install.ps1 — install dirs,
 *     PATH edits, CODEX_INSTALL_DIR, conflict detection, no uninstaller
 *   https://registry.npmjs.org/@openai/codex — 0.153.0, engines node >=16,
 *     per-platform optionalDependencies incl. win32
 *   https://formulae.brew.sh/api/cask/codex.json — cask "codex", 0.153.0
 *   openai/codex source: codex-rs/rollout/src/{lib,recorder,compression}.rs
 *     (sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl, .jsonl.zst, archived_sessions)
 *     and codex-rs/tui/src/slash_command.rs (/rollout, /export, /archive, /delete)
 * Not verifiable, so not stated: an official uninstall for the standalone
 * installer (the script has none); a Node.js minimum beyond the npm manifest;
 * whether a copied sessions directory resumes cleanly on another machine; the
 * JSONL record schema (only the file layout is documented in source).
 */

export const CODEX: ArticleEntry[] = [
  {
    slug: "install-codex-cli",
    kind: "guide",
    hub: { name: "Codex CLI", href: "/codex" },
    title: "Install Codex CLI on macOS, Linux, and Windows",
    description:
      "Every official route to Codex CLI — standalone installer, npm, Homebrew, Windows native or WSL2 — plus sign-in, updating, and the errors that stop step one.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "How to install",
      accent: "Codex CLI",
      sub: "Four official routes, three operating systems, one binary — with first run, sign-in by plan, verifying the install, updating, uninstalling, and the errors that stop people at step one.",
    },
    body: [
      {
        kind: "prose",
        heading: "Pick the route before you type anything.",
        paragraphs: [
          "Every official route installs the same Rust binary, so the choice is about who updates it and where it lands. The standalone installer is OpenAI’s recommended path on macOS, Linux, and Windows and needs nothing but a shell. `npm` suits machines that already have Node and want one package manager for everything; the package declares Node 16 or newer and carries a prebuilt binary for each platform, so nothing compiles. Homebrew is the tidy option on a Mac. The version this page was checked against is 0.153.0, released 3 September 2026; Codex ships several times a week, so expect a higher number.",
          "Requirements are modest: macOS on Apple Silicon or Intel, Linux on x86_64 or arm64, and on Windows, Windows 11 as the recommended baseline with a recent, fully updated Windows 10 (1809 or newer) as best effort. You also need a ChatGPT plan whose pricing table ticks the CLI — Plus, Pro, Business, Enterprise, or Edu — or an OpenAI API key; the [Codex CLI guide](/codex) covers what each plan gets you.",
        ],
      },
      {
        kind: "steps",
        heading: "macOS and Linux.",
        steps: [
          {
            title: "Run the standalone installer",
            body: "It detects your OS and architecture, downloads the matching release, places `codex` in `~/.local/bin` (override with `CODEX_INSTALL_DIR`), and adds that directory to your shell profile if it is not already on `PATH`. Open a new shell afterwards. If it finds a Homebrew, npm, or bun copy of Codex already installed, it offers to remove it so two versions do not fight over `PATH`.",
            code: {
              caption: "The same line updates an existing install.",
              lines: ["curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
            },
          },
          {
            title: "Or install with npm",
            body: "The global package puts a `codex` launcher in npm’s global bin directory and pulls the binary for your platform as an optional dependency. Do not use `sudo`; if global installs fail with `EACCES`, fix npm’s prefix instead — see the errors below.",
            code: { lines: ["npm install -g @openai/codex"] },
          },
          {
            title: "Or install with Homebrew",
            body: "Codex is a cask, not a formula, so the `--cask` flag is not optional.",
            code: { lines: ["brew install --cask codex"] },
          },
          {
            title: "Verify",
            body: "`codex --version` prints the release. `which -a codex` should show exactly one path; two means two installs, and the first on `PATH` wins.",
            code: { lines: ["codex --version", "which -a codex"] },
          },
        ],
      },
      {
        kind: "steps",
        heading: "Windows.",
        lead: "Codex runs natively on Windows; WSL2 is an option, not a requirement.",
        steps: [
          {
            title: "Run the PowerShell installer",
            body: "OpenAI’s standalone installer for Windows, run from an ordinary PowerShell window: it installs under `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin`, adds that folder to your user `PATH`, and needs no administrator rights.",
            code: {
              lines: [
                'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
              ],
            },
          },
          {
            title: "Or use npm",
            body: "The npm package ships `win32-x64` and `win32-arm64` binaries, so the global install works natively without WSL.",
            code: { lines: ["npm install -g @openai/codex"] },
          },
          {
            title: "Set up the native sandbox on first run",
            body: "Codex on Windows runs commands inside a native sandbox in one of two strengths. Elevated is the recommended one: it creates dedicated low-privilege sandbox users, filesystem boundaries, and firewall rules, and setting it up needs `winget` and an administrator’s approval of a UAC prompt — `/setup-default-sandbox` inside a session starts that. Unelevated is the fallback: commands run under a restricted token derived from your own account, with weaker isolation and no admin needed.",
          },
          {
            title: "Or use WSL2",
            body: "Choose WSL2 when you need Linux-native tooling or your repositories already live there. Inside the distribution, run the macOS/Linux installer exactly as above, and keep repositories under a Linux path such as `~/code` — `/mnt/c/...` paths work but are slow. WSL1 has been unsupported since 0.115, when the Linux sandbox moved to bubblewrap.",
            code: {
              caption: "Inside the WSL2 distribution.",
              lines: ["curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
            },
          },
        ],
      },
      {
        kind: "steps",
        heading: "First run and sign-in.",
        steps: [
          {
            title: "Start it inside a repository",
            body: "`cd` into a git checkout and run `codex`. The default Auto preset — sandboxed writes inside the workspace, approval requested for anything beyond it — applies in version-controlled folders; outside one, expect a prompt about trusting the directory.",
            code: { lines: ["cd ~/code/your-repo", "codex"] },
          },
          {
            title: "Sign in with ChatGPT",
            body: "Choose “Sign in with ChatGPT”. A browser opens, you approve, and the CLI caches tokens in `~/.codex/auth.json` — the [auth docs](https://learn.chatgpt.com/docs/auth) say to treat that file like a password. Plus, Pro, Business, Enterprise, and Edu plans cover the CLI; usage is a five-hour window shared with Codex cloud.",
          },
          {
            title: "Or sign in with an API key",
            body: "`codex login --with-api-key` reads the key from standard input and bills per token at API rates. Features that depend on ChatGPT workspace access or the cloud are unavailable this way.",
            code: { lines: ["printf '%s' \"$OPENAI_API_KEY\" | codex login --with-api-key"] },
          },
          {
            title: "On a server with no browser",
            body: "Two options from the auth docs: `codex login --device-auth` prints a code to enter on another device, or forward the sign-in callback port over SSH and complete the browser step on your laptop.",
            code: { lines: ["ssh -L 1455:localhost:1455 user@host", "codex login"] },
          },
          {
            title: "Check it",
            body: "`codex login status` reports which credentials are active; `/status` inside a session shows the model, the sandbox, the working directories, and token use.",
          },
        ],
      },
      {
        kind: "table",
        heading: "Where each route puts things, and how to update or remove it.",
        columns: ["Route", "Binary lands in", "Update", "Remove"],
        rows: [
          [
            "Standalone, macOS/Linux",
            "`~/.local/bin/codex`, or `CODEX_INSTALL_DIR`",
            "Re-run the installer line, or `codex update`",
            "Delete the binary and the `PATH` line it added; there is no uninstaller",
          ],
          [
            "Standalone, Windows",
            "`%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin`",
            "Re-run the installer, or `codex update`",
            "Delete the folder and its user `PATH` entry",
          ],
          [
            "npm",
            "npm’s global bin (`npm prefix -g`)",
            "`npm install -g @openai/codex@latest`",
            "`npm uninstall -g @openai/codex`",
          ],
          [
            "Homebrew",
            "The `codex` cask",
            "`brew upgrade --cask codex`",
            "`brew uninstall --cask codex`",
          ],
        ],
        note: "None of these touch `~/.codex`, which holds `config.toml`, `auth.json`, and every saved session. Delete it only if you mean to lose your chats, and run `codex logout` first if the machine is leaving your hands.",
      },
      {
        kind: "points",
        heading: "The errors people hit.",
        items: [
          {
            title: "codex: command not found",
            body: "The binary is installed but its directory is not on `PATH`. For the standalone installer, open a new shell — it edited your profile, not your current session. For npm, compare `npm prefix -g` plus `/bin` against `echo $PATH`, and add it.",
          },
          {
            title: "EACCES on npm install -g",
            body: "npm’s global directory is owned by root, usually because `sudo npm` ran once. Do not reach for `sudo` again; point npm at a directory you own with `npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to `PATH`, and reinstall.",
          },
          {
            title: "Two versions of Codex",
            body: "`codex --version` disagrees with what you just installed because an older copy sits earlier on `PATH`. `which -a codex` lists them all; remove the one you did not mean to keep. The standalone installer now detects Homebrew, npm, and bun copies and offers to remove them.",
          },
          {
            title: "The sign-in browser never opens",
            body: "You are on a remote or headless machine. Use `codex login --device-auth`, or forward port 1455 over SSH as above and sign in from your laptop’s browser. Copying a working `~/.codex/auth.json` from another machine is also documented, with the care you would give a password.",
          },
          {
            title: "Sandbox errors on Linux",
            body: "The Linux sandbox uses bubblewrap. Recent releases bundle a fallback helper, but it needs unprivileged user namespaces enabled on the kernel, and hardened distributions and some containers turn them off. `codex --sandbox read-only` still works while you sort that out, and logs land in `~/.codex/log`.",
          },
          {
            title: "Elevated sandbox setup fails on Windows",
            body: "A declined UAC prompt, group policy blocking new local users (error 1385 is the classic), or a firewall rule that cannot be written. On a managed device this needs IT; otherwise fall back to the unelevated sandbox rather than full access.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Install it once on a host, then reach it from everywhere.",
        paragraphs: [
          "Notice where all of this happens: on one machine, in one terminal. The install lands, the sign-in lands, the sessions land — on that disk. The moment you want the same Codex from a laptop on the train, a desktop at the office, or a phone, the classical answer is to install and sign in again on each, or to expose the first machine over SSH and carry keys to every device that might need it.",
          "spawnd takes the other route. Install Codex once on the host where the code lives, install the spawnd daemon beside it, and that host dials out to join your fleet — nothing listens on it, no ports open, no VPN. Any browser you approve is the console, including a phone with the app on its home screen; Codex is a built-in shortcut that types `codex` into a real login shell on the host, so the sign-in and `config.toml` you just set up apply unchanged, and spawnd holds no provider credentials. Each session is owned by a worker process on the host, so a run keeps going when the laptop closes. The [sessions guide](/codex-cli-sessions) covers that half; [Codex on your phone](/codex-on-your-phone) shows it.",
        ],
      },
    ],
    start: "One install on the host, one console everywhere.",
    faq: [
      {
        q: "Do I need Node.js to install Codex CLI?",
        a: "Only for the npm route. The standalone installer and the Homebrew cask download a prebuilt binary and need no Node at all. The npm package declares Node 16 or newer and itself wraps a platform binary.",
      },
      {
        q: "How do I update Codex CLI?",
        a: "`codex update` on any install whose release supports self-update, or the route you installed with: re-run the standalone installer line, `npm install -g @openai/codex@latest`, or `brew upgrade --cask codex`. `codex --version` confirms.",
      },
      {
        q: "Does installing Codex CLI on Windows require WSL?",
        a: "No. The PowerShell installer and the npm package both run natively, with a native Windows sandbox. WSL2 is the route OpenAI recommends only when your tooling and repositories already live in Linux; WSL1 is not supported.",
      },
      {
        q: "How do I uninstall Codex CLI completely?",
        a: "Remove the binary the way you installed it — delete `~/.local/bin/codex`, `npm uninstall -g @openai/codex`, or `brew uninstall --cask codex` — then, for a clean slate, `codex logout` and delete `~/.codex`, knowing that removes config and every saved chat.",
      },
    ],
    related: [
      {
        title: "Codex CLI",
        blurb: "the complete guide: what it is, sandbox, config, sessions, daily loop",
        href: "/codex",
      },
      {
        title: "Codex CLI sessions",
        blurb: "where every chat is saved, and what the files cannot keep alive",
        href: "/codex-cli-sessions",
      },
      {
        title: "spawnd for Codex",
        blurb: "the product page: Codex on your metal, from anywhere",
        href: "/for/codex",
      },
    ],
    cardTitle: "Install Codex CLI",
    cardBlurb: "macOS, Linux, Windows native or WSL2 — sign-in, updating, and the step-one errors.",
  },
  {
    slug: "codex-cli-sessions",
    kind: "guide",
    hub: { name: "Codex CLI", href: "/codex" },
    title: "Codex CLI sessions: save, resume, and export a chat",
    description:
      "Codex saves every chat automatically. Where the files live, how to resume the last or an older session, export a transcript, and what the files can’t keep alive.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Save, resume, and export a",
      accent: "Codex CLI session",
      sub: "Codex already saves every chat — the questions are where, how to get back in, how to get a transcript out, and what a saved file cannot do: keep the run alive after the terminal closes.",
    },
    body: [
      {
        kind: "prose",
        heading: "Codex already saves every chat.",
        paragraphs: [
          "There is no save command because there is nothing to save by hand. From the first prompt, Codex streams the session to a rollout file — a JSONL transcript of every turn, tool call, and result — under `~/.codex/sessions/`, in a `YYYY/MM/DD/` folder for the day the chat started, named `rollout-<timestamp>-<thread-id>.jsonl`. Older files may be compressed to `.jsonl.zst`; the CLI reads both. `~/.codex` is `CODEX_HOME`, so setting that variable moves everything. Archived chats go to `~/.codex/archived_sessions/`.",
          'Two settings change this. `[history] persistence = "none"` in `config.toml` stops transcripts being written at all, and `codex exec --ephemeral` skips the rollout file for a single scripted run. Everything else is saved, including the chats you abandoned after one message — which is why the picker fills up, and why the directory is worth knowing about when disk space goes missing.',
        ],
        code: {
          caption: "Today’s sessions on this machine.",
          lines: ["ls ~/.codex/sessions/$(date +%Y/%m/%d)/"],
        },
      },
      {
        kind: "steps",
        heading: "Get back into a chat.",
        steps: [
          {
            title: "Resume from the same directory",
            body: "`codex resume` opens a picker over the chats started from the current working directory; pick one and the conversation continues with its full context.",
            code: { lines: ["codex resume"] },
          },
          {
            title: "Skip the picker",
            body: "`--last` reopens the most recent chat from this directory. It is the one to bind to a shell alias.",
            code: { lines: ["codex resume --last"] },
          },
          {
            title: "Find one from somewhere else",
            body: "`--all` widens the picker to sessions started in every directory on the machine; a session id — the UUID in the rollout filename, or the name you gave it with `/rename` — resumes that thread exactly.",
            code: { lines: ["codex resume --all", "codex resume <SESSION_ID>"] },
          },
          {
            title: "Branch instead of continue",
            body: "`codex fork` (or `/fork` inside a session) starts a new thread that inherits the transcript and leaves the original untouched — for trying two approaches from the same point.",
            code: { lines: ["codex fork"] },
          },
          {
            title: "Resume a scripted run",
            body: "Non-interactive sessions are saved too. `codex exec resume --last` continues the most recent one with a new prompt, so a pipeline can carry context between steps; see the [non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode).",
            code: { lines: ['codex exec resume --last "now run the tests"'] },
          },
          {
            title: "Inside a session",
            body: "`/resume` switches to a saved chat without leaving the TUI, `/new` starts a fresh one, and `/status` shows the working directory and token use of the one you are in.",
          },
        ],
      },
      {
        kind: "steps",
        heading: "Read or export a transcript.",
        steps: [
          {
            title: "Find the file",
            body: "`/rollout` prints the path of the current session’s rollout file.",
          },
          {
            title: "Export as markdown",
            body: "`/export` writes the conversation as markdown — the form to paste into a pull request or hand to a colleague. `/copy` grabs the last response or code block on its own.",
          },
          {
            title: "Query the JSONL",
            body: "The rollout is one JSON object per line, so ordinary tools work on it; the Codex source suggests `jq` or `fx`.",
            code: {
              caption: "Pretty-print today’s rollouts.",
              lines: ["jq -C . ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-*.jsonl | less -R"],
            },
          },
          {
            title: "Tidy up",
            body: "`/archive` moves the current thread to `archived_sessions` and exits; `/delete` removes it permanently. `/compact` is different: it summarises the conversation so the model stops carrying all of it — a context decision, not a storage one.",
          },
        ],
      },
      {
        kind: "points",
        heading: "What a saved session is, and is not.",
        lead: "The file is faithful about the conversation and silent about everything around it.",
        items: [
          {
            title: "The conversation — kept",
            body: "Every turn, every tool call and its output, in order. Resume reads it back into a fresh `codex` and the model picks up with full context.",
          },
          {
            title: "Your edits — already on disk",
            body: "Codex changed real files in a real working tree. Nothing in the rollout needs replaying; `git diff` is the record of what it did to your code.",
          },
          {
            title: "The running command — gone",
            body: "A resumed session is a new process reading an old transcript. A test suite or build that was mid-flight when the terminal closed did not finish and will not be resumed; you ask again.",
          },
          {
            title: "The machine — fixed",
            body: "Sessions are files on the disk of the machine that ran them. Nothing syncs `~/.codex/sessions` between your laptop and your desktop; the picker on one knows nothing about the other.",
          },
          {
            title: "Your usage window — account-wide",
            body: "Limits on a ChatGPT plan are a five-hour window shared across local messages and cloud chats. Resuming an old session spends from the same allowance as starting a new one.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "The honest limit: files survive, processes do not.",
        paragraphs: [
          "This is where “save chat” stops meaning what people hope. Codex keeps the transcript; it does not keep the session alive. Close the laptop lid during a long refactor and the process is suspended or killed with the terminal; drop an SSH connection and the remote `codex` dies with the shell unless you remembered to start it inside tmux; reboot and it is a picker entry. `codex resume --last` gets you the context back — not the run. From a phone, OpenAI’s route is the cloud, where the run lives in their container against a GitHub repo, not on the box with your checkouts and your services.",
          "spawnd is the version where the session itself lives on the host. Each session’s PTY is owned by a worker process on the machine, so the Codex run — not just its transcript — survives the closed tab, the dropped connection, the laptop lid, and a restart of the daemon itself, scrollback intact. The daemon dials out, so nothing on the host listens and no port opens. Any browser you approve is the console; on a phone it installs to the home screen as a web app, and the session you started at the desk is the same session there, with an attention cue when Codex stops to ask for a yes and a notification to say so. Codex is a built-in shortcut typing `codex` into a real login shell, so `~/.codex` — your sign-in, your config, your rollouts — is exactly where it always was; spawnd holds no provider credentials. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; the server that introduces them never sees session content. [Codex on your phone](/codex-on-your-phone) shows the loop in real captures; [keep agents running](/use/keep-agents-running) is the general case.",
        ],
      },
      {
        kind: "capture",
        caption:
          "The other kind of persistence: one workspace, sessions from several hosts in one grid, each a live PTY owned by a worker on its own machine — still running, not just still saved.",
      },
    ],
    start: "Sessions that outlive the terminal.",
    faq: [
      {
        q: "Does Codex CLI save chat history automatically?",
        a: 'Yes. Every interactive and `codex exec` session is written as a JSONL rollout under `~/.codex/sessions/` from the first turn, unless you set `[history] persistence = "none"` or run `codex exec --ephemeral`.',
      },
      {
        q: "How do I resume the last Codex session?",
        a: "`codex resume --last` from the same directory. `codex resume` alone opens a picker; add `--all` to see sessions started elsewhere, or pass a session id to reopen one exactly.",
      },
      {
        q: "Can I resume a Codex CLI session on another computer?",
        a: "Not by design — sessions are files on the machine that ran them and nothing syncs them. Resuming gets you the transcript, never the running process. If the goal is one session you can reach from any device while it keeps running, that is what spawnd’s host-owned sessions are for.",
      },
      {
        q: "How do I delete Codex chat history?",
        a: "`/delete` inside a session removes that thread; `/archive` moves it to `~/.codex/archived_sessions/` instead. To wipe everything, delete `~/.codex/sessions/` — config and sign-in live beside it in `~/.codex`, so do not remove the whole directory unless you mean to.",
      },
    ],
    related: [
      {
        title: "Codex CLI",
        blurb: "the complete guide: what it is, sandbox, config, sessions, daily loop",
        href: "/codex",
      },
      {
        title: "Codex on your phone",
        blurb: "dispatch the suite from the couch, read the verdict there too",
        href: "/codex-on-your-phone",
      },
      {
        title: "Keep agents running",
        blurb: "sessions that survive the laptop, the tab, and the daemon",
        href: "/use/keep-agents-running",
      },
    ],
    cardTitle: "Codex CLI sessions",
    cardBlurb:
      "Where every chat is saved, how to resume and export it, and what the files cannot keep alive.",
  },
];

/** The cluster's pillar hub, racked into the flat catalogue by articles/index.ts. */
export const CODEX_HUB: HubEntry[] = [
  {
    slug: "codex",
    title: "Codex CLI: the complete guide to OpenAI’s coding agent",
    description:
      "What Codex CLI is versus Codex cloud and the IDE extension, install and sign-in by plan, sandbox and approval modes, config.toml, sessions, and the daily loop.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "The complete guide to",
      accent: "Codex CLI",
      sub: "OpenAI’s terminal coding agent, end to end: what it is, how to install and sign in, what the sandbox actually permits, how to configure and resume it, and where a CLI that lives on one machine runs out.",
    },
    essay: [
      {
        heading: "What Codex CLI is, and what it is not.",
        paragraphs: [
          "Codex CLI is OpenAI’s coding agent for the terminal. You run `codex` inside a repository, describe what you want, and it reads the tree, edits files, and runs commands — tests, builds, git — inside an operating-system sandbox on the machine it is installed on, stopping to ask before it steps outside the boundaries you set. It is a Rust binary, [open source under Apache-2.0](https://github.com/openai/codex), and it signs in with the ChatGPT account you already pay for. On 3 September 2026 the current release is 0.153.0; it ships several times a week, so everything here is checked against that version and the vendor’s docs on that date.",
          "The name covers four surfaces, and a search for “codex cli” often means one of the other three. [Codex cloud](https://learn.chatgpt.com/docs/cloud) runs tasks in OpenAI-hosted, isolated environments against a GitHub or GitLab repository you connect; you dispatch from chatgpt.com/codex or from the CLI with `codex cloud`, and results come back as pull requests or diffs you can pull down with `codex apply`. The [IDE extension](https://learn.chatgpt.com/docs/codex/ide) works beside the code in VS Code, Cursor, and Windsurf, with native integrations for Xcode and JetBrains, and can hand longer work off to the cloud. The [desktop app](https://learn.chatgpt.com/docs/app) on macOS, Windows, and Linux is the visual, project-based face of the same agent. The CLI is the one that runs where your checkout, your toolchain, and your credentials already live — and it is the one this guide is about.",
        ],
      },
      {
        heading: "Install and sign in.",
        paragraphs: [
          "There are four official routes, and they all install the same binary. On macOS and Linux the standalone installer — `curl -fsSL https://chatgpt.com/codex/install.sh | sh` — puts `codex` in `~/.local/bin` and adds it to your shell profile; running the same line again updates it. Windows has an equivalent PowerShell installer and a native sandbox, so WSL2 is a choice rather than a requirement. `npm install -g @openai/codex` works on all three platforms because the package carries a prebuilt binary for each, and `brew install --cask codex` is the Homebrew route. Whichever you pick, `codex --version` confirms it and `codex update` moves it forward when the installed release supports self-update. The [install guide](/install-codex-cli) walks each platform step by step, including native Windows versus WSL2.",
          "The first `codex` run asks how to sign in. “Sign in with ChatGPT” opens a browser and ties the CLI to your plan: the [pricing page](https://learn.chatgpt.com/docs/pricing) ticks the CLI for Plus, Pro, Business, and Enterprise or Edu — Free and Go include Codex in ChatGPT but not in the CLI row of that table. Usage on a ChatGPT plan is a rolling five-hour window shared between local messages and cloud chats, with weekly limits on top, and Plus and Pro can buy credits when the window runs dry. The alternative is an API key: `codex login --with-api-key` reads the key from stdin, bills per token at API rates, and loses the features that depend on ChatGPT workspace access or the cloud. On a headless box, `codex login --device-auth` gives you a code to enter elsewhere, or forward the callback port with `ssh -L 1455:localhost:1455 user@host` and sign in through your laptop’s browser. Whatever you choose, the result is `~/.codex/auth.json`, which the [auth docs](https://learn.chatgpt.com/docs/auth) say to treat like a password.",
        ],
      },
      {
        heading: "Approvals and the sandbox: what each mode permits.",
        paragraphs: [
          "Codex has two independent dials, and knowing they are independent is most of understanding its safety model. The sandbox is what the operating system lets a command do; the approval policy is when Codex stops to ask you. Both live in `config.toml` and both can be set per run.",
          "[Sandbox modes](https://learn.chatgpt.com/docs/sandboxing) are three. `read-only` lets the agent inspect files but not edit them or run commands without approval. `workspace-write`, the default, lets it read anywhere, edit inside the working directory plus any `writable_roots` you add and the system temp directories, and run ordinary local commands within that boundary — with no outbound network unless you set `network_access = true` under `[sandbox_workspace_write]`, and with `.git` and `.codex` protected from writes. `danger-full-access` removes the boundary entirely. Underneath, macOS uses Seatbelt; Linux and WSL2 use bubblewrap (since 0.115, which is also when WSL1 support ended); Windows has a native sandbox in two strengths — elevated, which sets up dedicated low-privilege sandbox users and firewall rules, and unelevated, which runs commands under a restricted token derived from your own user.",
          "[Approval policies](https://learn.chatgpt.com/docs/agent-approvals-security) are `untrusted` (only known-safe read operations run without asking), `on-request` (the model asks when it wants to step outside the sandbox — edit elsewhere, reach the network), and `never`. The presets in `/permissions` are combinations: Auto is `workspace-write` plus `on-request` and is the default in a version-controlled folder; Read-only pairs `read-only` with `on-request`; Dangerous full access is `danger-full-access` with no approvals, also reachable as `--dangerously-bypass-approvals-and-sandbox` or its alias `--yolo`. The older `--full-auto` flag is deprecated but still accepted. Per run, `--sandbox` (`-s`) and `--ask-for-approval` (`-a`) set the two dials directly, and `codex exec`, the non-interactive mode, defaults to read-only. Newer builds also expose [permission profiles](https://learn.chatgpt.com/docs/permissions) — `:read-only`, `:workspace`, `:danger-full-access`, selected with `default_permissions` — which replace `sandbox_mode` when used; the docs say to configure one system or the other, not both.",
        ],
      },
      {
        heading: "Configuration: config.toml, profiles, models, MCP.",
        paragraphs: [
          'Personal defaults live in `~/.codex/config.toml`; a trusted project can add `.codex/config.toml` at its root; Unix systems can carry `/etc/codex/config.toml`. Precedence runs from command-line flags and `-c key=value` overrides, through project files, then a profile, then the user file, then the system file, down to built-in defaults. A profile is a file named `~/.codex/<name>.config.toml`, selected with `--profile <name>` (`-p`), and it is how one machine keeps a locked-down profile for unfamiliar repos beside a permissive one for your own. The [reference](https://learn.chatgpt.com/docs/config-file/config-reference) lists every key; the ones that matter daily are `model`, `model_reasoning_effort` (`minimal` through `xhigh`), `approval_policy`, `sandbox_mode`, the `[sandbox_workspace_write]` table, `web_search` (`disabled`, `cached`, `indexed`, or `live`), `notify` for a command to run when Codex wants you, `[history] persistence` (`save-all` or `none`), and `[projects."/path"] trust_level`.',
          'Models are chosen with `/model` inside a session, `-m` on the command line, or `model = "gpt-5.6"` in the file; the same command sets reasoning effort. [MCP servers](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) are `[mcp_servers.<name>]` tables — `command`, `args`, and `env` for a stdio server, `url` and `bearer_token_env_var` for an HTTP one — with `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60), and `enabled = false` to park one without deleting it. `codex mcp add <name> -- <command>` writes the table for you, `codex mcp list` shows what is configured, `codex mcp login <name>` handles servers that need OAuth, and `/mcp` inside a session lists what is live. Project instructions go in `AGENTS.md`, which `/init` will draft.',
        ],
      },
      {
        heading: "Sessions, resume, and transcripts.",
        paragraphs: [
          "Every chat is saved without being asked. Codex writes a rollout — a JSONL transcript of the conversation, tool calls, and results — under `~/.codex/sessions/YYYY/MM/DD/`, one file per thread named `rollout-<timestamp>-<thread-id>.jsonl`, sometimes compressed to `.jsonl.zst`. `codex resume` opens a picker over the chats started from the current directory; `codex resume --last` skips the picker; `--all` widens it to every directory; a session id resumes one exactly. `codex fork` (or `/fork` inside a session) starts a new thread that inherits the transcript, and `codex exec resume --last` continues a scripted run. Inside the TUI, `/rollout` prints the file’s path, `/export` writes the conversation as markdown, `/archive` moves the thread to `~/.codex/archived_sessions`, and `/delete` removes it for good.",
          "What the file holds is the conversation, not the process. Resuming reads the transcript into a fresh `codex`; a command that was half-run when the terminal closed is not picked back up, and a session on one machine is a file on that machine’s disk. The [sessions guide](/codex-cli-sessions) goes through the storage, the commands, and where this stops being enough.",
        ],
      },
      {
        heading: "The daily workflow, and one honest paragraph on Claude Code.",
        paragraphs: [
          'The loop most people settle into: `cd` into the repository, run `codex`, accept the Auto preset, and describe the task with the acceptance test in the sentence — “make the failing spec in `auth_test.go` pass without changing the handler’s signature.” Let it run; answer the approval prompts it raises when it wants the network or a path outside the tree. `/diff` shows what changed, `/review` has it critique its own work, `/status` shows the directories in play and token use, `/compact` summarises a long thread before it hits the context limit, `/new` starts clean. `-i` attaches a screenshot to a prompt, `--search` turns on live web search for the run, and `codex exec "…"` puts the same agent in a script or a CI job, read-only by default and streaming events with `--json`.',
          "Against Claude Code the shape is the same — a terminal agent that edits your tree, runs your commands, asks at boundaries, reads a project file (`AGENTS.md` here, `CLAUDE.md` there), speaks MCP, and resumes past sessions — so the choice rarely turns on features. It turns on which subscription you already hold, since each CLI draws on its own vendor’s plan; on which model you trust with your codebase; and on two real differences: Codex CLI is open source and Claude Code is not, and Codex’s default is an OS-level sandbox with approvals at its edge, where Claude Code’s default is per-action permission prompts. Plenty of people run both on the same repository and let the results argue. The [Claude Code guide](/claude-code) covers the other side, and the [agents roundup](/best-ai-coding-agents) puts them beside OpenCode, Aider, and the rest.",
        ],
      },
      {
        heading: "Where a CLI on one machine runs out.",
        paragraphs: [
          "Everything above happens on the machine you typed `codex` into, which is the whole point and the whole limit. The session is a process in a terminal: close the laptop, lose the SSH connection, or reboot, and the transcript survives but the run does not. Reaching that machine from anywhere else means exposing it — a port, a VPN, a bastion — and keeping SSH keys on every device you might be holding. From a phone, OpenAI’s own answer is the cloud: real and useful, and their container rather than your dev box with your checkouts, your services, and your local state.",
          "spawnd is built for the other half. One daemon on each host you own dials out, so nothing listens on the host — no open ports, no VPN. Each session’s PTY is owned by a worker process on the host, so a Codex run survives the closed tab, the dropped connection, the laptop lid, and a restart of the daemon itself, scrollback intact. Any browser is the console, and on a phone it installs to the home screen as a web app; a new device is approved once against a short code, and revoking it is one click every host honors. Codex is a built-in shortcut — the button types `codex` into a real login shell on the host, so your sign-in, your `config.toml`, and your sandbox settings apply exactly as at the keyboard; spawnd holds no provider credentials and adds no API-key markup. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; the server that introduces them never sees session content. Workspaces put one project’s sessions across hosts in one grid, an attention cue marks the session waiting on a yes, and the yes arrives from wherever you are. [Codex on your phone](/codex-on-your-phone) shows the loop with real captures; [spawnd for Codex](/for/codex) is the product page.",
        ],
      },
    ],
    spokes: [
      {
        title: "Install Codex CLI",
        blurb: "macOS, Linux, Windows native or WSL2 — sign-in, updating, and the step-one errors",
        href: "/install-codex-cli",
      },
      {
        title: "Codex CLI sessions",
        blurb:
          "where every chat is saved, how to resume and export, and what the files cannot keep alive",
        href: "/codex-cli-sessions",
      },
      {
        title: "Codex on your phone",
        blurb: "dispatch the suite from the couch, read the verdict there too",
        href: "/codex-on-your-phone",
      },
      {
        title: "spawnd for Codex",
        blurb: "the product page: Codex on your metal, from anywhere",
        href: "/for/codex",
      },
      {
        title: "OpenCode vs Aider",
        blurb: "the open alternatives, compared without a horse in the race",
        href: "/opencode-vs-aider",
      },
      {
        title: "Best AI coding agents",
        blurb: "Codex beside Claude Code, OpenCode, Aider, and the rest",
        href: "/best-ai-coding-agents",
      },
      {
        title: "Claude Code",
        blurb: "the other terminal agent, in the same depth",
        href: "/claude-code",
      },
    ],
    faq: [
      {
        q: "Is Codex CLI free?",
        a: "The CLI itself is open source and free to install. Using it needs either a ChatGPT plan whose pricing table ticks the CLI — Plus, Pro, Business, Enterprise, or Edu — or an OpenAI API key billed per token. Free and Go include Codex in ChatGPT but not the CLI, per OpenAI’s pricing page at the time of writing.",
      },
      {
        q: "Is Codex CLI open source?",
        a: "Yes. The source is at github.com/openai/codex under the Apache-2.0 license, written in Rust; the npm package wraps prebuilt binaries for macOS, Linux, and Windows. Claude Code, by contrast, is not open source.",
      },
      {
        q: "Codex CLI or Codex cloud — which should I use?",
        a: "The CLI when the work needs your machine: local services, uncommitted state, a toolchain that took a day to set up, or a sandbox you control. Cloud when a clean container against a GitHub repo is enough and you want to dispatch from a browser and get a pull request back. They share an account and a usage window, so many people use both.",
      },
      {
        q: "Does Codex CLI run on Windows?",
        a: "Yes, natively — Windows 11 recommended, Windows 10 1809 or newer best-effort — with a native sandbox in elevated and unelevated forms. WSL2 remains the route when your tooling and repositories already live in Linux; WSL1 has been unsupported since 0.115.",
      },
    ],
    related: [
      {
        title: "Guides",
        blurb: "agent guides, device guides, definitions, and fixes — the DIY route first",
        href: "/guides",
      },
      {
        title: "Coding agents on your phone",
        blurb: "every agent from a phone, with real captures",
        href: "/coding-agents-on-your-phone",
      },
      {
        title: "Run agents in parallel",
        blurb: "the flagship: a fleet of sessions, one console",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "Codex CLI",
    cardBlurb:
      "OpenAI’s terminal agent, end to end: install, sandbox, config, sessions, and where one machine runs out.",
  },
];
