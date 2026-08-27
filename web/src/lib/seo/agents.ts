import type { SeoPage } from "./types";

/*
 * Per-agent pages. spawn ships these four as built-in agent definitions
 * (server/spawn_server/agents_builtin.py); an agent here is a visible command
 * shortcut typed into a real shell — never a managed process. Descriptions of
 * the agents themselves stay minimal and uncontentious; the page’s job is the
 * "run it on your machines, from anywhere" story.
 */

export const AGENTS: SeoPage[] = [
  {
    family: "for",
    slug: "claude-code",
    title: "Run Claude Code remotely, from any browser",
    description:
      "Claude Code on your machines, reachable from every device you approve. Sessions persist on the host; your Anthropic login never leaves it.",
    eyebrow: "spawnd for Claude Code",
    h1: { plain: "Claude Code, wherever", accent: "you are." },
    lede: "Claude Code is Anthropic’s CLI coding agent, and it’s best on a machine with your real repos, your real toolchain, and your credentials already in place. spawnd keeps it there — and hands you the terminal from any browser you’ve approved, laptop or phone.",
    sections: [
      {
        kind: "grid",
        eyebrow: "Why through spawnd",
        heading: { plain: "The agent stays home.", accent: "You don’t have to." },
        items: [
          {
            title: "A shortcut, not a wrapper",
            body: "The Claude Code button types the visible claude command into your login shell. Your config, your MCP servers, your permissions setup — everything works because nothing is intercepted.",
          },
          {
            title: "Credentials never travel",
            body: "Claude Code authenticates on the host, with the login already there. spawnd’s server never holds your Anthropic credentials — it carries encrypted traffic it cannot read.",
          },
          {
            title: "Long runs, safely unattended",
            body: "Kick off a task and leave. The session is owned by a worker on the host, so it survives closed tabs, dropped wifi, and even a daemon restart — and reattaches with scrollback intact.",
          },
          {
            title: "Answer the prompt from your phone",
            body: "The moment Claude Code needs a yes is rarely the moment you’re at a desk. spawnd’s terminal is phone-real: approve, read the diff, tell it to continue.",
          },
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "From install to first summon." },
        items: [
          {
            title: "Possess the host",
            body: "One command on the machine where Claude Code lives. Outbound-only; no ports, no VPN.",
          },
          {
            title: "Open a session",
            body: "From any approved browser, start a shell in your repo. It’s your machine’s login shell, environment and all.",
          },
          {
            title: "Summon Claude Code",
            body: "Tap the built-in shortcut. If the CLI isn’t installed yet, spawnd shows you the visible install command first — nothing runs silently.",
          },
        ],
        installCommand: true,
      },
    ],
    faq: [
      {
        q: "Do I need a separate Claude Code license or account for spawnd?",
        a: "No. Claude Code runs on your machine under whatever Anthropic plan you already use. spawnd adds reach, not a middleman account.",
      },
      {
        q: "Can spawnd’s server read my Claude Code sessions?",
        a: "No. Terminal traffic is end-to-end encrypted between your browser and the daemon on your host. The server introduces the two and carries metadata; there is no code path through it for terminal content.",
      },
      {
        q: "Can I run several Claude Code sessions at once?",
        a: "Yes — sessions are just shells. Run one per repo, tile them in a workspace grid, and mix in other agents or plain terminals beside them.",
      },
      {
        q: "What if I use Claude Code on more than one machine?",
        a: "Install the daemon on each. Every approved device reaches all of them, and sessions on different hosts sit side by side in one view.",
      },
    ],
    related: ["use/claude-code-on-your-phone", "use/keep-agents-running", "for/codex"],
    cardTitle: "For Claude Code",
    cardBlurb: "Anthropic’s CLI agent on your machines, reachable from any browser.",
  },

  {
    family: "for",
    slug: "codex",
    title: "Run Codex CLI remotely, from any browser",
    description:
      "OpenAI’s Codex CLI on your own machines, reachable from any device you approve. Real shells, persistent sessions, credentials that never leave the host.",
    eyebrow: "spawnd for Codex",
    h1: { plain: "Codex, on your metal,", accent: "from anywhere." },
    lede: "Codex is OpenAI’s CLI coding agent. Run it where your code actually lives — your dev box, your build server — and let spawnd hand you the session from any browser you’ve approved. Your OpenAI login stays on the host; the reach is what changes.",
    sections: [
      {
        kind: "grid",
        eyebrow: "Why through spawnd",
        heading: { plain: "One grid,", accent: "every agent." },
        items: [
          {
            title: "Codex beside the others",
            body: "spawnd is agent-agnostic on purpose. Run Codex in one tile, Claude Code in the next, a plain shell in the third — same workspace, same host or three different ones.",
          },
          {
            title: "A visible command, always",
            body: "The Codex button types codex into a real shell. Flags, config files, and sandbox settings behave exactly as they do at the keyboard, because it is the same keyboard — remoted.",
          },
          {
            title: "Sessions that finish the job",
            body: "Long generations and test loops keep running after you disconnect. The session belongs to a worker on the host; devices come and go.",
          },
          {
            title: "Nothing to re-trust",
            body: "Codex authenticates locally with the account already on the machine. spawnd never sees the credential and cannot read the session — end-to-end encryption is the architecture, not a setting.",
          },
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "Three steps to a remote Codex." },
        items: [
          {
            title: "Possess the host",
            body: "One command on the machine Codex should run on. No inbound ports, ever.",
          },
          {
            title: "Approve your devices",
            body: "Each browser or phone is admitted once, against a short verifiable code.",
          },
          {
            title: "Summon Codex",
            body: "Open a session in your repo and tap the built-in shortcut — or define your own with the flags you prefer.",
          },
        ],
        installCommand: true,
      },
    ],
    faq: [
      {
        q: "Does spawnd support Codex out of the box?",
        a: "Yes — Codex is one of the built-in agent definitions, alongside Claude Code, OpenCode, and Aider. Any of them can be customised, and new CLIs added, since an agent is just a named command.",
      },
      {
        q: "Can I run Codex and Claude Code side by side?",
        a: "Yes, in the same workspace grid — even on different machines. Many people route different tasks to different agents; spawnd doesn’t make you choose.",
      },
      {
        q: "Where does my OpenAI login live?",
        a: "On the host, where Codex runs. spawnd’s server never holds agent credentials and cannot read terminal traffic.",
      },
    ],
    related: ["for/claude-code", "use/keep-agents-running", "use/ai-agents-on-your-own-gpu"],
    cardTitle: "For Codex",
    cardBlurb: "OpenAI’s CLI agent in your grid, next to everything else you run.",
  },

  {
    family: "for",
    slug: "aider",
    title: "Run Aider remotely, from any browser",
    description:
      "Aider on your own machines with your keys staying home. Persistent sessions for long refactors, reachable from every device you approve.",
    eyebrow: "spawnd for Aider",
    h1: { plain: "Aider, attached to", accent: "your real repos." },
    lede: "Aider is the open-source pair programmer that lives in git — it edits your files and commits as it goes, with whichever model you point it at. That makes it exactly the kind of tool that belongs on the machine where the repos are. spawnd keeps it there and gives you the session anywhere.",
    sections: [
      {
        kind: "grid",
        eyebrow: "Why through spawnd",
        heading: { plain: "Git-native agent,", accent: "host-native keys." },
        items: [
          {
            title: "The repo is the point",
            body: "Aider works the actual working tree: your hooks, your remotes, your git identity. Running it on the host through spawnd means no synced copies and no drift — commits land where they should.",
          },
          {
            title: "Model keys stay on the box",
            body: "Aider reads API keys from the host’s environment, whichever provider you use. spawnd never carries them; it can’t read the session they’re used in.",
          },
          {
            title: "A preset that names its model",
            body: "The built-in shortcut launches Aider with a capable default model, visibly — and it’s one edit away from your own model, flags, or config file.",
          },
          {
            title: "Refactors that outlast the tab",
            body: "A multi-file change with test loops takes as long as it takes. The session persists on the host; check in from your phone and answer Aider’s next question.",
          },
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "From clone to committed diff." },
        items: [
          {
            title: "Possess the machine with the repos",
            body: "One command; the daemon dials out and the host joins your sidebar.",
          },
          {
            title: "Open a session in the working tree",
            body: "Pick the directory when you start the session — Aider wakes up in the right repo.",
          },
          {
            title: "Summon Aider",
            body: "Tap the shortcut, or type the command yourself — it’s a real shell, and the shortcut is only ever a visible convenience.",
          },
        ],
        installCommand: true,
      },
    ],
    faq: [
      {
        q: "Which models can I use with Aider through spawnd?",
        a: "Any model Aider supports — it’s Aider’s own configuration, on your host, with your keys. spawnd neither restricts nor touches the choice.",
      },
      {
        q: "Do my provider API keys pass through spawnd?",
        a: "No. Keys live in the host’s environment where Aider runs. spawnd’s server cannot read the terminal session, let alone the keys inside it.",
      },
      {
        q: "Can I watch Aider’s commits from another device?",
        a: "Yes — reattach to the same session from any approved device, or open a second session in the repo and run git log beside it.",
      },
    ],
    related: ["for/opencode", "use/keep-agents-running", "use/web-terminal-for-your-home-server"],
    cardTitle: "For Aider",
    cardBlurb: "The git-native pair programmer, on the machine where the repos live.",
  },

  {
    family: "for",
    slug: "opencode",
    title: "Run OpenCode remotely, from any browser",
    description:
      "OpenCode on your own machines, end to end open source: an open agent, reached through an open control plane that can’t read your terminal.",
    eyebrow: "spawnd for OpenCode",
    h1: { plain: "OpenCode, on an", accent: "open control plane." },
    lede: "OpenCode is the open-source terminal coding agent; spawnd is the open-source way to reach it. Together the whole path from your thumb to the model call is inspectable: an agent you can read, on a machine you own, over a channel whose introducer provably can’t listen.",
    sections: [
      {
        kind: "grid",
        eyebrow: "Why through spawnd",
        heading: { plain: "Open, end", accent: "to end." },
        items: [
          {
            title: "Auditable at every hop",
            body: "OpenCode’s source is public and so is spawnd’s — daemon, server, and web app, MIT/Apache-2.0. The claim that the server can’t read your terminal is a thing you can go check, not a promise.",
          },
          {
            title: "A TUI that stays a TUI",
            body: "OpenCode’s interface renders in a real PTY on your host, so it looks and behaves the same through spawnd as it does at the desk — keybindings, colours, and all.",
          },
          {
            title: "Self-host the entire path",
            body: "Run the control plane yourself if you want zero third parties: your agent, your hosts, your introducer. spawnd hosted is the convenient default, not a requirement.",
          },
          {
            title: "Provider-agnostic, like you",
            body: "OpenCode speaks to many model providers; the keys and the choice live on your host. spawnd adds reach from any approved device and stores none of it.",
          },
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "Open source, three commands deep." },
        items: [
          {
            title: "Possess the host",
            body: "The installer is a shell script you can read, fetching binaries you can verify.",
          },
          {
            title: "Open a session",
            body: "Your login shell, your dotfiles, your terminal — in the browser.",
          },
          {
            title: "Summon OpenCode",
            body: "The built-in shortcut types the visible command; the TUI takes the session over from there.",
          },
        ],
        installCommand: true,
      },
    ],
    faq: [
      {
        q: "Does OpenCode’s TUI work properly in a browser terminal?",
        a: "Yes. Sessions are real PTYs with a full terminal emulator behind them — TUIs render, resize, and take keyboard input as they would in a local terminal.",
      },
      {
        q: "Is spawnd itself really open source?",
        a: "Yes — the daemon, server, web app, and wire protocol, dual-licensed MIT/Apache-2.0, developed in the open on GitHub.",
      },
      {
        q: "Can I run spawnd’s server myself?",
        a: "Yes. Self-hosting the control plane is supported and documented; the daemons and web app point at whichever server you choose.",
      },
    ],
    related: ["for/aider", "use/remote-access-without-open-ports", "use/ai-agents-on-your-own-gpu"],
    cardTitle: "For OpenCode",
    cardBlurb: "An open agent over an open control plane — inspectable end to end.",
  },
];
