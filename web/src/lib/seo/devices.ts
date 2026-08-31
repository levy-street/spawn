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
      width: 1170,
      height: 2532,
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
          width: 1170,
          height: 2532,
          alt: "A Claude Code session on the phone showing a real diff and the prompt: Do you want to make this edit to utils.ts? — Yes highlighted, above the mobile keyboard bar",
          caption:
            "9pm, away from the desk: the agent wants to touch utils.ts. The diff is right there; Yes is one tap.",
        },
        {
          src: "/product/phone/done.png",
          width: 1170,
          height: 2532,
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
        title: "Coding agents on your phone",
        blurb: "the hub: every agent, every route, one pattern",
        href: "/coding-agents-on-your-phone",
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
  {
    slug: "codex-on-your-phone",
    title: "Codex on your phone",
    description:
      "Codex is a CLI on a computer — OpenAI’s cloud tasks are the exception that proves it. How spawnd makes your phone the console for Codex on your own machines.",
    datePublished: "2026-08-31",
    dateModified: "2026-08-31",
    hero: {
      plain: "Codex",
      accent: "on your phone",
      sub: "OpenAI’s CLI agent runs in a terminal on a computer. The honest phone routes — and the one where the phone is just the console for your own machines.",
    },
    intro: {
      heading: "The honest routes, first.",
      paragraphs: [
        "Codex is OpenAI’s coding agent for the terminal: signed in with your ChatGPT account, it reads, edits, and runs commands inside a sandbox on the machine it lives on — by default asking before it writes outside the workspace or touches the network. From a phone, OpenAI’s own answer is Codex’s cloud side: dispatch a task from chatgpt.com and it runs in their container against your GitHub repo. Real, useful — and their machine, not the dev box with your checkouts, your services, and your local state.",
        "The other route is the classic: an SSH client app to your own machine, keys on the phone, tmux underneath. It works, and for arbitrary servers it’s the right tool — but as a standing arrangement for your own fleet it’s more rigging than the job needs.",
      ],
    },
    shape: {
      heading: "Your machines, your Codex, your pocket.",
      paragraphs: [
        "Through spawnd, the codex session runs in a real login shell on your host — your ChatGPT sign-in, your config, your sandbox settings, untouched — and your phone attaches to it as an approved console. The browser is the whole client, installable to the home screen, with a terminal built for the glass.",
        "Approval replaces key ceremony: one short code admits the phone to every machine you own, one click revokes it everywhere. The session is end-to-end encrypted from the phone’s browser to that host’s own daemon; the server that introduces them never hears a word.",
      ],
    },
    grid: {
      src: "/product/phone/codex-grid.png",
      width: 1170,
      height: 2532,
      alt: "The spawnd app on a phone, server tab active: a live Codex session reporting ruff and pytest both passing, above the mobile modifier bar",
      caption:
        "The workspace, phone-sized: the server tab is Codex's — one tap away from the rest of the fleet.",
    },
    moments: {
      heading: "Dispatch, watch, read the verdict.",
      lead: "Real captures of a real Codex session on a phone: the suite dispatched from the couch, the checks streaming, and the verdict worth standing up for.",
      vignettes: [
        {
          src: "/product/phone/codex-working.png",
          width: 1170,
          height: 2532,
          alt: "A Codex session on the phone mid-task: ruff check passed, the pytest suite running, Working with esc to interrupt",
          caption: "Dispatched from the phone: ruff is already green, the suite is running.",
        },
        {
          src: "/product/phone/codex-done.png",
          width: 1170,
          height: 2532,
          alt: "The same Codex session reporting its verdict: Ruff PASS, Pytest PASS, full suite completed successfully",
          caption: "The verdict, read from the couch: both checks pass. Nothing needed the desk.",
        },
      ],
    },
    away: {
      heading: "The session outlives the pocket it started from.",
      paragraphs: [
        "Codex keeps working whether the phone stays connected or not: the session is owned by a worker process on the host, and it survives the dropped signal, the dead battery, even a restart of the daemon — scrollback intact. When Codex stops to ask about something outside its sandbox, the session raises its hand, and alerts can reach the phone as system notifications.",
        "Back at a desk, the same session is waiting in a bigger window. Nothing to re-establish, nothing to reattach by hand — the fleet is wherever your approved browser is.",
      ],
    },
    faq: [
      {
        q: "Does my ChatGPT sign-in touch spawnd’s servers?",
        a: "Never. Codex authenticates itself on your machine, exactly as it does at the desk. spawnd moves encrypted terminal bytes; it holds no provider credentials, and the server can’t read the sessions it introduces.",
      },
      {
        q: "How is this different from Codex’s own cloud tasks?",
        a: "OpenAI’s cloud runs the task in their container against your GitHub repo — no daemon needed, genuinely handy. spawnd is for Codex on your own machines: your checkouts, your services, your sandbox flags, in a session that persists and that you can watch live from anything you’ve approved.",
      },
      {
        q: "What about Codex’s approval prompts?",
        a: "They render in the live session like everything else, and a tap answers them. By default Codex asks before writing outside its workspace or touching the network — with the phone in your pocket, an approval is a glance, not a walk back to the desk.",
      },
      {
        q: "Can I run Claude Code and Codex side by side?",
        a: "That’s the natural shape: each agent in its own tile, often on different hosts, all in one grid. An agent in spawnd is a visible command in a real shell — nothing to integrate, nothing to conflict.",
      },
    ],
    related: [
      {
        title: "Coding agents on your phone",
        blurb: "the hub: every agent, every route, one pattern",
        href: "/coding-agents-on-your-phone",
      },
      {
        title: "Claude Code on your phone",
        blurb: "the same console, Anthropic’s agent",
        href: "/claude-code-on-your-phone",
      },
      {
        title: "Run agents in parallel",
        blurb: "the fleet the phone is a window onto",
        href: "/run-agents-in-parallel",
      },
      {
        title: "spawnd vs mobile SSH apps",
        blurb: "the client-app route, compared honestly",
        href: "/spawnd-vs-mobile-ssh-apps",
      },
    ],
    cardTitle: "Codex on your phone",
    cardBlurb: "Your machines, your Codex, your pocket.",
  },

  {
    slug: "code-on-an-ipad",
    title: "Code on an iPad",
    description:
      "The iPad’s screen and keyboard deserve better than a squeezed desktop. What actually works for coding on an iPad, and when it becomes a real console.",
    datePublished: "2026-08-31",
    dateModified: "2026-08-31",
    hero: {
      plain: "Code",
      accent: "on an iPad",
      sub: "The hardware has been ready for years — the screen, the keyboard, the battery. What’s been missing is a workload shaped for it. Agent sessions are that workload.",
    },
    intro: {
      heading: "The iPad coding story, honestly.",
      paragraphs: [
        "You can’t run Claude Code or Codex on iPadOS — there’s no local shell to run them in — so iPad coding has always meant reaching something else. The strong options are real: Blink is a superb SSH and mosh client with hardware-keyboard depth, and the cloud editors put a repo in a tab. Both inherit their plumbing — reachable hosts and key ceremony on one path, someone else’s machine on the other. (The same is true of an Android tablet; everything on this page applies there through the same browser.)",
        "What changed isn’t the iPad — it’s the work. Agent sessions don’t need a local toolchain; they need a live view, a readable diff, and an answer. That’s a workload the iPad’s glass is genuinely better at than a phone, and exactly as capable of as a laptop.",
      ],
    },
    shape: {
      heading: "A console with room to think.",
      paragraphs: [
        "spawnd in Safari — installable to the home screen — turns the iPad into the fleet’s best reading surface: the whole workspace grid at once in landscape, sessions from every machine side by side, each end-to-end encrypted to its own host’s daemon. With a keyboard attached it’s a working terminal; without one, it’s the console you read and answer from.",
        "Nothing is installed, nothing is provisioned, and the iPad holds no keys: it’s an approved device like any other — admitted once against a short code, revocable in one click from anywhere.",
      ],
    },
    grid: {
      src: "/product/tablet/ipad-landscape.png",
      width: 2388,
      height: 1668,
      alt: "spawnd on an iPad in landscape: the project sidebar, five named tabs, and four live terminal tiles — a Claude Code diff, a passing test suite, a dev server, and a live diffstat",
      caption:
        "Landscape is the desk away from the desk: the whole tab, four live sessions, one glance.",
    },
    moments: {
      heading: "Two ways to hold the fleet.",
      lead: "Real captures from the live app on an iPad viewport: the grid read like a page in portrait, and one session given the whole glass.",
      vignettes: [
        {
          src: "/product/tablet/ipad-portrait.png",
          width: 1668,
          height: 2388,
          alt: "spawnd on an iPad in portrait: stacked terminal tiles — a Claude Code session with an applied diff above a test runner and dev server",
          caption: "Portrait reads the fleet like a page — diffs above, suites below.",
        },
        {
          src: "/product/tablet/ipad-server.png",
          width: 2388,
          height: 1668,
          alt: "A single Codex session filling the iPad in landscape, reporting ruff and pytest both passing",
          caption: "Or one session gets the whole glass: Codex, and a suite worth reading.",
        },
      ],
    },
    away: {
      heading: "The sessions were never on the iPad.",
      paragraphs: [
        "Everything runs on your machines — the dev box, the home server, the GPU rig — owned by worker processes there. The iPad attaches and detaches; sleep it, lose the Wi-Fi, hand it to someone else’s couch, and the work continues with scrollback kept on the host.",
        "When an agent needs a yes, the tile and sidebar mark it, and alerts can reach you as notifications. The answer is one tap in the same live terminal your desk sees.",
      ],
    },
    faq: [
      {
        q: "Do I need an app from the App Store?",
        a: "No. spawnd runs in Safari and installs to the home screen as a web app. The iPad needs a browser; the machines running your agents need the daemon.",
      },
      {
        q: "Does a hardware keyboard work?",
        a: "Yes — the terminal is real, so a Magic Keyboard or any Bluetooth keyboard types into it like a desk terminal, modifier keys included. Without one, the on-screen keyboard plus the modifier bar covers the answer-and-steer loop.",
      },
      {
        q: "Can I use it in Split View next to something else?",
        a: "It’s a web app in Safari, so it participates in iPadOS multitasking like any site — the terminal reflows to the space it’s given.",
      },
      {
        q: "What about an Android tablet or a Chromebook?",
        a: "Same story through the same browser — the page for Chromebooks goes deeper on that shape. Any device you approve is the console.",
      },
    ],
    related: [
      {
        title: "Coding agents on your phone",
        blurb: "the hub for the whole device row",
        href: "/coding-agents-on-your-phone",
      },
      {
        title: "Code on a Chromebook",
        blurb: "the browser-first machine as a pure console",
        href: "/code-on-a-chromebook",
      },
      {
        title: "Run agents in parallel",
        blurb: "the fleet the iPad reads best",
        href: "/run-agents-in-parallel",
      },
      {
        title: "Keep agents running",
        blurb: "why the sessions never needed the iPad",
        href: "/use/keep-agents-running",
      },
    ],
    cardTitle: "Code on an iPad",
    cardBlurb: "The fleet’s best reading surface — with room to think.",
  },

  {
    slug: "code-on-a-chromebook",
    title: "Code on a Chromebook",
    description:
      "A Chromebook is a browser with a keyboard — which is exactly what a spawnd console needs. Honest local options first, then the fleet in a tab.",
    datePublished: "2026-08-31",
    dateModified: "2026-08-31",
    hero: {
      plain: "Code",
      accent: "on a Chromebook",
      sub: "The machine that’s only a browser stops being a compromise the moment the work lives on machines that aren’t.",
    },
    intro: {
      heading: "What a Chromebook can honestly do.",
      paragraphs: [
        "Chromebooks aren’t helpless: Crostini gives you a real Linux container, and on a strong machine you can install Node, Python, even run a coding agent locally. It works — within the machine’s RAM, storage, and the container’s seams. The other routes are the usual pair: SSH apps to a reachable host, or cloud editors on someone else’s machine.",
        "But the Chromebook’s honest identity is the clue: it’s a browser with a great keyboard and all-day battery. Asking it to be the workstation fights the design. Asking it to be the console embraces it.",
      ],
    },
    shape: {
      heading: "The browser is the whole client — which is the whole machine.",
      paragraphs: [
        "spawnd needs exactly what a Chromebook is: a modern browser. The full app — the workspace grid, every machine’s sessions, the same terminals your desk sees — runs in the tab, with nothing to install and nothing Crostini to maintain. The heavy machines do the work; the Chromebook holds the view.",
        "And the trust story fits the form factor: the Chromebook holds no keys and no code. It’s an approved device, nothing more — every session end-to-end encrypted from its browser to each host’s own daemon, revocable in one click the day the Chromebook walks away.",
      ],
    },
    grid: {
      src: "/product/tablet/chromebook-grid.png",
      width: 2560,
      height: 1600,
      alt: "spawnd filling a Chromebook screen: the project sidebar, five named tabs, a Claude Code session that just committed seven files, a shell, a dev server, a diffstat and the git log showing the commit",
      caption:
        "The whole fleet in the tab: an agent commits on one machine while the log tile catches it landing.",
    },
    moments: {
      heading: "Console work, full width.",
      lead: "Real captures at Chromebook resolution: one agent given the whole screen, and the trust guards that make a borrowed-grade machine safe to trust.",
      vignettes: [
        {
          src: "/product/tablet/chromebook-server.png",
          width: 2732,
          height: 1536,
          alt: "A single Codex session across the full Chromebook width, reporting ruff and pytest both passing",
          caption: "One session, full width: Codex delivers the suite’s verdict.",
        },
        {
          src: "/product/tablet/chromebook-security.png",
          width: 2560,
          height: 1600,
          alt: "A terminal on the security tab running spawnd's guard scripts: no-server-terminal-content, signed RTC, and worker-only daemon checks all passing",
          caption:
            "The guards, run live: the server never sees terminal content — checked by script, not promised by copy.",
        },
      ],
    },
    away: {
      heading: "Close the lid; nothing notices.",
      paragraphs: [
        "Sessions live on your machines, owned by worker processes there. The Chromebook sleeping, updating, or getting borrowed costs the fleet nothing — reopen the tab anywhere and the same sessions are waiting, scrollback intact.",
        "Attention still finds you: tiles and the sidebar mark a session that needs a yes, and alerts can reach whatever device you’re actually holding.",
      ],
    },
    faq: [
      {
        q: "Do I need Crostini or Linux mode?",
        a: "No. spawnd runs in the Chrome tab itself. Crostini stays useful for local tinkering, but the console needs nothing from it.",
      },
      {
        q: "Is a school or work Chromebook enough?",
        a: "If it can run a modern browser and reach the internet, it can be a console. Managed devices may block installs — spawnd doesn’t need one; the tab is the client.",
      },
      {
        q: "What happens if my Chromebook is lost or taken back?",
        a: "Revoke the device in one click and every host refuses it. It held no keys and no code — there’s nothing on it to rotate.",
      },
      {
        q: "Can the heavy work really happen elsewhere?",
        a: "That’s the design: agents run on the dev box, the home server, the GPU rig. The Chromebook renders kilobytes of encrypted terminal text — battery and RAM stay yours.",
      },
    ],
    related: [
      {
        title: "Coding agents on your phone",
        blurb: "the hub for the whole device row",
        href: "/coding-agents-on-your-phone",
      },
      {
        title: "Code on an iPad",
        blurb: "the other glass-first console",
        href: "/code-on-an-ipad",
      },
      {
        title: "Web terminal for a home server",
        blurb: "the machine on the other end of the tab",
        href: "/use/web-terminal-for-your-home-server",
      },
      {
        title: "spawnd vs self-hosted web terminals",
        blurb: "why the tab needs no listener behind it",
        href: "/spawnd-vs-self-hosted-web-terminals",
      },
    ],
    cardTitle: "Code on a Chromebook",
    cardBlurb: "A browser with a keyboard — exactly what the console needs.",
  },
];
