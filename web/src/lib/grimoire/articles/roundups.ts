import type { ArticleEntry } from "../types";

/*
 * Roundups (grimoire play 5): Termius alternatives, the best AI coding agents.
 * Pure data on the article template; see definitions.ts for the exemplar.
 *
 * Facts checked 2026-09-03 against:
 *
 * Termius alternatives —
 *   https://termius.com/pricing (Starter free: local vault, SSH/SFTP/Telnet/
 *   Mosh/local terminal, port forwarding, AI autocomplete; Pro $10/mo annual:
 *   cloud vault, sync across mobile and desktop, session logs, snippets; Team
 *   $20/seat; Business $30/seat; Enterprise custom) · https://termius.com/
 *   (platforms) · https://blink.sh/ (iOS/iPadOS, 2 weeks free then $19.99/yr,
 *   Mosh, SFTP & Files.app, sync, Blink Code) · https://github.com/blinksh/blink
 *   (GPL-3.0) · https://panic.com/prompt/ (Mac/iPhone/iPad/visionOS, SSH, Mosh,
 *   Eternal Terminal, Panic Sync, jump hosts, YubiKey) ·
 *   https://help.panic.com/prompt/purchase-faq/ ($9.99/yr or $49 once, 7-day
 *   trial) · https://secureshellfish.app/ and
 *   https://apps.apple.com/us/app/ssh-client-secure-shellfish/id1336634154
 *   (iPhone/iPad/Mac, $2.99/mo, $14.99/yr, $29.99 lifetime, Files app, iCloud
 *   Keychain sync) · https://github.com/Eugeny/tabby (MIT; Windows/macOS/Linux;
 *   SSH, SFTP, Telnet, serial; self-hosted web app; sync-config plugin) ·
 *   https://www.warp.dev/pricing (Free tier; macOS/Linux/Windows) ·
 *   https://github.com/warpdotdev/warp (client source AGPL-3.0, UI crates MIT) ·
 *   https://www.chiark.greenend.org.uk/~sgtatham/putty/licence.html (MIT) and
 *   /latest.html (psftp, pscp) · https://github.com/microsoft/terminal (MIT,
 *   Windows 10 2004+) · https://learn.microsoft.com/en-us/windows-server/
 *   administration/openssh/openssh_install_firstuse (OpenSSH Client as a Windows
 *   optional feature) · Google Play listing for JuiceSSH (SSH, Mosh, Telnet,
 *   local shell; Pro unlock: port forwards, widget, encrypted sync) ·
 *   https://f-droid.org/en/packages/com.termux/ (GPL-3.0) · https://mosh.org/
 *   Not verified: the JuiceSSH Pro price (the Play listing would not load;
 *   no number is stated).
 *
 * Best AI coding agents —
 *   https://code.claude.com/docs/en/overview (surfaces, install, subscription
 *   or Console, third-party providers, subagents/hooks/skills/Remote Control) ·
 *   npm @anthropic-ai/claude-code (license "SEE LICENSE IN README.md";
 *   Anthropic Commercial Terms of Service) · https://github.com/openai/codex
 *   (Apache-2.0, install, ChatGPT plans or API key) ·
 *   https://learn.chatgpt.com/docs/codex/cli (/permissions, codex resume,
 *   codex mcp, codex cloud) · https://github.com/google-gemini/gemini-cli
 *   (Apache-2.0, 60 req/min and 1,000 req/day free, 1M context, MCP,
 *   checkpointing, GitHub Action) · https://github.com/sst/opencode and
 *   https://opencode.ai/docs/ and https://opencode.ai/docs/zen/ (Anomaly, MIT,
 *   build/plan agents, desktop app, IDE extension, Zen per-token at cost) ·
 *   https://github.com/Aider-AI/aider (Apache-2.0, any LLM incl. local, git
 *   auto-commits, repo map, voice, watch mode) · https://cursor.com/cli and
 *   https://cursor.com/pricing (install, models, headless/shell mode, GitHub
 *   Actions; Hobby free, Pro $20/mo, on-demand usage) ·
 *   https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli and
 *   https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli
 *   and https://github.com/features/copilot/plans (npm install, Node 22+,
 *   built-in agents, GitHub MCP; Free $0 incl. Copilot CLI, Pro $10, Pro+ $39) ·
 *   https://ampcode.com/pricing and https://ampcode.com/manual and
 *   https://ampcode.com/news/amp-inc (Megawatt $20, Gigawatt $200,
 *   pay-as-you-go, BYOK, linked ChatGPT sub; multi-model; orbs; Mac/iOS apps;
 *   Amp Frontier Corporation, Dec 2025) · https://github.com/aaif-goose/goose
 *   (Apache-2.0, AAIF at the Linux Foundation, 15+ providers, desktop + CLI,
 *   Rust) · Linux Foundation AAIF press release, 2025-12-09 (Block contributed
 *   goose) · https://github.com/cline/cline (Cline Bot Inc., Apache-2.0,
 *   VS Code/JetBrains/CLI/SDK, BYOK, Plan/Act, checkpoints).
 *   "Proprietary" below means the vendor publishes no source licence; Copilot
 *   CLI and Amp npm packages declare "SEE LICENSE IN LICENSE.md".
 */

export const ROUNDUPS: ArticleEntry[] = [
  {
    slug: "termius-alternatives",
    kind: "roundup",
    hub: { name: "Guides", href: "/guides" },
    title: "Termius alternatives, ranked honestly",
    description:
      "Why people leave Termius, eight SSH clients that replace it on every platform, and the route for anyone whose real goal is reaching their own machines from a phone.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Termius alternatives,",
      accent: "ranked honestly",
      sub: "What the free tier still covers, what the subscription actually buys, and which client to pick when you’d rather pay once, pay nothing, or stop needing an SSH app at all.",
    },
    body: [
      {
        kind: "prose",
        heading: "Why people look.",
        paragraphs: [
          "Termius is a good SSH client, and its free Starter tier is more generous than its reputation: SSH, SFTP, Telnet, Mosh and a local terminal, port forwarding, and an AI autocomplete, all free and licensed for commercial use. What the free tier keeps on one device is the vault. Syncing hosts and keys between your phone and your desktop, the cloud vault, snippets automation and session logs are Pro, at $10 a month paid annually; Team ($20 a seat) adds shared vaults, Business ($30) adds access control, and SSO is an Enterprise conversation. All of it is on [Termius’s pricing page](https://termius.com/pricing).",
          "So the search for an alternative is usually one of four searches. The sync paywall: you want your hosts on two devices and don’t want a subscription for it. The vault: you’d rather your private keys never sat in a vendor’s cloud, encrypted or not. The licence: Termius is closed source, and some people won’t put a client they can’t read between themselves and their servers. And the platform: you’re on an iPad with a keyboard, or an Android phone, or a Windows box, and the best client for that screen isn’t the one that runs everywhere.",
        ],
      },
      {
        kind: "points",
        heading: "The shortlist.",
        lead: "Ranked for the person who came here from Termius: the closer a client gets to Termius’s job on its own platform, the higher it sits. Prices are the vendors’ own, checked in September 2026.",
        items: [
          {
            title: "1. Blink Shell — iOS and iPadOS",
            body: "The keyboard-first power tool. Mosh and SSH, SFTP through the Files app, hardware-keyboard bindings, and Blink Code for VS Code for the web and Codespaces. Two weeks free, then $19.99 a year — a subscription, but one that includes device sync. The source is on GitHub under GPL-3.0, which makes it the only client on this list that is both polished and readable. [blink.sh](https://blink.sh/)",
          },
          {
            title: "2. Prompt 3 — Mac, iPhone, iPad, visionOS",
            body: "Panic’s client, the most native-feeling of the group. SSH, Mosh and Eternal Terminal, Panic Sync for servers, keys and passwords across devices, jump hosts, clips, YubiKey. $9.99 a year, or $49 once and it’s yours; one purchase covers all four platforms after a seven-day trial. Closed source. If your complaint with Termius was the subscription rather than the closed code, this is the answer. [panic.com/prompt](https://panic.com/prompt/)",
          },
          {
            title: "3. Secure ShellFish — iPhone, iPad, Mac",
            body: "The one that treats a server as a folder. The terminal is native, but the trick is the Files app: your server’s filesystem appears there, so any iOS app can open, edit and save files over SFTP. Hosts and keys sync through iCloud Keychain. Free to try; Pro is $2.99 a month, $14.99 a year, or $29.99 for life. Mosh isn’t listed. [secureshellfish.app](https://secureshellfish.app/)",
          },
          {
            title: "4. Tabby — Windows, macOS, Linux",
            body: "A free, MIT-licensed terminal emulator with an SSH, SFTP, Telnet and serial client built in: a connection manager, port forwarding, jump hosts, agent forwarding, split panes. It is Electron and not light on memory, which its own README admits. There is a web version you can self-host, and a community plugin that syncs config to a Gist. Desktop only — no phone client. [github.com/Eugeny/tabby](https://github.com/Eugeny/tabby)",
          },
          {
            title: "5. Warp — macOS, Linux, Windows",
            body: "A terminal rather than an SSH client — you run `ssh` inside it — with an agent built in and a free tier. The client is open source under AGPL-3.0 (its UI crates under MIT). Pick it if what you liked about Termius was the modern feel and the AI, not the host vault; it has no vault. The paid tiers are about model usage, not SSH. [warp.dev/pricing](https://www.warp.dev/pricing)",
          },
          {
            title: "6. PuTTY, or OpenSSH in Windows Terminal — Windows",
            body: "The zero-cost, zero-account answer. PuTTY is MIT-licensed, decades old, and ships `psftp` and `pscp` for files; nothing syncs, nothing phones home. Alternatively, Windows 10 and 11 offer an OpenSSH client as an optional feature, and Windows Terminal (also MIT) gives it tabs and profiles — the same `ssh` you’d use on a Mac, with a config file instead of a vault. [PuTTY](https://www.chiark.greenend.org.uk/~sgtatham/putty/) · [Windows Terminal](https://github.com/microsoft/terminal)",
          },
          {
            title: "7. JuiceSSH — Android",
            body: "The long-standing Android client: SSH, Mosh, Telnet and a local shell, free, with a paid Pro unlock for port forwards, a connection widget, and encrypted backup and sync between devices. Closed source. It is the closest Android equivalent to Termius’s phone app. [Google Play](https://play.google.com/store/apps/details?id=com.sonelli.juicessh)",
          },
          {
            title: "8. Termux — Android",
            body: "Not a client but a Linux userland, GPL-3.0, from F-Droid: `pkg install openssh mosh` and you have the real OpenSSH and Mosh binaries, your `~/.ssh/config`, and every other Unix tool. No vault, no sync, no polish — and no ceiling. For anyone who manages servers with a config file rather than a GUI, it is the most honest phone client there is. [f-droid.org](https://f-droid.org/en/packages/com.termux/)",
          },
        ],
      },
      {
        kind: "table",
        heading: "At a glance.",
        columns: ["Client", "Platforms", "Price", "Mosh", "SFTP", "Sync"],
        rows: [
          [
            "Termius",
            "macOS, Windows, Linux, iOS, Android",
            "Free; sync from $10/mo",
            "Yes",
            "Yes",
            "Pro",
          ],
          [
            "Blink Shell",
            "iOS, iPadOS",
            "$19.99/yr after 2 weeks",
            "Yes",
            "Yes (Files app)",
            "Included",
          ],
          [
            "Prompt 3",
            "Mac, iPhone, iPad, visionOS",
            "$9.99/yr or $49 once",
            "Yes",
            "—",
            "Panic Sync",
          ],
          [
            "Secure ShellFish",
            "iPhone, iPad, Mac",
            "Free; Pro $14.99/yr or $29.99 once",
            "—",
            "Yes (Files app)",
            "iCloud Keychain",
          ],
          ["Tabby", "Windows, macOS, Linux", "Free, MIT", "—", "Yes", "Plugin, or self-hosted web"],
          ["Warp", "macOS, Linux, Windows", "Free tier; AGPL-3.0", "—", "—", "—"],
          ["PuTTY / OpenSSH + Windows Terminal", "Windows", "Free, MIT", "—", "psftp / sftp", "—"],
          ["JuiceSSH", "Android", "Free; Pro unlock", "Yes", "—", "Pro"],
          ["Termux", "Android", "Free, GPL-3.0", "Yes (package)", "Yes (package)", "—"],
        ],
        note: "A dash means the vendor doesn’t list it. Prices are US, from each vendor’s site or store listing on 2026-09-03.",
      },
      {
        kind: "prose",
        heading: "How to choose.",
        paragraphs: [
          "Match the screen first. On an iPad with a keyboard, Blink; on an iPhone where files matter, ShellFish; across Apple devices with one purchase, Prompt 3. On Android, JuiceSSH if you want a GUI, Termux if you want Unix. On a desktop, Tabby if you want a Termius-like host manager for free, and the platform’s own OpenSSH if you’d rather have a config file than an app.",
          "Then decide about sync, honestly. Sync is the feature the free tiers withhold because it is the feature that costs the vendor money and earns your loyalty. If you need hosts and keys on more than one device and won’t pay, the answer is not a client: it is an `~/.ssh/config` you keep in a private repo, and a key per device. Every client above reads a config file or imports a key. The vault was always a convenience over that.",
          "And remember what none of them change. An SSH client, however good, needs a server it can reach — a port open, a VPN, a tailnet — a key on each device that must be revoked when the device goes, and tmux at the far end if the session is to outlive the connection. Mosh survives the network changing, not the client disappearing. The app polishes the window; the plumbing behind it is the plumbing.",
        ],
      },
      {
        kind: "prose",
        heading: "If the real goal is your own machines, from your phone.",
        paragraphs: [
          "A lot of people searching for a Termius alternative don’t have forty arbitrary servers. They have a Mac mini, a home server, a workstation at the office — machines they own, that they want to reach from a phone to check on a build or answer a coding agent that’s waiting on a yes. For that job the SSH-client shape is more than you need.",
          "The short version: spawnd puts one daemon on each host you own. It dials out, so nothing listens on the host — no open ports, no VPN. A worker process owns each session’s PTY, so the session survives the closed tab, the dropped connection, the laptop lid and a daemon restart, scrollback intact; there is no tmux to remember. Any browser is the console, and on a phone it installs to the home screen as a web app: no client app, no keys on the device. A new device is approved once against a short code, and revoking it is one click every host honors. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; when a relay is unavoidable it forwards ciphertext it cannot decrypt. It is open source, MIT/Apache-2.0, and the daemon runs on macOS and Linux.",
          "It is not an SSH client and doesn’t pretend to be one: it cannot reach a host that doesn’t run its daemon, it has no port forwarding, and if SFTP into a client’s box is your daily work you’ll keep one of the eight above beside it. But for the machines that are yours, it removes the client rather than replacing it.",
        ],
      },
    ],
    start: "Reach your own machines with nothing to install on the phone.",
    faq: [
      {
        q: "Is the Termius free plan enough?",
        a: "For one device, usually yes: SSH, SFTP, Mosh, Telnet and port forwarding are all in the free Starter tier. The moment you want the same hosts on a phone and a laptop, that’s Pro at $10 a month.",
      },
      {
        q: "Which Termius alternatives are open source?",
        a: "Blink Shell (GPL-3.0), Tabby (MIT), Warp (AGPL-3.0), PuTTY (MIT), Windows Terminal (MIT) and Termux (GPL-3.0). Prompt 3, Secure ShellFish and JuiceSSH are closed source, like Termius.",
      },
      {
        q: "Do I need Mosh?",
        a: "If you work from a phone on cellular, it helps a lot: Mosh survives roaming and sleep where SSH drops. Blink, Prompt 3, Termius, JuiceSSH and Termux all speak it, and the server needs mosh-server installed. It survives the network changing, not the client disappearing — the session is still tmux’s job.",
      },
    ],
    related: [
      {
        title: "SSH from an iPhone",
        blurb:
          "The client, the key, the reachability, the tmux — and the route with no client at all.",
        href: "/ssh-from-iphone",
      },
      {
        title: "mosh vs SSH",
        blurb: "A stream versus a state: the mechanics, the losses, and what came after.",
        href: "/mosh-vs-ssh",
      },
      {
        title: "tmux cheatsheet",
        blurb: "sessions, windows, panes, and the fixes — searchable, every command verified",
        href: "/tmux-cheatsheet",
      },
    ],
    cardTitle: "Termius alternatives",
    cardBlurb: "Eight clients ranked honestly, and the route that needs no client at all.",
  },

  {
    slug: "best-ai-coding-agents",
    kind: "roundup",
    hub: { name: "Guides", href: "/guides" },
    title: "The best AI coding agents of 2026, terminal-first",
    description:
      "Ten terminal coding agents — Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider, Cursor, Copilot, Amp, Goose, Cline — compared on maker, licence, models and price.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "The best AI coding agents",
      accent: "of 2026",
      sub: "The ten worth knowing, scoped to the ones that run in a terminal — what each is, who makes it, what it costs, and who it fits — without a ranking nobody can defend.",
    },
    body: [
      {
        kind: "prose",
        heading: "The scope, and why it’s terminal-first.",
        paragraphs: [
          "A coding agent, as distinct from autocomplete or a chat panel, is a program you hand a task to: it reads your repository, edits files, runs commands and tests, and comes back with a result or a question. In 2026 the category has a clear centre of gravity, and it is the terminal. Every major vendor ships its agent as a CLI first — Anthropic’s Claude Code, OpenAI’s Codex, Google’s Gemini CLI — and the open-source field grew up there. The IDE plug-ins and web versions wrap the same engines.",
          "So this list is terminal-first on purpose. It leaves out editor-only tools and cloud-only ones except where the same product also runs as a CLI. It also refuses to rank them one to ten: the honest ordering depends on which model subscription you already pay for, whether the code must be open, and whether you want a vendor’s polish or a community’s flexibility. Instead the agents are grouped by who they’re for. Every fact below was checked against the vendor’s site or repository on 2026-09-03; the field moves monthly, and this page moves with it.",
        ],
      },
      {
        kind: "table",
        heading: "The ten, side by side.",
        columns: ["Agent", "Maker", "Licence", "Models", "How you pay", "Standout"],
        rows: [
          [
            "Claude Code",
            "Anthropic",
            "Proprietary",
            "Claude; Bedrock and Vertex from the CLI",
            "Claude Pro/Max or Team plan, or the API",
            "Subagents, hooks, skills, Remote Control",
          ],
          [
            "Codex CLI",
            "OpenAI",
            "Apache-2.0",
            "OpenAI models",
            "ChatGPT Plus/Pro/Business/Edu/Enterprise, or an API key",
            "One agent across CLI, IDE, desktop and cloud; `codex cloud` handoff",
          ],
          [
            "Gemini CLI",
            "Google",
            "Apache-2.0",
            "Gemini",
            "Free with a Google account (60/min, 1,000/day); API key; Vertex",
            "1M-token context, checkpointing, GitHub Action",
          ],
          [
            "OpenCode",
            "Anomaly",
            "MIT",
            "Any provider via your keys, or OpenCode Zen",
            "Free; pay your provider, or Zen per token at cost",
            "Build and plan agents, TUI plus desktop app, shareable sessions",
          ],
          [
            "Aider",
            "Aider-AI",
            "Apache-2.0",
            "Almost any LLM, including local",
            "Free; pay your provider",
            "Git auto-commits, repo map, voice-to-code",
          ],
          [
            "Cursor CLI",
            "Cursor",
            "Proprietary",
            "Anthropic, OpenAI, Gemini, Cursor’s own",
            "Cursor plans: Hobby free, Pro $20/mo, on-demand usage after",
            "Headless mode, shell mode, GitHub Actions",
          ],
          [
            "Copilot CLI",
            "GitHub",
            "Proprietary",
            "GitHub’s model roster",
            "Copilot plans: Free $0, Pro $10/mo, Pro+ $39/mo, with AI credits",
            "Built-in agents; GitHub MCP server preconfigured",
          ],
          [
            "Amp",
            "Amp Frontier Corporation (spun out of Sourcegraph)",
            "Proprietary",
            "OpenAI and Anthropic frontier models, plus fast ones",
            "Megawatt $20/mo, Gigawatt $200/mo, or pay-as-you-go; bring your own keys",
            "Orbs (cloud sandboxes), Mac and iOS apps, linked ChatGPT subscription",
          ],
          [
            "Goose",
            "Block; now the Agentic AI Foundation (Linux Foundation)",
            "Apache-2.0",
            "15+ providers, including Ollama",
            "Free; pay your provider",
            "Desktop app and CLI, MCP extensions, recipes",
          ],
          [
            "Cline",
            "Cline Bot Inc.",
            "Apache-2.0",
            "Any provider, including Ollama and LM Studio",
            "Free; bring your own key",
            "Plan/Act modes, checkpoints, VS Code + JetBrains + CLI",
          ],
        ],
        note: "“Proprietary” means the vendor publishes no source licence; Claude Code’s package is under Anthropic’s Commercial Terms of Service. Copilot Free includes the CLI with limited usage. Prices are US, as of 2026-09-03.",
      },
      {
        kind: "points",
        heading: "Who each one is for.",
        lead: "Grouped, not ranked: first the vendor agents that ride a subscription you may already have, then the open ones that take any model.",
        items: [
          {
            title: "Claude Code — the one to beat, if you’re on a Claude plan",
            body: "Anthropic’s agent set the register for the category: a CLI that reads the repo, edits, runs tests and commits, and now spawns subagents, runs hooks around its own actions, packages workflows as skills, and hands a session between terminal, desktop app, web and phone. It is not open source — the package is under Anthropic’s Commercial Terms — and it is Claude-only unless you route through Bedrock or Vertex. If you already pay for Pro or Max it is the obvious first agent; the plan’s usage window is the practical constraint, and the [Claude Code](/claude-code) hub covers what each plan gets you.",
          },
          {
            title: "Codex CLI — the same, for ChatGPT subscribers",
            body: "OpenAI’s terminal agent, Apache-2.0 on GitHub, signs in with a ChatGPT plan or an API key and runs the same agent across the CLI, an IDE extension, a desktop app and the cloud — `codex cloud` hands a task to a hosted environment and brings the result back. `/permissions` sets how much it may do unasked, `codex resume` picks up old threads, and `codex mcp` wires in tools. The trade is the mirror of Claude Code’s: an open client tied to one vendor’s models. The [Codex CLI](/codex) hub goes deeper.",
          },
          {
            title: "Gemini CLI — the free one",
            body: "Google’s, Apache-2.0, and the only vendor agent with a real free tier: sign in with a Google account for 60 requests a minute and 1,000 a day, with a million-token context. Checkpointing, MCP, a GEMINI.md context file and a GitHub Action round it out. For a student, a side project, or a first agent it is the cheapest serious option; for heavy daily use you’ll graduate to an API key or Vertex.",
          },
          {
            title: "Cursor CLI — for Cursor’s subscribers, outside the editor",
            body: "Cursor’s agent without Cursor’s IDE: one install command, then run it interactively, in a shell mode with safety checks, or headless in scripts and GitHub Actions. It picks from Anthropic, OpenAI, Gemini and Cursor’s own models on the same Hobby, Pro ($20 a month) and higher plans the editor uses, with on-demand usage billed after the included amount. Proprietary. It makes most sense if you already live in Cursor and want the same agent in CI.",
          },
          {
            title: "Copilot CLI — the GitHub-native one",
            body: "GitHub’s terminal agent installs with `npm install -g @github/copilot`, comes with built-in agents for exploring, tasks, code review and research, and ships with GitHub’s own MCP server preconfigured, so merging a pull request from the prompt is a sentence. It’s in every Copilot plan, including Free ($0, limited usage); Pro is $10 a month. Proprietary, and its model roster is GitHub’s to choose. The pick for anyone whose workflow is GitHub end to end.",
          },
          {
            title: "Amp — for people who want a lab’s opinion",
            body: "Amp spun out of Sourcegraph in December 2025 as Amp Frontier Corporation. It is multi-model by conviction — OpenAI and Anthropic frontier models plus fast ones, each used where it’s best — and runs on the web, in the CLI, and in Mac and iOS apps, with “orbs” as cloud sandboxes for parallel agents. Subscriptions are $20 (Megawatt) and $200 (Gigawatt) a month with included usage, or pay-as-you-go at API rates; a linked ChatGPT subscription can carry the tokens. Proprietary and opinionated; if you want a vendor that changes its mind fast, this is the one.",
          },
          {
            title: "OpenCode — the open field’s default",
            body: "Anomaly’s MIT-licensed agent is the one most people mean by “open Claude Code”: a fast terminal UI with a build agent and a read-only plan agent a Tab apart, LSP awareness, shareable sessions, and now a desktop app and an IDE extension. It takes any provider through your own keys, or OpenCode Zen, a gateway that sells tested models per token at cost plus card fees. [OpenCode vs Aider](/opencode-vs-aider) compares the two open leaders directly.",
          },
          {
            title: "Aider — the veteran",
            body: "The oldest agent on this list and still one of the most disciplined: Apache-2.0, installed with pip, model-agnostic down to local weights, and known for its repository map and for committing every change to git with a sensible message so you can always step back. Voice-to-code and a watch mode for editor comments are there too. It is less a chat than a pair programmer with a strong opinion about small diffs. Choose it when git hygiene matters more than a pretty TUI.",
          },
          {
            title: "Goose — the foundation’s agent",
            body: "Built by Block and contributed to the new Agentic AI Foundation at the Linux Foundation alongside MCP, announced December 2025. Apache-2.0, written in Rust, with a native desktop app and a CLI, fifteen-plus providers including Ollama for local models, seventy-odd MCP extensions and “recipes” for repeatable workflows. Less code-specialised than the others — it wants to be a general agent — which is a strength if your tasks reach past the repo.",
          },
          {
            title: "Cline — the extension that grew a terminal",
            body: "Cline began as the open-source VS Code agent and kept the name as it added a JetBrains plugin, a CLI with interactive and headless modes, and an SDK. Apache-2.0 and bring-your-own-key across Anthropic, OpenAI, Gemini, OpenRouter, Bedrock, Ollama and any OpenAI-compatible endpoint. Its Plan/Act split, checkpoints and diff review are the safest defaults on the list for someone new to agents. Choose it if you want one agent in the editor and the terminal with the same configuration.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "How to pick.",
        paragraphs: [
          "Start from the subscription you already pay for. A Claude plan makes Claude Code nearly free at the margin; a ChatGPT plan does the same for Codex; a Copilot or Cursor seat does it for their CLIs. Paying twice for models is the most common mistake on this list, and the vendor agents exist precisely so you don’t.",
          "If you don’t want to be tied to one vendor’s models — because you switch as the leaderboard moves, because some work must stay on a local model, or because the code must be auditable — pick from the open four. OpenCode for the best terminal experience, Aider for git discipline, Goose for tasks beyond code, Cline for editor and terminal in one. All four are free; you pay your provider.",
          "Then run two. Nothing stops you, the agents don’t conflict, and the fastest way to learn which one suits a codebase is to give the same task to both in separate worktrees and read the diffs.",
        ],
      },
      {
        kind: "prose",
        heading: "The one thing they share.",
        paragraphs: [
          "Every agent on this list runs in a terminal, on a machine, for a long time. That is the category’s unspoken requirement: a real checkout, a real toolchain, credentials that already live somewhere, and hours of uninterrupted runtime. It is why the phone versions are companions rather than replacements, and why the moment you have two agents on two machines the problem stops being which agent and starts being where you watch them.",
          "That is the problem spawnd solves, and it is agent-agnostic on purpose. One daemon on each host you own dials out — no open ports, no VPN. A worker process on the host owns each session’s PTY, so an agent’s session survives the closed tab, the dropped connection, the laptop lid and a daemon restart, scrollback intact. Any browser is the console; on a phone it installs to the home screen as a web app, with attention cues when an agent waits on a yes and notifications on the phone. Claude Code, Codex, OpenCode and Aider are built-in shortcuts; any of the others is a named command in a real shell. Agents authenticate on the host as they always did — spawnd holds no provider credentials and adds no API-key markup, so a Claude or ChatGPT plan is used exactly as the vendor’s CLI uses it. Your browser talks to each daemon peer-to-peer, end-to-end encrypted, and the server that introduces them never sees session content. Open source, MIT/Apache-2.0.",
        ],
      },
    ],
    start: "Give whichever agent wins a machine, and one console.",
    faq: [
      {
        q: "Which AI coding agent is best?",
        a: "There is no defensible single answer. On a Claude plan, Claude Code; on ChatGPT, Codex CLI; for free, Gemini CLI; for open source and any model, OpenCode or Aider. The best one is the one whose models you already pay for and whose licence you can live with.",
      },
      {
        q: "Which coding agents are open source?",
        a: "Codex CLI, Gemini CLI, OpenCode, Aider, Goose and Cline are, under Apache-2.0 or MIT. Claude Code, Cursor CLI, Copilot CLI and Amp are proprietary.",
      },
      {
        q: "Can I run several agents at once?",
        a: "Yes, and it’s common: separate worktrees or separate machines, one agent each. The overhead is watching them — which is what a persistent terminal console across hosts is for.",
      },
    ],
    related: [
      {
        title: "Background agents",
        blurb: "The definition, the products that use the term, and whose machine the agent is on.",
        href: "/background-agents",
      },
      {
        title: "Agentic orchestration",
        blurb: "the definition, and where the agents actually run",
        href: "/agentic-orchestration",
      },
      {
        title: "SSH from an iPhone",
        blurb:
          "The client, the key, the reachability, the tmux — and the route with no client at all.",
        href: "/ssh-from-iphone",
      },
    ],
    cardTitle: "Best AI coding agents 2026",
    cardBlurb: "Ten terminal agents, grouped by who they’re for, every fact checked.",
  },
];
