import type { ArticleEntry, HubEntry } from "../types";

/*
 * Claude Code cluster (grimoire play 1): remote, the Max plan, pricing, teams,
 * open source — plus the /claude-code pillar hub. Pure data on the article
 * template; see definitions.ts for the exemplar.
 *
 * Facts checked 2026-09-03 against:
 *   https://code.claude.com/docs/en/remote-control
 *   https://code.claude.com/docs/en/claude-code-on-the-web
 *   https://code.claude.com/docs/en/sessions
 *   https://code.claude.com/docs/en/cli-reference
 *   https://code.claude.com/docs/en/commands
 *   https://code.claude.com/docs/en/costs
 *   https://code.claude.com/docs/en/authentication
 *   https://code.claude.com/docs/en/setup
 *   https://code.claude.com/docs/en/settings
 *   https://code.claude.com/docs/en/memory
 *   https://code.claude.com/docs/en/mcp
 *   https://code.claude.com/docs/en/model-config
 *   https://code.claude.com/docs/en/third-party-integrations
 *   https://code.claude.com/docs/en/legal-and-compliance
 *   https://claude.com/pricing
 *   https://support.claude.com/en/articles/11049741-what-is-the-max-plan
 *   https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
 *   https://support.claude.com/en/articles/9797557-usage-limit-best-practices
 *   https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans
 *   https://support.claude.com/en/articles/9266767-what-is-the-team-plan
 *   https://support.claude.com/en/articles/11845131-use-claude-code-with-your-team-or-enterprise-plan
 *   https://support.claude.com/en/articles/9797531-what-is-the-enterprise-plan
 *   https://github.com/anthropics/claude-code (LICENSE.md) and the npm
 *     `license` field of @anthropic-ai/claude-code ("SEE LICENSE IN README.md")
 *   GitHub API license fields for openai/codex, anomalyco/opencode,
 *     Aider-AI/aider, google-gemini/gemini-cli, block/goose, cline/cline,
 *     tmux/tmux, tailscale/tailscale; READMEs of openai/codex and
 *     google-gemini/gemini-cli; https://opencode.ai/docs/ ;
 *     https://aider.chat/docs/llms.html
 *
 * Not verified, so not stated: which model versions each Max tier includes
 * beyond the documented defaults; whether Remote Control sessions (as opposed
 * to web sessions) can be shared with team visibility. The third-party
 * integrations page quotes Teams premium at "$150/seat"; the pricing page and
 * the Team plan article both say $125 monthly / $100 annual, so those are used.
 */

export const CLAUDE_CODE: ArticleEntry[] = [
  {
    slug: "claude-code-remote",
    kind: "guide",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Claude Code remote: every way to run it from elsewhere",
    description:
      "Anthropic’s Remote Control and Claude Code on the web explained, the SSH + tmux route as numbered steps, and what to do when a session must outlive the laptop.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Claude Code,",
      accent: "remote",
      sub: "Anthropic ships two first-party ways to reach a session from a phone or another computer. Here is how each one works, the SSH route that predates both, and where all three stop.",
    },
    body: [
      {
        kind: "prose",
        heading: "Three things the phrase means.",
        paragraphs: [
          "“Claude Code remote” names three different arrangements, and most people searching for it want the first. Remote Control is Anthropic’s feature for continuing a Claude Code session that is running on your machine from your phone, a tablet, or a browser somewhere else. Claude Code on the web is the opposite shape: the session runs on Anthropic’s cloud machines against a GitHub repository, and your terminal is optional. The third is the arrangement that predates both — SSH into a machine you own, run `claude` there, and keep the session alive with tmux.",
          "They differ on one axis that decides everything else: where the process runs. Remote Control and the SSH route keep it on your hardware, with your files, your toolchain, and your MCP servers. The web runs it on Anthropic’s. Pick by that, then by how long the session has to survive without you.",
        ],
      },
      {
        kind: "steps",
        heading: "Remote Control: your local session, from your phone.",
        lead: "Remote Control is available on Pro, Max, Team, and Enterprise plans; API-key logins are not supported, and on Team and Enterprise an Owner has to switch it on in admin settings first. The steps follow [Anthropic’s Remote Control docs](https://code.claude.com/docs/en/remote-control).",
        steps: [
          {
            title: "Sign in with a subscription",
            body: "Run `claude` in a project directory — not your home directory, since the trust dialog never saves trust there — and use `/login` if you are not already signed in through claude.ai. Remote Control is not available through Amazon Bedrock, Google Cloud’s Agent Platform, or Microsoft Foundry, nor with `ANTHROPIC_BASE_URL` pointed at a gateway or proxy.",
          },
          {
            title: "Start the session",
            body: "Three invocations. `claude --remote-control` (or `--rc`) starts a normal interactive session that is also reachable remotely, so you can keep typing locally. `/remote-control` (or `/rc`) inside a session you already have carries the conversation over. `claude remote-control` is server mode: the process waits for connections and serves up to 32 sessions by default, and `--spawn worktree` gives each new session its own git worktree.",
            code: {
              caption:
                "An interactive session with a name, or server mode with a worktree per session.",
              lines: [
                'claude --remote-control "My Project"',
                "claude remote-control --spawn worktree",
              ],
            },
          },
          {
            title: "Connect from the other device",
            body: "Open the session URL in any browser to land on it at claude.ai/code, or scan the QR code (press the spacebar in server mode) to open it in the Claude app for iOS or Android. In the app, tap Code to see the session list; a Remote Control session shows a computer icon with a green dot while it is online. Messages, permission prompts, and subagent progress stay in sync across every connected device.",
          },
          {
            title: "Turn on push notifications",
            body: "In the terminal, run `/config` and enable Push when actions required, Push when Claude decides, or both. Claude pushes when a long task finishes or when it needs a decision; you can also ask for one in the prompt, for example `notify me when the tests finish`.",
          },
          {
            title: "Know what it does not survive",
            body: "The local `claude` process must keep running. Close the terminal, quit VS Code, or let the SSH connection drop, and the session shows as offline within seconds — Anthropic’s own advice for a remote machine is to start Remote Control inside `tmux` or `screen`. Each interactive process carries one remote session; the transcript is stored on Anthropic’s servers while connected, which is why organizations with Zero Data Retention cannot enable it. The machine itself only makes outbound HTTPS requests and opens no ports.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Claude Code on the web: the session that never touches your machine.",
        paragraphs: [
          '[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) is in research preview for Pro, Max, and Team users, and for Enterprise users on premium seats. You connect a GitHub account, describe a task at claude.ai/code, and it runs in an isolated virtual machine that Anthropic manages: the repository is cloned, the session persists after you close the browser, and the Claude mobile app can watch and answer it. From a terminal, `claude --cloud "fix the flaky auth test"` starts one, `/tasks` lists them, and `claude --teleport` pulls a finished session — branch and conversation — back into your local checkout.',
          "It shares rate limits with everything else on your account, has no separate compute charge, and needs GitHub to clone and open pull requests. What it does not have is your machine: no local toolchain, no GPU, no MCP server that only exists on your workstation, no private network. Anthropic frames the choice plainly — the web for kicking off tasks with no local setup or on a repository you have not cloned, Remote Control for continuing local work from another device.",
        ],
      },
      {
        kind: "steps",
        heading: "The classic route: SSH, tmux, and --resume.",
        lead: "This is what people did before either feature existed, and it still works for any machine you can reach. It needs `sshd` listening on the host, a key on every device you connect from, and a network path — the LAN, a VPN, or a tailnet.",
        steps: [
          {
            title: "Reach the machine",
            body: "From the laptop, `ssh you@workstation`. Away from home, that address has to be reachable: a Tailscale or WireGuard tunnel is the usual answer, a port forward the risky one.",
            code: { lines: ["ssh you@workstation"] },
          },
          {
            title: "Start the session inside tmux",
            body: "Create a named tmux session and run Claude Code inside it. tmux owns the terminal, so the connection can drop without taking the process with it.",
            code: { lines: ["tmux new -s claude", "claude"] },
          },
          {
            title: "Detach, then come back",
            body: "Press `Ctrl-b` then `d` to detach; the agent keeps working. From any machine that can SSH in, reattach and the scrollback is where you left it.",
            code: { lines: ["ssh you@workstation", "tmux attach -t claude"] },
          },
          {
            title: "Resume a conversation without tmux",
            body: "If the process did die, the conversation did not. `claude --continue` reopens the most recent session in the current directory, `claude --resume` opens a picker, and `claude --resume <name>` finds one you named with `claude -n <name>` or `/rename`. What comes back is the transcript and its state, not a running process — whatever was mid-flight when the connection dropped is gone.",
          },
          {
            title: "Combine it with Remote Control",
            body: "The two compose. Start `claude --remote-control` inside the tmux session and you get the phone view of a session that survives the SSH disconnect — which is exactly the arrangement Anthropic’s limitations section recommends.",
            code: { lines: ["tmux new -s claude", "claude --remote-control"] },
          },
        ],
      },
      {
        kind: "prose",
        heading: "Where all three run out.",
        paragraphs: [
          "Each route covers one machine and one agent, and that is where they stop. A second machine — the build box, the Mac mini under the desk, the GPU host — means a second set of keys, a second listener to expose, a second tmux session to remember. Remote Control only knows about Claude Code, so a Codex or OpenCode session on the same machine is invisible to it. A session that must outlive the laptop needs a machine that stays awake and, for Remote Control, a `claude` process that stays alive. And a machine you would rather not expose to the internet at all has no honest place in the SSH route.",
          "That is the substrate spawnd provides. One daemon on each host you own; it dials out, so nothing listens on the host — no open ports, no VPN needed. Every session’s PTY is owned by a worker process on the host, so a session survives the closed tab, the dropped connection, the laptop lid, and a daemon restart, scrollback intact, with no tmux to remember. Any browser is the console; on a phone it installs to the home screen as a web app, with no client app and no keys on the device. A new device is approved once against a short code, and revoking it is one click every host honors. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; the server that introduces them never sees session content.",
          "Claude Code runs in it exactly as it runs in any terminal — signed in on the host with your own plan, no API-key markup, `--remote-control` included if you want the Claude app view as well. Codex, OpenCode, and Aider ship as shortcuts alongside it, and any CLI can be added. Workspaces group sessions by project across hosts, attention cues show which agent is waiting on a yes, and notifications reach the phone. For the phone half, [SSH from an iPhone](/ssh-from-iphone) walks the client route and then the one with no client at all; for the many-machines half, see [agentic orchestration](/agentic-orchestration).",
        ],
      },
    ],
    start: "Every machine you own, one console.",
    faq: [
      {
        q: "Is Remote Control the same as Claude Code on the web?",
        a: "No. Both use the claude.ai/code interface, but Remote Control runs the session on your machine and the web runs it on Anthropic’s. Remote Control keeps your local files, tools, and MCP servers; the web needs none of them and none of your hardware.",
      },
      {
        q: "Can I run Claude Code on an iPhone?",
        a: "Not natively — there is no terminal on iOS — but you can drive it from one three ways: the Claude app over Remote Control or a web session, an SSH client app into a machine running it, or a browser console such as spawnd, where the session lives on your own machine and the phone is an approved window.",
      },
      {
        q: "Does spawnd replace Remote Control?",
        a: "It sits underneath it. A spawnd session is a real shell on your host, so Remote Control starts inside it unchanged. What spawnd adds is the part Remote Control does not cover: sessions that survive the process and the laptop, agents other than Claude Code, and several machines in one console.",
      },
    ],
    related: [
      {
        title: "Agentic orchestration",
        blurb: "The definition worth keeping, the patterns behind it, and where the agents run.",
        href: "/agentic-orchestration",
      },
      {
        title: "tmux cheatsheet",
        blurb: "sessions, windows, panes, and the fixes — searchable, every command verified",
        href: "/tmux-cheatsheet",
      },
      {
        title: "SSH from an iPhone",
        blurb:
          "The client, the key, the reachability, the tmux — and the route with no client at all.",
        href: "/ssh-from-iphone",
      },
    ],
    cardTitle: "Claude Code, remote",
    cardBlurb: "Remote Control, the web, and SSH + tmux — then the machines they leave out.",
  },

  {
    slug: "claude-code-max-plan",
    kind: "explainer",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Claude Code on the Max plan: what you actually get",
    description:
      "The Max plan’s 5x and 20x tiers, the five-hour and weekly limits, how Claude Code draws on them versus API billing, and how to make one plan go further.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Claude Code on the",
      accent: "Max plan",
      sub: "What $100 or $200 a month buys, how the limits are actually measured, and which tier fits the way you run agents.",
    },
    body: [
      {
        kind: "prose",
        heading: "What the Max plan is.",
        paragraphs: [
          "Max is Anthropic’s individual plan above Pro, sold in two tiers. [Max 5x is $100 a month](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) and gives five times the per-session usage of Pro; Max 20x is $200 a month and gives twenty times. Both include Claude Code alongside the Claude apps under one subscription, with usage limits shared across everything — a long Claude Code session and an afternoon of chat draw from the same pool. Max also carries priority access to new models and features.",
          "The model defaults differ by plan, per [Anthropic’s model configuration docs](https://code.claude.com/docs/en/model-config): on Max the `default` model is Opus, while Pro and Team standard seats default to Sonnet. Opus with the 1M-token context window is included on Max and requires usage credits on Pro. Either tier can switch models mid-session with `/model`.",
        ],
      },
      {
        kind: "prose",
        heading: "How the limits are measured.",
        paragraphs: [
          "Two clocks run at once. The session limit resets every five hours; the weekly limit applies across all models and resets on a fixed day assigned to your account, and the usage screen also shows a separate weekly reset for Opus. What counts is the work, not the message count: conversation length, tool use, model choice, and effort level all draw on the allowance, and Claude Code sends the whole conversation with every request, so a one-line question in a session that has been open all day still costs the whole history. Prompt caching softens that on a subscription — the cache lives an hour — which is why the first message after a long break is the expensive one.",
          "When you reach either limit, Claude Code tells you which and when it resets. A model-specific message such as “You’ve hit your Opus limit” means switching to another family with `/model` keeps you working; a session or weekly limit does not. From v2.1.234 Claude Code can wait and continue the interrupted task on its own after the reset. Beyond that, Pro and Max can turn on [usage credits](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans), which bill anything past the included allowance at standard API rates under a monthly spend cap you set.",
        ],
      },
      {
        kind: "table",
        heading: "Subscription against the API, for Claude Code.",
        lead: "Prices from [claude.com/pricing](https://claude.com/pricing) and Anthropic’s support articles on 2026-09-03.",
        columns: ["Plan", "Price", "Allowance", "Default model", "Past the limit"],
        rows: [
          [
            "Pro",
            "$20 a month, or $17 billed annually",
            "Baseline five-hour and weekly limits",
            "Sonnet",
            "Usage credits at API rates",
          ],
          ["Max 5x", "$100 a month", "5x Pro per session", "Opus", "Usage credits at API rates"],
          ["Max 20x", "$200 a month", "20x Pro per session", "Opus", "Usage credits at API rates"],
          [
            "Console (API key)",
            "Per token, no monthly fee",
            "No session window; organization rate limits",
            "Your choice",
            "It keeps metering",
          ],
        ],
        note: "Anthropic’s own figure for API-billed teams is around $13 per developer per active day and $150–250 a month — more than Max 5x for a full month of daily use.",
      },
      {
        kind: "points",
        heading: "Which tier, honestly.",
        lead: "The tiers are multiples of the same allowance, so the question is how often you hit the wall, not what you do.",
        items: [
          {
            title: "Stay on Pro",
            body: "An hour or two of Claude Code a day, one session at a time, Sonnet doing most of the work. If the five-hour limit interrupts you less than a couple of times a week, the upgrade buys nothing.",
          },
          {
            title: "Max 5x",
            body: "The daily driver. Opus by default, long refactors, one or two sessions open, and the limit stops being something you plan around.",
          },
          {
            title: "Max 20x",
            body: "Several sessions in parallel — worktrees, subagents, an agent that runs most of the day. Per session it is the same product as 5x; what you are buying is the room to run several at once. Here the weekly limit is the number to watch, since parallel sessions spend it in parallel.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Seeing what you have used.",
        paragraphs: [
          "Inside Claude Code, `/usage` (its alias is `/cost`) shows the plan usage bars for the session and the week, and a breakdown of what drew on them — skills, subagents, MCP servers, long context, cache misses. The Session block at the top prices your tokens at API list rates; [Anthropic’s cost docs](https://code.claude.com/docs/en/costs) note it is for API users and not relevant to a subscriber’s bill. The figures come from this machine’s history, so other devices and claude.ai are not included; Settings > Usage on claude.ai has the account-wide view and the next reset time.",
          "`/status` answers the other question: what you are paying with. Its Login method row shows the subscription account, and an API key row appears when a key is in use. If `ANTHROPIC_API_KEY` is set in your environment, the key outranks your subscription once approved and every token is metered — `unset ANTHROPIC_API_KEY` puts you back on the plan.",
        ],
      },
      {
        kind: "prose",
        heading: "Making the plan go further.",
        paragraphs: [
          "The levers are all about context. `/clear` between unrelated tasks, because stale history is resent on every turn; `/compact` with instructions when the history matters; Sonnet for routine work and Opus for the hard decisions, switched with `/model`; a lower `/effort` for simple tasks, since thinking tokens are billed as output. Keep `CLAUDE.md` under 200 lines and move workflow detail into skills that load on demand; disable MCP servers you are not using; push verbose operations — test runs, log reads — into subagents so only a summary comes back. On Pro and Max, resuming a large session after an hour offers a summary instead of the full history, and taking it is usually right.",
          "One lever is structural. The plan is per account, not per machine: sign in on the workstation, the build box, and the laptop and all three draw on the same allowance. With spawnd that is the whole billing story — the Claude Code CLI logs in on each host as it always does, so one subscription serves every machine you own from any device, with no API key in the middle and no markup on top. spawnd holds no provider credentials; your plan is used exactly as the vendor’s CLI uses it. If you are choosing between tiers, the [plan calculator](/claude-plan-calculator) does the arithmetic; if you are asking whether you need a plan at all, start with [is Claude Code free](/is-claude-code-free).",
        ],
      },
    ],
    start: "Same plan, every host you own.",
    faq: [
      {
        q: "Does Claude Code charge my Max plan or the API?",
        a: "Your plan, when you signed in through claude.ai. If the ANTHROPIC_API_KEY variable is set and approved it takes precedence and you pay per token; the /status command shows which is active.",
      },
      {
        q: "Can I use one Max plan on several machines?",
        a: "Yes. Limits are per account and shared across every device and the Claude apps, so three signed-in machines draw on one allowance. Anthropic’s advertised limits assume ordinary individual use; sharing an account between people is what Team seats are for.",
      },
      {
        q: "How do Team seats compare to Max?",
        a: "A Team standard seat is 1.25x Pro per session and a premium seat 6.25x, so a premium seat sits just above Max 5x. Team plans need at least two members and add admin controls and spend limits.",
      },
    ],
    related: [
      {
        title: "Claude plan calculator",
        blurb: "Pro, Max 5x, or 20x — worked out from the hours you run",
        href: "/claude-plan-calculator",
      },
      {
        title: "Is Claude Code free?",
        blurb: "free to install, not free to run — every way to pay",
        href: "/is-claude-code-free",
      },
      {
        title: "Agentic orchestration",
        blurb: "The definition worth keeping, the patterns behind it, and where the agents run.",
        href: "/agentic-orchestration",
      },
    ],
    cardTitle: "Claude Code on Max",
    cardBlurb: "The 5x and 20x tiers, the two limit clocks, and how to make one plan stretch.",
  },

  {
    slug: "is-claude-code-free",
    kind: "explainer",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Is Claude Code free? What it costs to actually run it",
    description:
      "Claude Code is free to install and not free to use: it needs a Pro, Max, Team, or Enterprise plan, or API billing. Every way to pay, and what each one gives you.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Is Claude Code",
      accent: "free?",
      sub: "The short answer, the honest long answer, and a table of every way to pay for it.",
    },
    body: [
      {
        kind: "prose",
        heading: "The short answer.",
        paragraphs: [
          "No. The software costs nothing to install — one `curl` line on macOS and Linux, `brew install --cask claude-code`, or `npm install -g @anthropic-ai/claude-code` — and there is no licence fee for the tool itself. But Claude Code is a client for a metered model, and [Anthropic’s setup docs](https://code.claude.com/docs/en/setup) are explicit: it requires a Pro, Max, Team, Enterprise, or Console account, and the free Claude.ai plan does not include Claude Code access.",
          "So the real question is which of the paid routes fits you. There are two shapes: a subscription, where a flat monthly price buys an allowance measured in five-hour sessions and a weekly cap, and metered billing, where an API key or a cloud provider charges per token and never stops. Everything below is one or the other.",
        ],
      },
      {
        kind: "table",
        heading: "Every way to pay for Claude Code.",
        lead: "US list prices on 2026-09-03, from [claude.com/pricing](https://claude.com/pricing) and Anthropic’s support articles.",
        columns: ["Route", "What it costs", "What you get", "Fits"],
        rows: [
          [
            "Pro",
            "$20 a month, or $17 billed annually",
            "Claude Code and the Claude apps; five-hour session and weekly limits; Sonnet by default",
            "An hour or two a day",
          ],
          [
            "Max 5x",
            "$100 a month",
            "5x Pro’s per-session allowance; Opus by default; priority access",
            "A daily driver",
          ],
          [
            "Max 20x",
            "$200 a month",
            "20x Pro’s allowance",
            "Parallel sessions, agents most of the day",
          ],
          [
            "Team",
            "$25 a seat a month ($20 annual) standard; $125 ($100 annual) premium; two seats minimum",
            "Claude Code on every seat; standard 1.25x Pro, premium 6.25x; admin and spend controls",
            "Small teams",
          ],
          [
            "Enterprise",
            "Seat fee plus usage at API rates; 20 seats self-serve, 50 via sales",
            "SSO, SCIM, audit logs, managed settings; no per-seat limits",
            "Organizations with compliance needs",
          ],
          [
            "Console (API key)",
            "Per token, no monthly fee",
            "No session windows; organization rate limits; workspace spend caps",
            "Automation, CI, sporadic use",
          ],
          [
            "Bedrock, Google Cloud, Microsoft Foundry",
            "Per token on your cloud bill",
            "The same CLI; no Claude on the web, no Remote Control, no cloud sessions",
            "Cloud-native organizations",
          ],
        ],
      },
      {
        kind: "prose",
        heading: "Subscription or API: which is cheaper?",
        paragraphs: [
          "Anthropic’s [cost guidance](https://code.claude.com/docs/en/costs) puts API-billed use at around $13 per developer per active day and $150–250 a month, with 90% of users under $30 a day. Twenty working days at the average is roughly $260 — more than Max 5x, about what Max 20x costs — and it comes with no ceiling. A subscription inverts that: the bill is fixed and the usage is capped. Predictable daily use favours the subscription; sporadic or automated use, where some weeks are zero, favours the key.",
          "The two also blend. Pro and Max can enable [usage credits](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans), which bill work past the included allowance at standard API rates under a monthly cap you set, so the plan is the floor and the key is the overflow. The [plan calculator](/claude-plan-calculator) does this arithmetic for your hours; the [Max plan page](/claude-code-max-plan) explains what the tiers actually buy.",
        ],
      },
      {
        kind: "points",
        heading: "Free things nearby.",
        lead: "None of these is Claude Code, but a few of them are what people asking the question actually need.",
        items: [
          {
            title: "Gemini CLI",
            body: "Google’s open-source terminal agent has a genuine free tier: sign in with a personal Google account and get 60 requests a minute and 1,000 a day, per its README. Different model, similar shape.",
          },
          {
            title: "OpenCode and Aider",
            body: "Free, open-source agents that bring nothing of their own: you supply an API key for whichever provider you like, or point them at a local model through Ollama and pay in electricity. Both reach Claude models through a Console key.",
          },
          {
            title: "Free software, not open source",
            body: "Claude Code itself is proprietary — a native binary under Anthropic’s terms — which matters if you wanted to read or fork it. [Claude Code open source](/claude-code-open-source) covers what is and is not.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Wherever you pay, the login lives on the machine.",
        paragraphs: [
          "Whichever route you choose, the credential ends up on the machine where Claude Code runs — a subscription login in the keychain, a key in the environment — and the tool bills through it from there. That is also the property spawnd keeps when it puts those machines behind one console: agents authenticate on the host, as always; spawnd holds no provider credentials and adds no API-key markup, so a Pro or Max plan is used exactly as the vendor’s CLI uses it, on every host you own, from any device. The plan you picked above is the whole bill.",
        ],
      },
    ],
    start: "Your plan, on every host you own.",
    faq: [
      {
        q: "Can I use Claude Code with the free Claude plan?",
        a: "No. Anthropic’s setup docs state the free Claude.ai plan does not include Claude Code; you need Pro, Max, Team, Enterprise, a Console account with API billing, or a cloud provider.",
      },
      {
        q: "Do I need an API key to use Claude Code?",
        a: "Not with a subscription — start Claude Code and sign in with your Claude.ai account when it asks. An API key is the Console route, billed per token, and if the ANTHROPIC_API_KEY variable is set it takes precedence over your plan.",
      },
      {
        q: "Is the Claude Code software itself free?",
        a: "Yes — free to download, install, and update, with no licence fee. It is not open source, and it does nothing without a paid route to the model.",
      },
    ],
    related: [
      {
        title: "Claude plan calculator",
        blurb: "Pro, Max 5x, or 20x — worked out from the hours you run",
        href: "/claude-plan-calculator",
      },
      {
        title: "Claude Code on the Max plan",
        blurb: "the 5x and 20x tiers, and the two limit clocks",
        href: "/claude-code-max-plan",
      },
      {
        title: "Claude Code",
        blurb:
          "Plans, pricing, remote, teams, open source, settings, commands — the honest route first.",
        href: "/claude-code",
      },
    ],
    cardTitle: "Is Claude Code free?",
    cardBlurb: "Free to install, not free to run — every way to pay, side by side.",
  },

  {
    slug: "claude-code-teams",
    kind: "explainer",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Claude Code for teams: the Team plan and how to share it",
    description:
      "Anthropic’s Team and Enterprise plans for Claude Code — seats, prices, admin — then how a team shares the work: CLAUDE.md, settings, hooks, MCP, and machines.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Claude Code",
      accent: "for teams",
      sub: "What the Team plan buys, what Enterprise adds, and the handful of checked-in files that turn ten people’s agents into one practice.",
    },
    body: [
      {
        kind: "prose",
        heading: "The Team plan, first.",
        paragraphs: [
          "Searches for “Claude Code teams” mostly mean [Claude for Teams](https://support.claude.com/en/articles/9266767-what-is-the-team-plan), Anthropic’s self-service plan, so start there. It needs at least two members and supports up to 150 seats. A standard seat is $25 per member per month, or $20 billed annually, with 1.25 times Pro’s per-session usage; a premium seat is $125, or $100 annually, with 6.25 times. Claude Code is included on every seat, and limits are per member — the same five-hour session and weekly windows as Pro and Max, shared with Claude chat.",
          "Members install Claude Code and `/login` with the account the admin invited, choosing the Team plan at the authorization prompt. Admins get billing, seat management, an analytics dashboard with daily active users and sessions, and a spend report once [usage credits](https://code.claude.com/docs/en/costs) are turned on — credits let members keep working past the seat allowance at API rates, capped at the organization, group, or member level. Remote Control is off by default on Team and Enterprise until an Owner enables it, and cloud sessions depend on an organization policy an Owner controls.",
        ],
      },
      {
        kind: "prose",
        heading: "What Enterprise adds.",
        paragraphs: [
          "[Enterprise](https://support.claude.com/en/articles/9797531-what-is-the-enterprise-plan) is Team plus the controls a security team asks for: SSO and domain capture, SCIM, audit logs, role-based permissions, a compliance API, custom data retention, and managed settings that push a Claude Code configuration to every machine and cannot be overridden locally. Billing changes shape — a seat fee for platform access, with all usage billed at standard API rates and no per-seat limits. Self-serve Enterprise starts at 20 seats; sales-assisted at 50.",
          "Two other routes exist for organizations that want metered billing without a claude.ai plan: the Claude Console, where each developer gets a key in a “Claude Code” workspace with spend limits, and Amazon Bedrock, Google Cloud’s Agent Platform, or Microsoft Foundry, where the CLI bills to the cloud account and the web features — Remote Control, cloud sessions, Claude on the web — do not apply.",
        ],
      },
      {
        kind: "points",
        heading: "How a team actually shares Claude Code work.",
        lead: "The plan buys seats. The practice lives in a few files checked into the repository, each read by every teammate’s Claude Code on every machine.",
        items: [
          {
            title: "A committed CLAUDE.md",
            body: "`./CLAUDE.md` or `./.claude/CLAUDE.md` is loaded at the start of every session and shared through source control: build and test commands, conventions, architecture, the rules people keep re-explaining. Keep it under 200 lines; split path-scoped guidance into `.claude/rules/`; personal notes go in a gitignored `CLAUDE.local.md`. Organizations can add a managed CLAUDE.md at `/etc/claude-code/CLAUDE.md`, or its macOS and Windows equivalents, that no one can exclude.",
          },
          {
            title: "Shared settings and hooks",
            body: "`.claude/settings.json` is the team file — commit it and every clone gets the same permissions, hooks, plugins, and environment variables. `.claude/settings.local.json` is personal and stays out of git. Hooks are the enforcement layer: a `PreToolUse` hook runs as a shell command at a fixed point whether or not Claude agrees, which is what separates a rule from a request.",
          },
          {
            title: "Shared MCP servers",
            body: "`claude mcp add --scope project <name> <url>` writes `.mcp.json` at the repository root; check it in and every teammate has the same tools. Claude Code asks each person to approve project-scoped servers before first use, and `claude mcp reset-project-choices` clears those answers.",
          },
          {
            title: "Reviewing what the agents did",
            body: "The unit of review is the pull request, not the transcript. On Team and Enterprise a Claude Code on the web session can be shared with team visibility so a reviewer can see how a change was reached, and `/export` saves a transcript; but the diff is what gets read, and CI plus a human approval is what gates it, exactly as with a human author.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "The machine problem.",
        paragraphs: [
          "What the plan and the files do not cover is where the agents run. A team’s Claude Code sessions are spread across every laptop, a shared build box, the Mac mini someone set up for overnight runs, a GPU host. Each is reached its own way; each person keeps their own tmux discipline; Remote Control shows each member only their own sessions, one per process. The question a lead actually asks at four o’clock — what is running right now, on which machine, and what is it waiting for — has no answer in the plan.",
          "That is where spawnd fits. One daemon on each host you own; it dials out, so nothing listens and there is nothing to expose. Workspaces, one per project, put sessions from every host in one grid, with attention cues when an agent waits on a yes and notifications on the phone. Access is by device: a new device is approved once against a short code, and revoking it is one click every host honors. Agents authenticate on the host, so each person’s seat is used exactly as the CLI uses it, and spawnd holds no provider credentials. Every session’s PTY is owned by a worker process on the host, so an overnight run survives the closed laptop; your browser talks to each daemon peer-to-peer, end-to-end encrypted, and the server that introduces them never sees session content. Workspaces per project and per-device approval give a team one console over its own hosts — the plan supplies the seats, the repository supplies the practice, and this supplies the machines.",
        ],
      },
    ],
    start: "One console over the hosts your team owns.",
    faq: [
      {
        q: "Is “Claude Code Teams” a separate product?",
        a: "No. Claude for Teams is Anthropic’s multi-seat plan, and Claude Code is included on every seat. There is no team edition of the CLI; the team features are the plan’s admin controls and the files you check in.",
      },
      {
        q: "Can a team share one Claude account?",
        a: "Not under Anthropic’s terms — each user authenticates with their own credentials, and limits are per member. Two people need two seats, and the Team plan starts at two.",
      },
      {
        q: "What does spawnd add to a Team plan?",
        a: "The machines. The plan gives each member a seat; spawnd gives the team one console over the hosts it owns — sessions that persist on those hosts, approved devices instead of keys, and one grid across machines. Billing does not change: the CLI logs in on the host with the member’s own seat.",
      },
    ],
    related: [
      {
        title: "Agentic orchestration",
        blurb: "The definition worth keeping, the patterns behind it, and where the agents run.",
        href: "/agentic-orchestration",
      },
      {
        title: "Background agents",
        blurb: "The definition, the products that use the term, and whose machine the agent is on.",
        href: "/background-agents",
      },
      {
        title: "Claude Code settings",
        blurb: "settings.json scope by scope — what belongs in the team file",
        href: "/claude-code-settings",
      },
    ],
    cardTitle: "Claude Code for teams",
    cardBlurb: "The Team and Enterprise plans, then the checked-in files and the machine problem.",
  },

  {
    slug: "claude-code-open-source",
    kind: "explainer",
    hub: { name: "Claude Code", href: "/claude-code" },
    title: "Is Claude Code open source? No — and here is what is",
    description:
      "Claude Code is not open source. The six coding agents that are, with licences and cost models, and the open-source stack around Claude Code itself.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Is Claude Code",
      accent: "open source?",
      sub: "It is not. Here is exactly what it is, which coding agents are, and the open-source stack most people run Claude Code inside.",
    },
    body: [
      {
        kind: "prose",
        heading: "The plain answer.",
        paragraphs: [
          "Claude Code is not open source. It ships as a native binary — through Anthropic’s installer, Homebrew, apt, and the `@anthropic-ai/claude-code` npm package — and the source is not published. The npm package’s licence field reads “SEE LICENSE IN README.md”; the [anthropics/claude-code](https://github.com/anthropics/claude-code) repository on GitHub, which holds the issue tracker, changelog, plugins, and examples rather than the CLI’s code, carries a `LICENSE.md` that says “© Anthropic PBC. All rights reserved. Use is subject to Anthropic’s Commercial Terms of Service.” Anthropic’s [legal page](https://code.claude.com/docs/en/legal-and-compliance) adds that the binary must not be modified and that each user has to authenticate with their own credentials.",
          "That is a licence, not a lock. You can run Claude Code anywhere it installs, inside any tool that gives it a shell, on any plan or key you hold. What you cannot do is read how it works or ship a fork. If either of those matters, the agents below are the ones to look at.",
        ],
      },
      {
        kind: "table",
        heading: "The coding agents that are open source.",
        lead: "Licences read from each project’s repository on 2026-09-03; cost models from their READMEs and docs.",
        columns: ["Agent", "Licence", "Models", "How you pay"],
        rows: [
          [
            "Codex CLI (OpenAI)",
            "Apache-2.0",
            "OpenAI models",
            "Sign in with a ChatGPT Plus, Pro, Business, Edu, or Enterprise plan, or use an API key",
          ],
          [
            "OpenCode",
            "MIT",
            "Any provider you configure; a curated OpenCode Zen list for newcomers",
            "Free software; your own API keys",
          ],
          [
            "Aider",
            "Apache-2.0",
            "OpenAI, Anthropic, Gemini, DeepSeek, Bedrock, Vertex, OpenRouter, and local models via Ollama",
            "Free software; your own keys, or a local model",
          ],
          [
            "Gemini CLI (Google)",
            "Apache-2.0",
            "Gemini",
            "Free tier with a personal Google account — 60 requests a minute, 1,000 a day — or an API key",
          ],
          [
            "Goose (Block)",
            "Apache-2.0",
            "15+ providers, including Anthropic, OpenAI, Google, Ollama, and Bedrock",
            "Free software; your own keys",
          ],
          [
            "Cline",
            "Apache-2.0",
            "Many providers; 200+ models through OpenRouter",
            "Free software; your own keys",
          ],
        ],
      },
      {
        kind: "prose",
        heading: "What open source buys you here.",
        paragraphs: [
          "Less than the question implies, and more than nothing. The agent is the cheap part of the stack: a loop that reads files, calls a model, and runs commands. Open source lets you audit that loop, patch it, and keep it running if the vendor loses interest — which is real value for a tool that executes commands on your machine. It does not make the model free; every agent above still meters through an API key, a plan, or a GPU you own. And it does not, on its own, make the agent better. The honest comparisons are on [OpenCode vs Aider](/opencode-vs-aider) and the [best AI coding agents](/best-ai-coding-agents) roundup.",
          "Note the one asymmetry. Anthropic does not permit third parties to offer Claude.ai login inside their own applications, so an open-source agent reaches Claude models through a Console API key at per-token rates, not through a Pro or Max plan. If your plan is the reason you are on Claude, the closed CLI is the only thing that spends it.",
        ],
      },
      {
        kind: "points",
        heading: "The open-source stack around Claude Code.",
        lead: "Most people who search this phrase are not choosing an agent. They run Claude Code and want everything around it to be open — the part they can inspect, self-host, and keep. That stack exists.",
        items: [
          {
            title: "tmux",
            body: "ISC-licensed and older than the agent era by many years. It is what keeps a Claude Code session alive after the SSH connection drops, and the tool the vendor’s own Remote Control docs tell you to start inside on a remote machine.",
          },
          {
            title: "SSH and Tailscale",
            body: "OpenSSH is the reach; the Tailscale client, BSD-3-Clause, is how most people get that reach across networks without a port forward. Both are open and well audited, and both need a listener on the host and a key on every device.",
          },
          {
            title: "git worktrees",
            body: "The open primitive behind parallel agents: one checkout per session, so three Claude Code runs on one repository do not fight over the working tree. `git worktree add` is all it takes, and Claude Code’s own `--spawn worktree` server mode uses the same thing.",
          },
          {
            title: "spawnd",
            body: "Open source, MIT/Apache-2.0. One daemon per host you own; it dials out, so nothing listens. Sessions live on the host with their PTY owned by a worker process, so they survive the dropped connection and the laptop lid. Any browser is the console, and your browser talks to each daemon peer-to-peer, end-to-end encrypted — the server that introduces them never sees session content. Claude Code, Codex, OpenCode, and Aider ship as built-in shortcuts, and any CLI can be added.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Why the substrate is the part worth opening.",
        paragraphs: [
          "The closed part of this stack is the part that costs money either way and gets replaced every year. The open part is what holds your keys, carries your sessions, and decides what leaves the machine — and that is the part to be able to read. Run Claude Code as published, on your own hardware, inside a stack you can audit, and the licence question mostly answers itself.",
        ],
      },
    ],
    start: "Open source, on every host you own.",
    faq: [
      {
        q: "Is the Claude Code source on GitHub?",
        a: "No. The anthropics/claude-code repository holds the issue tracker, changelog, plugins, and examples; the CLI itself ships as a native binary under Anthropic’s terms, and its source is not published.",
      },
      {
        q: "Which open-source agent is closest to Claude Code?",
        a: "OpenCode is the nearest in shape — a terminal-native agent with a similar interactive loop — and runs any provider through your own keys. Codex CLI is the nearest in arrangement: vendor-built, Apache-2.0, and billed through a ChatGPT plan the way Claude Code bills through a Claude plan.",
      },
      {
        q: "Can I use my Claude subscription with an open-source agent?",
        a: "Not as Anthropic’s terms stand: third parties may not offer Claude.ai login in their own applications, so open agents reach Claude models through a Console API key at per-token rates. Your Pro or Max plan is spent only by Claude Code itself.",
      },
    ],
    related: [
      {
        title: "OpenCode vs Aider",
        blurb: "the two open agents most often shortlisted, compared",
        href: "/opencode-vs-aider",
      },
      {
        title: "Best AI coding agents",
        blurb: "the roundup, open and closed, judged on the same terms",
        href: "/best-ai-coding-agents",
      },
      {
        title: "Security",
        blurb: "what the open substrate can and cannot see",
        href: "/security",
      },
    ],
    cardTitle: "Claude Code open source?",
    cardBlurb: "It isn’t — here are the agents that are, and the open stack around it.",
  },
];

/** The cluster's pillar hub, racked into the flat catalogue by articles/index.ts. */
export const CLAUDE_CODE_HUB: HubEntry[] = [
  {
    slug: "claude-code",
    title: "Claude Code: run it anywhere, on every plan, from any device",
    description:
      "The Claude Code hub: what it is, how it is paid for, how to run it from a phone or another machine, its settings and commands — the honest route before the product.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Claude Code,",
      accent: "anywhere",
      sub: "Everything around the tool that the vendor’s docs do not cover — the plans, the machines, the phone, the team — written to be useful whether or not you install anything of ours.",
    },
    essay: [
      {
        heading: "What Claude Code is.",
        paragraphs: [
          "Claude Code is Anthropic’s coding agent for the terminal. You start it in a project directory and it reads the codebase, edits files, runs commands, and asks before doing anything it has not been told it may do. It installs with one line on macOS, Linux, and WSL, or through Homebrew, WinGet, apt, or npm; it ships as a native binary that updates itself, and runs on macOS 13 or later, Windows 10, and recent Ubuntu, Debian, and Alpine with 4 GB of memory. The same engine sits inside the VS Code and JetBrains extensions, a desktop app, and Anthropic’s hosted Claude Code on the web.",
          "Its behaviour is shaped by a few plain files. A CLAUDE.md at the root of the repository gives it standing instructions and is meant to be committed; a shared settings file holds a team’s permissions and hooks, with a local one for personal overrides; an MCP file adds tools. Sessions are saved per project directory and can be resumed after the terminal closes. What it is not is a chat window — the line between Claude and Claude Code, and the first hour of running it, each have a page in the rack below.",
        ],
      },
      {
        heading: "How it is paid for.",
        paragraphs: [
          "The software is free to install and does nothing without a paid route to the model; the free Claude.ai plan does not include it. Pro at $20 a month does, with an allowance measured in five-hour sessions and a weekly cap; Max at $100 or $200 multiplies that allowance five or twenty times and defaults to Opus; Team seats put the same thing under an admin at $25 or $125 a seat; Enterprise bills usage at API rates behind SSO and managed settings. Or skip the plans and pay per token with a Console API key, or through Amazon Bedrock, Google Cloud, or Microsoft Foundry. A usage command inside the tool shows what you have spent, and a status command shows which route is paying.",
          "The choice is a real one — twenty days of average API-billed use costs more than Max 5x, but a subscription caps the usage as well as the bill — and it is the subject of three pages here: whether Claude Code is free, what the Max plan actually buys, and a plan calculator that does the arithmetic for your hours.",
        ],
      },
      {
        heading: "The running-it-anywhere problem.",
        paragraphs: [
          "A coding agent runs for minutes or hours between the moments it needs you, so the question that follows install is not how to use it but how to reach it — from the couch, from the phone, from another machine, after the laptop closes. Anthropic answers part of that: Remote Control puts a local session in the Claude app, and Claude Code on the web runs sessions on Anthropic’s machines. The older answer, SSH and tmux, still covers any machine you can reach. The remote page below teaches each one, honestly and in order.",
          "Where they run out is the same place every time: several machines, agents that are not Claude Code, sessions that must outlive the process that started them, a host you would rather not expose. That is the job spawnd was built for — one daemon on each host you own, dialing out, and any browser as the console, with sessions that live on the host and a phone that gets the permission prompt. The pages in the rack below teach the searched-for thing first; the product enters only where the honest route stops.",
        ],
      },
    ],
    spokes: [
      {
        title: "Claude Code, remote",
        blurb: "Remote Control, the web, and SSH + tmux — then the machines they leave out.",
        href: "/claude-code-remote",
      },
      {
        title: "Claude Code on Max",
        blurb: "The 5x and 20x tiers, the two limit clocks, and how to make one plan stretch.",
        href: "/claude-code-max-plan",
      },
      {
        title: "Is Claude Code free?",
        blurb: "Free to install, not free to run — every way to pay, side by side.",
        href: "/is-claude-code-free",
      },
      {
        title: "Claude Code for teams",
        blurb: "The Team and Enterprise plans, then the checked-in files and the machine problem.",
        href: "/claude-code-teams",
      },
      {
        title: "Claude Code open source?",
        blurb: "It isn’t — here are the agents that are, and the open stack around it.",
        href: "/claude-code-open-source",
      },
      {
        title: "Claude vs Claude Code",
        blurb: "The assistant, the agent, and the machine that tells them apart.",
        href: "/claude-vs-claude-code",
      },
      {
        title: "How to run Claude Code",
        blurb: "Install, sign in, first task, the loop, and where it stops.",
        href: "/how-to-run-claude-code",
      },
      {
        title: "Claude Code settings",
        blurb: "Every settings.json, which one wins, and the keys worth setting.",
        href: "/claude-code-settings",
      },
      {
        title: "Claude Code commands",
        blurb: "Slash commands, CLI flags, shortcuts, and your own.",
        href: "/claude-code-commands",
      },
      {
        title: "Not available in your country",
        blurb: "What the message means, the fixes in order, and what no fix will do.",
        href: "/claude-code-not-available-in-your-country",
      },
      {
        title: "Claude plan calculator",
        blurb: "Pro vs Max 5x vs Max 20x vs API, by hours of agent use per day",
        href: "/claude-plan-calculator",
      },
    ],
    faq: [
      {
        q: "Is Claude Code free?",
        a: "Free to install, not free to run: it needs Pro, Max, Team, or Enterprise, or API billing through a Console key or a cloud provider. The free Claude.ai plan does not include it.",
      },
      {
        q: "Can I use Claude Code from my phone?",
        a: "Yes — through the Claude app with Remote Control or a web session, through an SSH app into a machine that runs it, or through a browser console like spawnd, where the session stays on your own machine. The remote page compares them.",
      },
      {
        q: "Do these pages require spawnd?",
        a: "No. Each teaches the thing you searched for with the tools you already have and names spawnd only where that route runs out. Stop before the turn and you still have what you came for.",
      },
    ],
    related: [
      {
        title: "Agentic orchestration",
        blurb: "The definition worth keeping, the patterns behind it, and where the agents run.",
        href: "/agentic-orchestration",
      },
      {
        title: "SSH from an iPhone",
        blurb:
          "The client, the key, the reachability, the tmux — and the route with no client at all.",
        href: "/ssh-from-iphone",
      },
      {
        title: "Guides",
        blurb: "agent guides, device guides, definitions, and fixes",
        href: "/guides",
      },
    ],
    cardTitle: "Claude Code",
    cardBlurb:
      "Plans, pricing, remote, teams, open source, settings, commands — the honest route first.",
  },
];
