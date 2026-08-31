import type { HubEntry } from "./flat-types";

/*
 * Hub pages, flat-slug edition (docs/SEO_TREE.md, hub template): real
 * content targeting the category head term, then the rack of spokes.
 * Hubs carry the site-level JSON-LD (Organization + SoftwareApplication).
 */

export const HUBS: HubEntry[] = [
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
