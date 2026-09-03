import { ARTICLE_HUBS, ARTICLES } from "./articles";
import { TOOLS } from "./tools";
import type { HubEntry, RelatedLink } from "./types";

/*
 * The guides hub: real content for the category, then the rack of every
 * page the grimoire prescribed. The rack is computed — the two agent
 * pillars first, then every article in catalogue order, then the tools —
 * so a page added to a cluster file is racked without a second edit.
 */

const GUIDES_RACK: RelatedLink[] = [
  ...ARTICLE_HUBS.map((hub) => ({
    title: hub.cardTitle,
    blurb: hub.cardBlurb,
    href: `/${hub.slug}`,
  })),
  ...ARTICLES.map((a) => ({ title: a.cardTitle, blurb: a.cardBlurb, href: `/${a.slug}` })),
  ...TOOLS.map(({ title, blurb, href }) => ({ title, blurb, href })),
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
          "Agent guides cover Claude Code and Codex in depth — plans and pricing, settings and commands, running them remotely and in teams — plus the open alternatives, OpenCode and Aider. Device guides cover SSH from an iPhone, iPad, or Android, and every method for reaching a Mac from somewhere else. Reference pages define the vocabulary the industry is settling on. Fix pages start from the exact error you pasted into the search box. Two tools do sums and lookups a page of prose can’t. Each page links its siblings, so the rack below is a map, not a menu.",
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
        title: "Claude Code",
        blurb: "the pillar: plans, settings, commands, and running it from anywhere",
        href: "/claude-code",
      },
      {
        title: "Codex CLI",
        blurb: "the complete guide to OpenAI’s coding agent",
        href: "/codex",
      },
      {
        title: "Security",
        blurb: "the server that can’t read your terminal — the whole ledger",
        href: "/security",
      },
    ],
    cardTitle: "Guides",
    cardBlurb: "Agent guides, device guides, definitions, and fixes — the DIY route first.",
  },
];
