import type { DeviceEntry } from "./flat-types";

/*
 * Device pages, flat-slug edition (docs/SEO_TREE.md, device template).
 * Teach-first like every page: the honest routes that exist today come
 * before spawnd does. The signature vignettes are real captures from the
 * live app — real sessions, real prompts, real diffs (see the runbook's
 * representation standards). Nobody writes a module on a phone, and no
 * page here pretends otherwise: the phone's job is the loop — dispatch,
 * notice, answer, read the diff — and these pages sell exactly that.
 */

export const DEVICES: DeviceEntry[] = [
  {
    slug: "claude-code-on-your-phone",
    title: "Claude Code on your phone",
    description:
      "The routes that work today — Anthropic’s cloud, SSH apps — and how spawnd makes your phone a console for real Claude Code sessions on your own machines.",
    datePublished: "2026-08-31",
    dateModified: "2026-08-31",
    hero: {
      plain: "Claude Code",
      accent: "on your phone",
      sub: "The agent runs on a computer; the question is what your phone is to it. Here are the honest routes — and the one where the phone becomes the console.",
    },
    intro: {
      heading: "What actually works today.",
      paragraphs: [
        "Claude Code is a CLI: it lives in a terminal on a computer, and no app makes that untrue. From a phone you have two honest routes. Anthropic’s own web flavor runs sessions in their cloud sandboxes, reachable from a browser or the mobile app — real Claude Code, but their environment: your repos arrive through GitHub, and the machine doing the work is theirs, not the dev box with your checkouts, your tools, and your local models.",
        "The other route is a terminal to your own machine: an SSH client like Blink or Termius, tmux or mosh underneath for survival, and the plumbing those inherit — a reachable host, keys on the phone, sessions that persist only where you remembered to arrange it. It works; people ship real fixes from train seats this way. It’s also more rigging than the job deserves.",
      ],
    },
    shape: {
      heading: "The phone as an approved console.",
      paragraphs: [
        "spawnd’s answer is to make the phone a first-class window onto sessions that live on your machines. The browser is the whole client — installable to the home screen as a web app, with a terminal built for the glass: a modifier bar for the keys phones don’t have, a virtual keyboard that doesn’t fight the viewport, touch scrolling that behaves.",
        "Approval replaces key ceremony: confirm a short code once and the phone can reach every machine you own; revoke it in one click and every host refuses it. Each session is end-to-end encrypted from the phone’s browser to that host’s own daemon — the server that introduces them never hears a word.",
      ],
    },
    grid: {
      src: "/product/phone/grid.png",
      alt: "The spawnd app on a phone: the spawn workspace with named tabs and live terminal tiles — a Claude Code session and a passing test suite — above the mobile modifier bar",
      caption:
        "The whole app, phone-sized: the same workspace, tabs, and live sessions you left on the desk.",
    },
    moments: {
      heading: "The loop, as it actually happens.",
      lead: "Nobody writes a module on a phone, and this page won’t pretend you will. The phone’s job is the loop — notice, read, answer — and these are real captures of it: a real session, a real prompt, a real diff.",
      vignettes: [
        {
          src: "/product/phone/permission.png",
          alt: "A Claude Code session on the phone showing a real diff and the prompt: Do you want to make this edit to utils.ts? — Yes highlighted, above the mobile keyboard bar",
          caption:
            "9pm, away from the desk: the agent wants to touch utils.ts. The diff is right there; Yes is one tap.",
        },
        {
          src: "/product/phone/done.png",
          alt: "The same session after approval: the JSDoc edit applied, Claude Code reporting done, with the next task already queued in the composer",
          caption: "Approved from the sofa. The edit lands, and the next task is already queued.",
        },
      ],
    },
    away: {
      heading: "The session never needed you to stay.",
      paragraphs: [
        "The work runs in a real login shell on your machine, owned by a worker process there — your login, your config, your subscription, untouched. The phone attaches and detaches; the walk to the train costs you nothing but the reconnect, and even a daemon restart keeps the session and its scrollback.",
        "When an agent stops to ask, the session raises its hand: the tile and the sidebar mark it, and alerts can reach the phone as system notifications. When you’re back at a desk, the same session is waiting in a bigger window — same scrollback, nothing to re-establish.",
      ],
    },
    faq: [
      {
        q: "Do I need to install an app on my phone?",
        a: "No. spawnd runs in the browser and installs to the home screen as a web app. The phone needs a browser; the machine running Claude Code needs the daemon.",
      },
      {
        q: "How is this different from Claude Code on the web?",
        a: "Anthropic’s web flavor runs sessions in their cloud sandboxes — genuinely useful, and no daemon to run. spawnd is for working on your own machines: your checkouts, your toolchain, your GPU, your long-lived sessions, reached end-to-end encrypted from the phone.",
      },
      {
        q: "What happens when my phone loses signal mid-session?",
        a: "Nothing. The session runs on your host, owned by a worker process there. When the phone reconnects it reattaches to the live session, scrollback intact.",
      },
      {
        q: "Does my Anthropic login or API key touch spawnd’s servers?",
        a: "Never. Claude Code authenticates itself on your machine, same as always. spawnd moves encrypted terminal bytes; it holds no provider credentials, and the server can’t read the session it introduces.",
      },
      {
        q: "Can I really answer permission prompts from the phone?",
        a: "That’s the loop the phone is best at: the prompt renders in the live session, the diff is readable on the glass, and a tap answers it — the same terminal your desk sees, not a notification stub.",
      },
    ],
    related: [
      {
        title: "Run agents in parallel",
        blurb: "the fleet the phone is a window onto",
        href: "/run-agents-in-parallel",
      },
      {
        title: "Keep agents running",
        blurb: "what happens when the laptop closes",
        href: "/use/keep-agents-running",
      },
      {
        title: "spawnd vs mobile SSH apps",
        blurb: "the client-app route, compared honestly",
        href: "/spawnd-vs-mobile-ssh-apps",
      },
      {
        title: "Claude Code",
        blurb: "the pillar page for the CLI itself",
        href: "/for/claude-code",
      },
    ],
    cardTitle: "Claude Code on your phone",
    cardBlurb: "The phone as an approved console for sessions on your machines.",
  },
];
