import { ARTICLE_HUBS, ARTICLES } from "./articles";
import type { FlatRelatedLink, HubEntry } from "./flat-types";

/*
 * Hub pages, flat-slug edition (docs/SEO_TREE.md, hub template): real
 * content targeting the category head term, then the rack of spokes.
 * Hubs carry the site-level JSON-LD (Organization + SoftwareApplication).
 */

/**
 * The guides rack, computed: the two agent pillars first, then every
 * article in catalogue order, then the hand-built tool pages. A page added
 * to a cluster file is racked here without a second edit.
 */
const GUIDES_RACK: FlatRelatedLink[] = [
  ...ARTICLE_HUBS.map((hub) => ({
    title: hub.cardTitle,
    blurb: hub.cardBlurb,
    href: `/${hub.slug}`,
  })),
  ...ARTICLES.map((article) => ({
    title: article.cardTitle,
    blurb: article.cardBlurb,
    href: `/${article.slug}`,
  })),
  {
    title: "Claude plan calculator",
    blurb: "Pro vs Max 5x vs Max 20x vs API, by hours of agent use per day",
    href: "/claude-plan-calculator",
  },
  {
    title: "tmux cheatsheet",
    blurb: "sessions, windows, panes, and the fixes — searchable, every command verified",
    href: "/tmux-cheatsheet",
  },
];

export const HUBS: HubEntry[] = [
  {
    slug: "guides",
    title: "Guides to running coding agents anywhere",
    description:
      "Guides, references, fixes, and definitions for the agent era: Claude Code, Codex, OpenCode, Aider, SSH from a phone, reaching a Mac — the DIY route first.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Guides for the",
      accent: "agent era",
      sub: "How the CLI coding agents actually work, how to reach the machines they run on, and what to do when either misbehaves — written to be useful whether or not you ever install anything of ours.",
    },
    essay: [
      {
        heading: "What these pages are for.",
        paragraphs: [
          "A coding agent is a program that takes a goal, works in a real shell on a real machine, and asks you for a yes now and then. Almost everything worth knowing about running one is unglamorous: how it authenticates, where its settings live, how to keep it running after the laptop closes, how to reach it from a phone, why a tunnel says “starting” forever. The vendors’ docs cover their own product on its happy path. These guides cover the seams between products, machines, and devices — the places where a search engine is the only support desk.",
          "Every page here follows one rule: teach the thing you searched for first, completely, using tools you already have. Where that honest route runs out — a session that must survive your absence, a machine you would rather not expose, a phone that needs a real terminal — the page says so, and only then shows what spawnd does about it. If you stop reading before that turn, you still got what you came for.",
        ],
      },
      {
        heading: "How the pages are grouped.",
        paragraphs: [
          "Agent guides cover Claude Code and Codex in depth — plans and pricing, settings and commands, running them remotely and in teams — plus the open alternatives, OpenCode and Aider. Device guides cover SSH from an iPhone, iPad, or Android, and every method for reaching a Mac from somewhere else. Reference pages define the vocabulary the industry is settling on. Fix pages start from the exact error you pasted into the search box. Each page links its siblings, so the rack below is a map, not a menu.",
        ],
      },
    ],
    spokes: GUIDES_RACK,
    rackHeading: "Every guide, reference, definition, fix, and tool.",
    faq: [
      {
        q: "Are these guides only useful with spawnd?",
        a: "No. Each one teaches the searched-for thing completely with the tools you already have, and names spawnd only where that honest route runs out. Most readers should get what they came for before the product appears.",
      },
      {
        q: "How current are the agent facts?",
        a: "Each page carries the date it was written and last checked. Agent CLIs change monthly; commands and flags are verified against the vendor’s current documentation at the date shown, and a page whose facts drift is corrected or pruned, never left to mislead.",
      },
      {
        q: "Which agents does spawnd run?",
        a: "Claude Code, Codex, OpenCode, and Aider ship as built-in shortcuts, and any CLI can be added — an agent is a named command in a real shell. If it runs in a terminal, it runs here.",
      },
    ],
    related: [
      {
        title: "Run agents in parallel",
        blurb: "the flagship: a fleet of sessions, one console",
        href: "/run-agents-in-parallel",
      },
      {
        title: "Coding agents on your phone",
        blurb: "the device row: every agent from a phone, with real captures",
        href: "/coding-agents-on-your-phone",
      },
      {
        title: "Compared",
        blurb: "spawnd against every tool that shares a job with it, row by row",
        href: "/vs",
      },
    ],
    cardTitle: "Guides",
    cardBlurb: "Agent guides, device guides, definitions, and fixes — the DIY route first.",
  },
  {
    slug: "coding-agents-on-your-phone",
    title: "Coding agents on your phone",
    description:
      "Claude Code, Codex, and their kin from a phone: the cloud route, the SSH route, and the console pattern — sessions on your machines, the phone as the window.",
    datePublished: "2026-08-31",
    dateModified: "2026-08-31",
    hero: {
      plain: "Coding agents",
      accent: "on your phone",
      sub: "The agent era made the phone a legitimate dev surface — not for writing code, but for running the things that write it. Here's the whole landscape, honestly.",
    },
    essay: [
      {
        heading: "Why this suddenly works.",
        paragraphs: [
          "Phones didn’t get better at programming; programming grew a workload phones are good at. A coding agent runs for minutes or hours between decisions, and what it needs from you is exactly what a phone delivers: a glance at progress, a readable diff, a yes. The typing-heavy part moved into the agent; the judgment-heavy part fits in a pocket.",
          "Every serious route to that loop is one of three shapes. The vendors’ clouds — Anthropic’s and OpenAI’s hosted sessions — run the agent on their machines against your GitHub repos: zero setup, real results, their environment. SSH client apps like Blink and Termius reach your own machines the classical way: real terminals, with keys to manage, hosts to expose, and tmux to remember. And the console pattern — spawnd’s — keeps sessions on your machines but makes the phone an approved window onto them: no client app, no keys, no listener on any host, every session end-to-end encrypted to its own machine.",
        ],
      },
      {
        heading: "The pattern, in one paragraph.",
        paragraphs: [
          "One daemon on each machine you own, dialing out — nothing listens. Your phone’s browser, installed as a web app, is approved once against a short code and becomes a console for the whole fleet: workspaces per project, tabs per concern, agents in real shells with your logins and your config. Sessions persist on the hosts with scrollback, attention finds you as notifications, and the server in the middle carries only ciphertext. The per-agent pages below walk the loop with real captures.",
        ],
      },
    ],
    spokes: [
      {
        title: "Claude Code on your phone",
        blurb: "the permission prompt, the diff, and the one-tap yes — captured live",
        href: "/claude-code-on-your-phone",
      },
      {
        title: "Codex on your phone",
        blurb: "dispatch the suite from the couch, read the verdict there too",
        href: "/codex-on-your-phone",
      },
      {
        title: "Code on an iPad",
        blurb: "the fleet's best reading surface — with room to think",
        href: "/code-on-an-ipad",
      },
      {
        title: "Code on a Chromebook",
        blurb: "a browser with a keyboard, which is all the console needs",
        href: "/code-on-a-chromebook",
      },
    ],
    faq: [
      {
        q: "Which agents work with spawnd?",
        a: "Claude Code, Codex, OpenCode, and Aider ship as built-in shortcuts, and any CLI can be added — an agent is just a named command typed into a real shell. If it runs in a terminal, it runs here, and your phone can reach it.",
      },
      {
        q: "Do I write code on the phone in this pattern?",
        a: "Rarely, and nothing here pretends otherwise. The phone's job is the loop — dispatch, notice, read, answer. The writing happens in the agent's session on your machine, which is also where it belongs.",
      },
      {
        q: "What does the phone actually need?",
        a: "A browser. spawnd installs to the home screen as a web app; there are no client apps, no keys on the device, and nothing to configure per machine. Approval is one short code; revocation is one click.",
      },
    ],
    related: [
      {
        title: "Run agents in parallel",
        blurb: "the fleet behind every page in this row",
        href: "/run-agents-in-parallel",
      },
      {
        title: "Keep agents running",
        blurb: "sessions that outlive every device",
        href: "/use/keep-agents-running",
      },
      {
        title: "spawnd vs mobile SSH apps",
        blurb: "the client-app route, measured honestly",
        href: "/spawnd-vs-mobile-ssh-apps",
      },
    ],
    cardTitle: "Coding agents on your phone",
    cardBlurb: "Every agent, every route, one pattern — the hub for the device row.",
  },
];
