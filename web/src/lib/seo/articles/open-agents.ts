import type { ArticleEntry } from "../flat-types";

/*
 * The open agents (grimoire play 2 extension): OpenCode vs Aider, OpenCode
 * pricing. Pure data on the article template; see definitions.ts for the
 * exemplar. spawnd runs both tools, so these pages have no horse in the race.
 *
 * Facts checked 2026-09-03 against:
 *   https://opencode.ai/  https://opencode.ai/docs/  https://opencode.ai/docs/providers/
 *   https://opencode.ai/docs/zen/  https://opencode.ai/docs/go/  https://opencode.ai/docs/cli/
 *   https://opencode.ai/docs/tui/  https://opencode.ai/docs/agents/  https://opencode.ai/docs/ide/
 *   https://opencode.ai/docs/server/  https://opencode.ai/docs/share/  https://opencode.ai/docs/rules/
 *   https://opencode.ai/docs/lsp/  https://opencode.ai/docs/troubleshooting/
 *   https://github.com/anomalyco/opencode (sst/opencode redirects here; MIT; README desktop
 *     app + install methods; languages API: TypeScript; releases API: v1.18.27 on 2026-09-02)
 *   https://aider.chat/  https://github.com/Aider-AI/aider (Apache-2.0; last commit 2026-05-22)
 *   https://aider.chat/docs/install.html  https://aider.chat/docs/more/edit-formats.html
 *   https://aider.chat/docs/git.html  https://aider.chat/docs/usage/modes.html
 *   https://aider.chat/docs/llms.html  https://aider.chat/docs/repomap.html
 *   https://aider.chat/docs/usage/watch.html  https://aider.chat/docs/usage/browser.html
 *   https://aider.chat/docs/usage/commands.html  https://aider.chat/docs/config/options.html
 *   https://aider.chat/docs/usage/lint-test.html  https://aider.chat/docs/scripting.html
 *   https://aider.chat/docs/leaderboards/  https://pypi.org/project/aider-chat/ (0.86.2 on
 *     2026-02-12; 0.86.1 2025-08-13; 0.86.0 2025-08-09)
 *   https://github.com/features/copilot/plans
 * Not stated because not verifiable or too volatile: Zen's per-model prices (only the pricing
 * model is described); whether the "Claude Pro/Max" option in OpenCode's /connect still works
 * after the 1.3.0 plugin removal — the pages report only what the docs say; Aider's earlier
 * release cadence (only the dated releases are cited).
 */

export const OPEN_AGENTS: ArticleEntry[] = [
  {
    slug: "opencode-vs-aider",
    kind: "explainer",
    hub: { name: "Guides", href: "/guides" },
    title: "OpenCode vs Aider: an agent and a pair programmer",
    description:
      "OpenCode runs a tool loop; Aider edits the files you hand it and commits every change. Architecture, models, licences, sessions, and when to pick which.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "OpenCode vs",
      accent: "Aider",
      sub: "Both are free, open source, and live in your terminal. They disagree about nearly everything else — here is where, and which disagreement should decide it for you.",
    },
    body: [
      {
        kind: "prose",
        heading: "Two tools, two ideas of the job.",
        paragraphs: [
          "OpenCode calls itself [the open source AI coding agent](https://opencode.ai/), and the word to weigh is agent. It is a TypeScript program under the MIT licence from Anomaly; the repository, once under the SST organisation, now lives at [anomalyco/opencode](https://github.com/anomalyco/opencode). Give it a task and it decides what to read, edits files, runs commands, watches the results, and goes again, under permission rules you set per tool. The architecture is client/server: a headless server (`opencode serve`, an HTTP API on localhost) with the terminal UI as one client and a web client, a desktop app in beta, and a VS Code-family extension as the others. It ships a `build` agent with every tool enabled and a `plan` agent that asks before edits and shell commands, and it moves fast — v1.18.27 landed on 2 September 2026.",
          "Aider calls itself [AI pair programming in your terminal](https://aider.chat/), and the word to weigh is pair. It is a Python program under Apache-2.0 from Paul Gauthier, installed with `aider-install` on Python 3.8 to 3.13. You add files to the chat, say what you want, and Aider edits those files and commits the result — every change a git commit with a generated message, undone with `/undo`. It does not wander: it lints after edits and runs your tests if you give it a `--test-cmd`, but any other shell command is one you run yourself with `/run`. Its pace has slowed: the newest release on PyPI is 0.86.2 from February 2026, three point releases since August 2025, though pull requests were still being merged in May 2026.",
        ],
      },
      {
        kind: "prose",
        heading: "The difference that decides everything else.",
        paragraphs: [
          "An agent owns the loop; a pair programmer shares it. With OpenCode you describe the outcome and watch a transcript of tool calls: the model chooses what to open, what to search, what to run, and how many times to try, and your control is the permission table — `ask`, `allow`, or `deny` per tool, down to a glob. With Aider you own the context: the repo map (a graph-ranked summary of the codebase, about a thousand tokens by default) tells the model what exists, `/add` tells it what it may change, and each reply is a set of edits you read as a diff before the next turn.",
          "The editing mechanics follow. Aider asks the model for edits in a format chosen per model — `whole` files, `diff` search/replace blocks, `udiff`, or an architect/editor pair where one model proposes and a second writes the edits — and turns every accepted edit into a commit. OpenCode edits through tools, keeps its own `/undo` and `/redo` of messages and file changes, and leaves git to you; nothing is committed until you commit it. One approach puts the model’s work in the history where you can audit it; the other keeps the history yours. Which you prefer says more about how you review than about the tools.",
        ],
      },
      {
        kind: "table",
        heading: "Side by side.",
        columns: ["Question", "OpenCode", "Aider"],
        rows: [
          [
            "Model of work",
            "An agent: it plans, edits, runs, and iterates under per-tool permissions",
            "A pair programmer: it edits the files you add and commits each change",
          ],
          ["Language and licence", "TypeScript; MIT", "Python; Apache-2.0"],
          [
            "Interface",
            "Terminal UI, web client, desktop app (beta), and VS Code-family extension — all clients of one local server",
            "Terminal chat; `--watch-files` reacts to `AI!` comments from any editor; an experimental `--browser` UI",
          ],
          [
            "Models",
            "75+ providers through Models.dev; Ollama, LM Studio, and llama.cpp locally; ChatGPT Plus/Pro and GitHub Copilot sign-in; OpenCode’s own Zen and Go",
            "Almost any model by API key: OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Bedrock, Azure, Ollama, and OpenAI-compatible endpoints",
          ],
          ["Price", "Free; you pay the model provider", "Free; you pay the model provider"],
          [
            "Editing",
            "Tool calls; `/undo` and `/redo` of messages and file changes; git is yours",
            "Edit formats chosen per model; auto-commit with a generated message; `/undo` reverts the last commit",
          ],
          [
            "Context",
            "Reads on its own judgment; `AGENTS.md` rules; optional LSP diagnostics; `/compact`",
            "Graph-ranked repo map plus the files you `/add`; chat history summarised past a token limit",
          ],
          [
            "Sessions",
            "Stored under `~/.local/share/opencode/`; `/sessions`, `--continue`, `--fork`; `/share` links",
            "`.aider.chat.history.md` in the repo; `--restore-chat-history` to reload it",
          ],
          [
            "Automation",
            "Runs commands itself within your permission rules; `opencode run` for scripts",
            "Auto-lint on by default; auto-test with `--test-cmd`; `/run` for the rest; `--message` for scripts",
          ],
          [
            "Release cadence",
            "Frequent; v1.18.27 on 2 September 2026",
            "0.86.2 in February 2026; three releases since August 2025",
          ],
        ],
      },
      {
        kind: "points",
        heading: "Choose OpenCode when.",
        items: [
          {
            title: "The task is bigger than a diff",
            body: "Multi-file work that needs exploring, running, and retrying is what an agent loop is for. Start in `plan` to read the approach before anything is edited.",
          },
          {
            title: "You already pay for ChatGPT or Copilot",
            body: "OpenCode signs into a ChatGPT Plus/Pro or GitHub Copilot account from `/connect`. Aider is API keys.",
          },
          {
            title: "You want the same session in more than one window",
            body: "One session in the terminal, the desktop app, or the IDE, and a script can drive it through the API.",
          },
        ],
      },
      {
        kind: "points",
        heading: "Choose Aider when.",
        items: [
          {
            title: "You want to read every change before the next one",
            body: "Small, reviewable, committed steps are Aider’s whole design; the git history is the audit trail.",
          },
          {
            title: "Tokens are the budget",
            body: "You decide what the model sees, so a session costs what you put in front of it. An agent loop reads far more than it writes.",
          },
          {
            title: "You already have keys and a workflow",
            body: "Any provider, any editor through `--watch-files`, scriptable with `--message` and `--yes-always`. Nothing to sign into.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Whichever wins, it runs on a machine.",
        paragraphs: [
          "Both tools end the same way: a process on a computer, holding a checkout, a login, and hours of work. OpenCode’s server listens on localhost; Aider is a chat in a terminal. Reaching that computer from the other laptop, or from a phone when the agent asks a question at nine, is the same problem for both, and it is the one spawnd is built for. One daemon on each host you own dials out, so nothing listens and no port opens; every session lives on the host, its PTY owned by a worker process, so it survives the closed tab, the dropped connection, and the laptop lid, scrollback intact; and any browser is the console, a phone included. OpenCode and Aider are built-in shortcuts beside Claude Code and Codex — an agent is a named command in a real shell, so any CLI can be added — and they authenticate on the host exactly as they do today; spawnd holds no provider credentials and adds no API-key markup. Pick either. Here is [OpenCode under spawnd](/for/opencode), and [Aider](/for/aider).",
        ],
      },
    ],
    start: "Either agent, on any host you own, from anywhere.",
    faq: [
      {
        q: "Is OpenCode a fork of Aider?",
        a: "No. They share no code: OpenCode is a TypeScript client/server agent from Anomaly; Aider is a Python pair-programming tool from Paul Gauthier. What they share is the category — both are open source, free, and bring-your-own-model.",
      },
      {
        q: "Can I use a Claude Pro or Max subscription with either?",
        a: "Not by the book. Aider documents API keys, not subscription logins. OpenCode’s docs note that plugins routing Claude Pro/Max through it exist, that Anthropic explicitly prohibits this, and that OpenCode stopped bundling them as of 1.3.0. ChatGPT Plus/Pro and GitHub Copilot logins are supported; Anthropic models want an API key.",
      },
      {
        q: "Can I use both on the same repository?",
        a: "Yes, and people do — Aider for surgical, committed changes and OpenCode for exploratory work. Commit or stash between them: Aider commits as it goes, OpenCode leaves the working tree to you, and mixing the two in one dirty tree is how you lose track of what changed.",
      },
    ],
    related: [
      {
        title: "OpenCode under spawnd",
        blurb: "the agent on a host you own, reached from any browser",
        href: "/for/opencode",
      },
      {
        title: "Aider under spawnd",
        blurb: "the pair programmer, persistent on the machine with the checkout",
        href: "/for/aider",
      },
      {
        title: "Is OpenCode free?",
        blurb: "the program is; every way to pay for the model behind it",
        href: "/is-opencode-free",
      },
    ],
    cardTitle: "OpenCode vs Aider",
    cardBlurb: "An agent and a pair programmer, compared by a party that runs both.",
  },

  {
    slug: "is-opencode-free",
    kind: "explainer",
    hub: { name: "Guides", href: "/guides" },
    title: "Is OpenCode free? What costs money and what doesn’t",
    description:
      "OpenCode is MIT-licensed and free to install; the model is the bill. Every way to pay for one: API keys, a subscription you already have, Zen, Go, or a local model.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Is OpenCode",
      accent: "free?",
      sub: "Yes — the program. The model behind it is where the money goes, and here is every way to pay for one through OpenCode, including the ways that cost nothing.",
    },
    body: [
      {
        kind: "prose",
        heading: "The short answer.",
        paragraphs: [
          "OpenCode is free. The program is open source under the MIT licence ([anomalyco/opencode](https://github.com/anomalyco/opencode)), installs with npm, Homebrew, Scoop, pacman, Nix, or a curl script, and runs without an account: `opencode` in a repository, `/connect` to point it at a model, and you are working. No trial, no seat, no paid tier of the tool itself. The desktop app and the IDE extension are free too.",
          "What is not free is the model. Every message you send goes to a large language model, and whoever serves that model charges for it — per token, or through a subscription with limits. OpenCode is unusual in how many ways it lets you pay that bill, from keys you already hold, to a subscription it sells itself, to a model on your own GPU. The table is the whole answer; the rest of the page is the fine print.",
        ],
      },
      {
        kind: "table",
        heading: "Every way to pay for a model through OpenCode.",
        columns: ["Route", "What it costs", "How it works"],
        rows: [
          [
            "Your own API keys",
            "Per token, at the provider’s rates",
            "`/connect`, pick a provider, paste the key; [75+ providers](https://opencode.ai/docs/providers/) through Models.dev — Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Bedrock, Azure, Vertex, and more",
          ],
          [
            "ChatGPT Plus or Pro",
            "The subscription you already pay OpenAI",
            "`/connect`, choose OpenAI, then ChatGPT Plus/Pro; it opens a browser to sign in",
          ],
          [
            "GitHub Copilot",
            "Your Copilot plan — Free at $0, Pro $10, Pro+ $39, Max $100 a month",
            "Device-code login at github.com/login/device; some models need Pro+",
          ],
          [
            "Claude Pro or Max",
            "Not a supported route",
            "OpenCode’s docs say Anthropic explicitly prohibits it and that the plugins were removed in 1.3.0; use an Anthropic API key instead",
          ],
          [
            "OpenCode Zen",
            "Pay as you go: credits, priced per million tokens by model; a handful of free models",
            "Sign up at opencode.ai/auth; the balance auto-reloads $20 when it drops below $5 by default — [Zen docs](https://opencode.ai/docs/zen/)",
          ],
          [
            "OpenCode Go",
            "$10 a month for open-weight models",
            "Usage caps of $12 per five hours, $30 a week, $60 a month; top up if needed — [Go docs](https://opencode.ai/docs/go/)",
          ],
          [
            "A local model",
            "Hardware and electricity",
            "Ollama, LM Studio, or llama.cpp’s `llama-server`, configured as a provider in `opencode.json`",
          ],
        ],
      },
      {
        kind: "prose",
        heading: "What ‘free’ actually costs.",
        paragraphs: [
          "Three of those routes can cost nothing, and each has a catch worth knowing before you plan around it. Copilot Free is real but small — [GitHub’s plan page](https://github.com/features/copilot/plans) caps it at 2,000 completions and 50 chat requests a month, and an agent that reads, edits, and retries spends requests quickly. Zen’s free models are genuinely free, but the list is whichever models the OpenCode team is offering at no charge at the time, not the frontier ones. A local model through Ollama costs nothing per token and everything up front: a GPU with enough memory for a coding-capable model, and the honest gap between that model and the ones the paid routes serve.",
          "The paid routes differ in how the meter runs. API keys bill exactly what the agent used, which is transparent and occasionally alarming — an agent loop reads far more than it writes. Subscriptions (ChatGPT, Copilot, Go) trade that for a ceiling: a flat amount, and limits instead of a surprise. Which is cheaper depends on how much you run; if you are weighing a subscription against tokens, [the plan calculator](/claude-plan-calculator) does that arithmetic for Anthropic’s plans, and the reasoning transfers. Whatever the route, the levers are the same: start in the `plan` agent to read the approach before it edits, keep `AGENTS.md` short and true, and `/compact` a session before it grows a long tail.",
        ],
      },
      {
        kind: "prose",
        heading: "The cost the table leaves out.",
        paragraphs: [
          "The last thing OpenCode needs is a computer to run on, and that is the one cost no licence can remove. It runs on your laptop, which closes; or on a desktop or a server, which you then have to reach. If the agent is going to work for an hour on a machine you own, the question becomes how you check on it from somewhere else, and how it asks you something at the moment it needs to. That is what spawnd does: one daemon on each host you own, dialing out so nothing listens and no port opens; sessions that live on the host and survive the closed tab and the laptop lid; and any browser as the console, a phone included. OpenCode is a built-in shortcut, and it signs into ChatGPT, Copilot, or your keys on the host exactly as it does today — spawnd holds no provider credentials and adds no API-key markup. The tool stays free and the machine stays yours; [here is what that looks like for OpenCode](/for/opencode).",
        ],
      },
    ],
    faq: [
      {
        q: "Do I need an OpenCode account?",
        a: "Not to use the program. An account at opencode.ai/auth exists for Zen and Go, OpenCode’s own model routes, and for share links. With your own API keys, a ChatGPT or Copilot login, or a local model, you never create one.",
      },
      {
        q: "Is OpenCode Zen free?",
        a: "Zen is pay as you go — you load credits and each model is priced per million tokens — with a small, changing set of models offered free. Go is the subscription: $10 a month for open-weight models, with usage caps.",
      },
      {
        q: "Is OpenCode cheaper than Aider?",
        a: "Both tools are free; the models cost the same wherever you call them from. What differs is how much each tool reads per task — an agent loop explores, a pair programmer sees only what you add. The OpenCode vs Aider page covers that axis.",
      },
    ],
    related: [
      {
        title: "OpenCode vs Aider",
        blurb: "an agent and a pair programmer, side by side",
        href: "/opencode-vs-aider",
      },
      {
        title: "OpenCode under spawnd",
        blurb: "the free agent on a host you own, reached from any browser",
        href: "/for/opencode",
      },
      {
        title: "Claude plan calculator",
        blurb: "subscription versus tokens, with the arithmetic done",
        href: "/claude-plan-calculator",
      },
    ],
    cardTitle: "Is OpenCode free?",
    cardBlurb:
      "The program is; the model is the bill. Every way to pay it, including the free ones.",
  },
];
