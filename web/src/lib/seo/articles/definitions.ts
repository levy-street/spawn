import type { ArticleEntry } from "../flat-types";

/*
 * Definition pages: the vocabulary of the agent era, defined while the
 * terms are still unowned. Each page is a real definition first — quotable,
 * citable, product-free through its first half — and names spawnd only
 * where the defined thing meets a machine you own.
 *
 * Facts checked 2026-09-03 (cloud-development-environment, background-agents) against:
 *   https://aws.amazon.com/blogs/devops/how-to-migrate-from-aws-cloud9-to-aws-ide-toolkits-or-aws-cloudshell/
 *   https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces
 *   https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces
 *   https://docs.github.com/en/codespaces/setting-your-user-preferences/configuring-automatic-deletion-of-your-codespaces
 *   https://ona.com/  https://ona.com/stories/gitpod-is-now-ona (2025-09-02)
 *   https://www.infoworld.com/article/4184648/openai-buys-ona-to-help-rein-in-ai-agents.html (2026-06-12; pending)
 *   https://github.com/coder/coder (AGPL-3.0)  https://github.com/loft-sh/devpod (MPL-2.0)
 *   https://firebase.google.com/docs/studio  https://firebase.google.com/docs/studio/migrating-project
 *   https://cursor.com/docs/background-agent (now "Cloud agents")
 *   https://learn.chatgpt.com/docs/cloud (developers.openai.com/codex/cloud redirects here)
 *   https://code.claude.com/docs/en/claude-code-on-the-web  https://code.claude.com/docs/en/remote-control
 *   https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent (now "Copilot cloud agent")
 *   https://jules.google/docs  https://jules.google/docs/usage-limits/
 *   https://docs.devin.ai/get-started/devin-intro
 * Left out as unverifiable from primary sources today: Cloud9's founding and acquisition dates,
 * Codespaces' launch year, Gartner's CDE definition (paywalled), the company behind Devin
 * (devin.ai rate-limited the check), and Jules and Devin pricing beyond Jules' task limits.
 */

export const DEFINITIONS: ArticleEntry[] = [
  {
    slug: "agentic-orchestration",
    kind: "definition",
    hub: { name: "Guides", href: "/guides" },
    title: "Agentic orchestration, defined",
    description:
      "What agentic orchestration means, how it differs from workflow automation and multi-agent systems, the patterns that work today, and where the machines come in.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Agentic orchestration,",
      accent: "defined",
      sub: "The term is eighteen months old and already means four things. Here is the one worth keeping, the patterns behind it, and the part nobody defines: where the agents actually run.",
    },
    body: [
      {
        kind: "prose",
        heading: "The definition.",
        paragraphs: [
          "Agentic orchestration is the coordination of several autonomous agents — programs that take a goal, choose their own steps, and use tools to carry them out — so that together they finish work no single agent was given. The orchestrating part is the layer that decides what runs, in what order, on what inputs, and what happens when an agent stalls, fails, or asks for a human.",
          "Three words in that sentence carry the weight. Autonomous: the agents choose their own steps, which is what separates this from a pipeline of fixed scripts. Several: one agent following a plan is just an agent; orchestration begins when the plan spans more than one. And coordination: the value is in the handoffs, the ordering, and the recovery, not in any individual agent being clever.",
        ],
      },
      {
        kind: "points",
        heading: "What it is not.",
        lead: "The term gets borrowed by three neighbours. Telling them apart is most of understanding it.",
        items: [
          {
            title: "Workflow automation",
            body: "Zapier, Airflow, GitHub Actions: the steps are fixed in advance and the system executes them. Reliable precisely because nothing decides anything at runtime. Agentic orchestration starts where the steps are chosen by the agents themselves.",
          },
          {
            title: "A multi-agent system",
            body: "The academic term for many agents interacting — often as peers, often with no coordinator at all. Orchestration is the narrower, practical case: there is a layer above the agents, and it is responsible for the outcome.",
          },
          {
            title: "Tool use inside one agent",
            body: "An agent calling a search tool, then a compiler, then a test runner is doing a lot, but it is one thread of judgment. It becomes orchestration when that agent delegates to others that reason on their own — a coding agent spawning subagents to review, to research, to build in parallel.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "The patterns that exist today.",
        paragraphs: [
          "In practice, orchestration in 2026 takes a handful of shapes. The planner-and-workers shape has one agent decompose a task and dispatch pieces to others, then merge what comes back; Claude Code’s subagents and Codex’s parallel tasks are this shape at the scale of a single repository. The pipeline shape chains agents by role — one drafts, one reviews, one tests — with a human gate between stages. The swarm shape runs many agents on independent slices of the same problem, each in its own checkout, and lets a person triage the results.",
          "All three share a discipline: the orchestrator holds the state, the agents hold the judgment, and the boundary between them is where failures are caught. An agent that stalls is restarted with its context; one that asks a question is paused until the answer arrives; one that finishes is checked before its output is trusted downstream. The frameworks — LangGraph, CrewAI, the vendors’ own agent SDKs — differ mostly in how explicit they make that state.",
        ],
      },
      {
        kind: "prose",
        heading: "The part the definition leaves out.",
        paragraphs: [
          "Every description of orchestration is drawn as boxes and arrows, and none of the boxes says where it runs. That omission is fine for a demo and expensive for real work. Coding agents need a real checkout, a real toolchain, credentials that already live somewhere, and hours of uninterrupted runtime — which means they run on actual machines: a workstation, a build box, a Mac mini under the desk, a GPU host. Orchestration across those machines is where the diagrams stop helping.",
          "The mechanical problems are dull and decisive. Sessions must outlive the laptop that started them. An agent waiting on a yes must be able to reach you wherever you are. Three machines’ worth of agents need one place to be seen, without three VPNs and three SSH keys per device. This is the substrate underneath orchestration, and it is what spawnd provides: one daemon on each host you own, dialing out, and one console — any browser, any phone — where every agent on every machine is a live terminal you can watch, answer, and take over. The server that introduces them carries only ciphertext; the orchestration logic stays yours.",
        ],
      },
      {
        kind: "capture",
        caption:
          "Orchestration with the machines drawn in: one workspace per project, sessions from several hosts in one grid, every agent a real terminal on the machine that owns its checkout.",
      },
    ],
    start: "Give your agents machines, and one place to be seen.",
    faq: [
      {
        q: "Is agentic orchestration the same as agentic AI?",
        a: "No. Agentic AI is the broad claim that models can pursue goals with autonomy. Agentic orchestration is the engineering of several such agents working together — the coordination layer, not the capability.",
      },
      {
        q: "Do I need a framework to orchestrate agents?",
        a: "Not to start. Two Claude Code sessions in separate worktrees with you as the orchestrator is a legitimate, common setup. Frameworks earn their place when the state — who is doing what, what is blocked, what has been checked — outgrows your attention.",
      },
      {
        q: "Where does spawnd sit in an orchestration stack?",
        a: "Underneath it. spawnd does not decide what your agents do; it runs them on your own machines as persistent sessions and gives you one encrypted console to every one of them. Any orchestration logic — a framework, a script, or you — sits on top.",
      },
    ],
    related: [
      {
        title: "Run agents in parallel",
        blurb: "the swarm shape, with the workspace grid as the console",
        href: "/run-agents-in-parallel",
      },
      {
        title: "Keep agents running",
        blurb: "sessions that survive the laptop, the tab, and the daemon",
        href: "/use/keep-agents-running",
      },
      {
        title: "Coding agents on your phone",
        blurb: "the yes an orchestrated agent is waiting for, from anywhere",
        href: "/coding-agents-on-your-phone",
      },
    ],
    cardTitle: "Agentic orchestration",
    cardBlurb: "The definition worth keeping, the patterns behind it, and where the agents run.",
  },

  {
    slug: "cloud-development-environment",
    kind: "definition",
    hub: { name: "Guides", href: "/guides" },
    title: "Cloud development environment, defined",
    description:
      "What a cloud development environment is, where the category came from, what one costs, and the self-hosted kind where the environment is a machine you own.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Cloud development environment,",
      accent: "defined",
      sub: "The definition, the decade that produced it, the bill that comes with it, and the version that runs on hardware you already own.",
    },
    body: [
      {
        kind: "prose",
        heading: "The definition.",
        paragraphs: [
          "A cloud development environment is a complete, working development setup — the source checkout, the toolchain, the dependencies, the services a project needs to run — that lives on a machine other than the one in front of you, is built from a definition rather than by hand, and is reached over the network from something thin: a browser tab, a local IDE in remote mode, or a terminal.",
          "Each clause does work. Environment, not editor: an editor in a tab is a web IDE, and a CDE is the whole machine behind it. From a definition: a `devcontainer.json`, a Nix file, a Terraform template — something that rebuilds the same environment tomorrow, for a colleague, or after you deleted it in anger. Elsewhere: the device you type on holds no code, no credentials, and no state that matters, which is the property that lets you switch devices, onboard a stranger, or wipe a laptop without ceremony.",
        ],
      },
      {
        kind: "prose",
        heading: "Where the category came from.",
        paragraphs: [
          "The idea is older than the name. AWS Cloud9 put an IDE in the browser, and AWS [closed it to new customers on 25 July 2024](https://aws.amazon.com/blogs/devops/how-to-migrate-from-aws-cloud9-to-aws-ide-toolkits-or-aws-cloudshell/). GitHub Codespaces made the modern shape mainstream: a devcontainer built per branch, reachable from VS Code or a browser, [billed per core-hour](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces) after a free allowance. Gitpod grew the same shape into a company, then [renamed itself Ona](https://ona.com/stories/gitpod-is-now-ona) in September 2025 and repositioned around agents; in June 2026 OpenAI [agreed to acquire it](https://www.infoworld.com/article/4184648/openai-buys-ona-to-help-rein-in-ai-agents.html). Google’s Project IDX became Firebase Studio, and Firebase Studio is [being shut down](https://firebase.google.com/docs/studio/migrating-project): no new workspaces since 22 June 2026, everything deleted on 22 March 2027.",
          "The self-hosted line runs alongside. [Coder](https://github.com/coder/coder) is an AGPL-3.0 platform you run on your own infrastructure: workspaces defined in Terraform, connected through a WireGuard tunnel, shut down automatically when idle. [DevPod](https://github.com/loft-sh/devpod) is MPL-2.0 and client-only: it takes a `devcontainer.json` and stands it up on your laptop’s Docker, a machine over SSH, a cloud VM, or a Kubernetes cluster. Read the arc together and a pattern shows: several of the hosted products have closed, renamed, or turned into agent platforms, while the self-hosted tools kept doing the one job.",
        ],
      },
      {
        kind: "points",
        heading: "What they solve.",
        items: [
          {
            title: "Reproducibility",
            body: "The environment is a file in the repo. Two people on the same branch have the same toolchain to the version, and the ‘works on my machine’ conversation ends.",
          },
          {
            title: "Onboarding",
            body: "A new contributor clicks and is compiling before lunch, without a day of installs or a checklist that was true last year.",
          },
          {
            title: "Big machines on demand",
            body: "A 32-core box for the afternoon a build needs one, then gone. Codespaces sells exactly that, by the hour.",
          },
          {
            title: "Nothing on the laptop",
            body: "Code and credentials stay in the environment. Reviewing a stranger’s pull request stops being a risk to the device you bank on.",
          },
        ],
      },
      {
        kind: "table",
        heading: "What they cost.",
        columns: ["The cost", "What it looks like", "The numbers"],
        rows: [
          [
            "Metered hours",
            "The environment bills while it runs, whether or not you are typing",
            "Codespaces: $0.18 an hour for 2 cores up to $2.88 for 32, after 120 free core-hours a month on GitHub Free (180 on Pro)",
          ],
          [
            "Storage while stopped",
            "The disk is billed with the machine off, and deleted if you stay away",
            "Codespaces: $0.07 per GB-month; a stopped codespace is [deleted after 30 days](https://docs.github.com/en/codespaces/setting-your-user-preferences/configuring-automatic-deletion-of-your-codespaces) of inactivity by default",
          ],
          [
            "Idle timeouts",
            "The machine stops when you stop touching it — which is precisely when an agent is doing the work",
            "Codespaces: [30 minutes by default](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces), 240 at most",
          ],
          [
            "Someone else’s environment",
            "Your code runs on their VM, under their terms, for as long as they offer the product",
            "Cloud9 closed to new customers in 2024; Firebase Studio shuts down in March 2027",
          ],
          [
            "Operating one yourself",
            "The self-hosted tools remove the meter and add a platform to run",
            "Coder is a server you deploy and keep; DevPod still needs a backend to provision onto",
          ],
        ],
      },
      {
        kind: "prose",
        heading: "The self-hosted kind, and the plainest version of it.",
        paragraphs: [
          "Coder and DevPod are self-hosted CDEs in the full sense: they still provision, they just do it on machines you control. Underneath them is a plainer version that most working developers already own without calling it anything. The workstation under the desk, the Mac mini, the GPU box in the closet — each is already a complete environment, with the checkout, the toolchain, the credentials, and the disk that a hosted product would have to rebuild. ‘Cloud’ in that version means only ‘reached from anywhere’. Nothing is provisioned, nothing meters, nothing times out; the price is that the machine stays on and you can get to it.",
          "Getting to it is the part that was hard. The classic answer is SSH plus tmux behind a port forward or a VPN, and it works if you keep the discipline. spawnd is that job built as a product: one daemon on each host you own, dialing out, so nothing listens and no port opens; sessions that live on the host, each PTY owned by a worker process, so a build or an agent run survives the closed tab, the dropped connection, and a daemon restart with scrollback intact; and any browser as the console, a phone included, with a new device approved once against a short code. Your browser talks to each daemon peer-to-peer, end-to-end encrypted, and the server that introduces them never sees session content. It provisions nothing and standardises nothing, which is the honest limit — if reproducibility is your problem, [Codespaces](/spawnd-vs-github-codespaces) or [Coder](/spawnd-vs-coder) solves it and this does not. If the problem is reaching machines that already exist, this is the self-hosted CDE with the provisioning removed.",
        ],
      },
      {
        kind: "capture",
        caption:
          "The self-hosted kind from the console: one workspace per project, sessions from three machines that already existed in one grid, no meter running on any of them.",
      },
    ],
    start: "Your own machines, reached from anywhere.",
    faq: [
      {
        q: "Is a cloud development environment the same as remote development?",
        a: "Remote development is the older, narrower thing: your IDE driving one machine over SSH. A CDE adds the definition — the environment is built from a file, so it can be rebuilt, duplicated, and thrown away.",
      },
      {
        q: "Are cloud development environments free?",
        a: "Some have a free allowance — Codespaces gives personal accounts 120 core-hours a month — and the self-hosted tools are open source, but you supply the machines. Your own hardware, reached through spawnd, is the version where the environment itself costs nothing new.",
      },
      {
        q: "Do coding agents need a CDE?",
        a: "They need an environment: a real checkout, a toolchain, and hours of uninterrupted runtime. Hosted agents rent one per task; agents on your own machines already have one. The background agents page covers that split.",
      },
    ],
    related: [
      {
        title: "spawnd vs GitHub Codespaces",
        blurb: "rented per branch versus possessed — the economics and the agent story",
        href: "/spawnd-vs-github-codespaces",
      },
      {
        title: "spawnd vs Coder and code-server",
        blurb: "provisioned workspaces versus machines that already exist",
        href: "/spawnd-vs-coder",
      },
      {
        title: "Background agents, defined",
        blurb: "the agents a CDE exists to host, and whose machine they run on",
        href: "/background-agents",
      },
    ],
    cardTitle: "Cloud development environment",
    cardBlurb: "The definition, the history, the bill, and the self-hosted kind.",
  },

  {
    slug: "background-agents",
    kind: "definition",
    hub: { name: "Guides", href: "/guides" },
    title: "Background agents, defined",
    description:
      "What a background agent is, the products that use the term — Cursor, Codex, Claude Code, Copilot, Jules, Devin — what one needs, and whose machine it runs on.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Background agents,",
      accent: "defined",
      sub: "What the term means, the seven products that mean slightly different things by it, what an agent needs to work while you are gone, and whose machine it is on.",
    },
    body: [
      {
        kind: "prose",
        heading: "The definition.",
        paragraphs: [
          "A background agent is an agent handed a task that it carries out unattended — in its own environment, on its own clock — and that reports back when it is done, interrupting you only when it must. The contrast is the foreground agent, the one you sit with: you send a message, it works, you read the result, you send the next. A background agent removes the turn-taking. You dispatch, you leave, and the next thing you see is a branch, a pull request, a diff, or a question.",
          "Four properties make one. It runs unattended, which takes the judgment to keep going when the plan meets reality. It runs in a real environment — a checkout, a toolchain, a way to run the tests — because an agent that cannot execute is a draft generator. It has a return path, so the work arrives somewhere you will look. And it has an interrupt: a way to ask for a permission or a decision without losing its place. Those four separate it from a scheduled job (no judgment), a subagent (spawned by another agent, inside its process), and a chatbot with a long timeout.",
        ],
      },
      {
        kind: "table",
        heading: "The products that use the term.",
        lead: "Seven products, checked against their own documentation. Count how many mean ‘a fresh machine of ours per task’, and note the one that does not.",
        columns: ["Product", "What it actually is", "Where it runs", "How it comes back"],
        rows: [
          [
            "[Cursor cloud agents](https://cursor.com/docs/background-agent)",
            "Formerly Background Agents: the Cursor agent in a remote VM with the repo cloned and dependencies installed",
            "Isolated Ubuntu VMs in Cursor’s cloud, charged at API pricing for the model",
            "A branch pushed to your repo, then a PR; started from the desktop app, cursor.com/agents, Slack, the iOS app, or an `@cursor` comment on GitHub or Bitbucket",
          ],
          [
            "[Codex cloud](https://learn.chatgpt.com/docs/cloud)",
            "OpenAI’s Codex running delegated tasks, several in parallel",
            "Isolated cloud environments configured per repository; GitHub or GitLab",
            "A summary and diff to review, a PR when you ask; started from chatgpt.com/codex, the app, the CLI, GitHub, GitLab, Linear, or Slack",
          ],
          [
            "[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)",
            "Claude Code on Anthropic-managed infrastructure; research preview for Pro, Max, and Team",
            "An isolated VM per session, reclaimed after inactivity; no compute charge, shared rate limits",
            "A PR from the web, or `claude --teleport` to pull the session into your terminal; started at claude.ai/code, the mobile app, or `claude --cloud`",
          ],
          [
            "[Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)",
            "The reverse: a session on your own machine, driven from the Claude app or claude.ai/code",
            "Your machine; if the laptop sleeps it reconnects when the machine is back, and nothing ran in between",
            "The session itself, live on your phone; the transcript sits on Anthropic’s servers to keep devices in sync",
          ],
          [
            "[Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)",
            "GitHub’s agent, formerly Copilot coding agent; assign it an issue or mention `@copilot`",
            "An ephemeral GitHub Actions environment; paid Copilot plans, using Actions minutes and AI credits",
            "Changes on a branch, a draft PR when you want one",
          ],
          [
            "[Google Jules](https://jules.google/docs)",
            "Google’s autonomous coding agent; it plans before it edits",
            "A VM where it clones the repo and installs dependencies; free tier of 15 tasks a day, 3 at once",
            "A plan to approve, then a PR; a notification when it finishes or needs you",
          ],
          [
            "[Devin](https://docs.devin.ai/get-started/devin-intro)",
            "An autonomous AI software engineer that writes, runs, and tests code",
            "Its own cloud environment; reached from app.devin.ai, Slack, Teams, or a CLI",
            "A PR at the end of a session",
          ],
        ],
      },
      {
        kind: "points",
        heading: "What a background agent needs.",
        items: [
          {
            title: "A real environment",
            body: "The repo with its dependencies, its test suite, its `.env`, its GPU if the work needs one. Hosted products rebuild this per task from a definition; your own machine already has it.",
          },
          {
            title: "Persistence",
            body: "The agent must outlive the device that dispatched it. A closed laptop cannot end the run, and a two-hour job cannot depend on a browser tab.",
          },
          {
            title: "A way to reach you",
            body: "Permission prompts and questions are the point of the interrupt. If they land in a terminal nobody is watching, the agent waits — sometimes all night.",
          },
          {
            title: "A way back",
            body: "A branch and a PR is the common answer. Better is that plus the ability to step into the session and take over when the PR is wrong in a way a comment cannot fix.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Hosted, or your own machine.",
        paragraphs: [
          "Every product in the table sits on one side of a line. The hosted ones — Cursor, Codex, Claude Code on the web, Copilot, Jules, Devin — give you a fresh machine per task, parallelism up to your plan’s limits, and none of the operations. They also give you their constraints: the repository must be somewhere they can clone, mostly GitHub; the secrets and services a task needs must be reproducible from a config; the environment is theirs to reclaim when the task goes quiet, as Claude Code on the web does with an idle VM; and the machine is theirs, which matters when the work involves a private dataset, a model on your own GPU, or code that is not allowed to leave the building. The rate limits and the meter are theirs too.",
          "The other side is your own hardware, where nothing is rebuilt because the environment already exists. Remote Control is the instructive case: Anthropic’s own answer to ‘drive my machine from my phone’, and it is exactly that — the session runs on your laptop, and when the laptop sleeps the agent stops until it wakes. That is the gap. A background agent on a machine you own needs the machine to stay up, the session to survive whatever you do with the screen, and a channel to you that does not depend on a terminal being watched.",
        ],
      },
      {
        kind: "prose",
        heading: "Where spawnd sits.",
        paragraphs: [
          "spawnd is that substrate, not another agent. One daemon on each host you own dials out, so nothing listens and no port opens. Every session lives on the host, its PTY owned by a worker process, so an agent dispatched at six is still running at nine whichever laptop lid closed in between, and it comes back with scrollback intact even after the daemon restarts. Workspaces, one per project, hold a grid of those sessions across hosts; when an agent stops to ask for a yes, the session shows an attention cue and your phone gets a notification, and any browser is the console to answer from — no client app, no keys on the device. The agents are the ones you already run: Claude Code, Codex, OpenCode, and Aider as built-in shortcuts, any other CLI as a named command, each signing in on the host as it always has. What spawnd does not do is decide what the agents work on — that is [orchestration](/agentic-orchestration), and it sits above this. What it does is make [keeping agents running](/use/keep-agents-running) and [running several at once](/run-agents-in-parallel) a property of the host rather than a habit of yours.",
        ],
      },
      {
        kind: "capture",
        caption:
          "Background agents with the machines drawn in: one workspace, sessions across three hosts you own, and the one that stopped to ask — visible from wherever you are.",
      },
    ],
    start: "Give your agents a machine that stays on.",
    faq: [
      {
        q: "Is a background agent the same as an autonomous agent?",
        a: "Autonomy is the capability — choosing its own steps. Background is the arrangement — running unattended in its own environment and reporting back. Every background agent is autonomous; a foreground session of the same agent is not background.",
      },
      {
        q: "Do background agents need GitHub?",
        a: "The hosted ones mostly do: they clone from it and return pull requests to it, with GitLab or Bitbucket supported by some. An agent on your own machine works in whatever checkout is there, GitHub or not.",
      },
      {
        q: "Can Claude Code be a background agent on my own machine?",
        a: "Yes, two ways. Remote Control keeps the session local and lets your phone drive it, but the run stops when the machine sleeps. Under spawnd the session lives on a host that stays on, and the phone is one of several consoles to it.",
      },
    ],
    related: [
      {
        title: "Keep agents running",
        blurb: "sessions that survive the laptop, the tab, and the daemon",
        href: "/use/keep-agents-running",
      },
      {
        title: "Agentic orchestration, defined",
        blurb: "the layer above: who decides what the agents do",
        href: "/agentic-orchestration",
      },
      {
        title: "Run agents in parallel",
        blurb: "several background agents, one grid, one place to be seen",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "Background agents",
    cardBlurb: "The definition, the products that use the term, and whose machine the agent is on.",
  },
];
