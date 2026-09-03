import type { ComparisonEntry } from "./types";

/*
 * Comparison pages (grimoire play 5). House rules: every ledger row is
 * checkable, the rival's strengths are stated plainly, and every page names
 * the cases where the other tool is the right choice.
 */

export const COMPARISONS: ComparisonEntry[] = [
  /*
   * Facts checked 2026-09-03 against:
   *   https://github.com/slopus/happy — README (tagline "Mobile and Web Client
   *   for Claude Code & Codex"; `npm install -g happy`; "How does it work?":
   *   the wrapper "restarts the session in remote mode", any keypress switches
   *   back; feature list incl. "End-to-end encrypted — Your code never leaves
   *   your devices unencrypted" and "Open source — No telemetry, no tracking";
   *   components: Desktop (macOS), App (web + Expo), CLI, Agent, Server; MIT);
   *   docs/encryption.md ("Keep the server blind to user content"; NaCl
   *   secretbox or AES-256-GCM); docs/paid-voice.md (free 20 min / 30 days,
   *   subscribed 5 h, BYO ElevenLabs agent); PRIVACY.md (metadata kept in the
   *   clear: message IDs, timestamps, device IDs, session IDs, push tokens;
   *   PostHog analytics with opt-out; voice "not covered by Happy's end-to-end
   *   encryption"); packages/happy-server-self-host/README.md (`happy server`,
   *   embedded PGlite, no Postgres/Redis/S3) ·
   *   https://github.com/slopus/happy-cli (archived 2026-02-14, merged into
   *   the monorepo; wraps claude, codex, gemini; QR pairing; `happy daemon`) ·
   *   https://apps.apple.com/us/app/happy-codex-claude-code-app/id6748571505
   *   (seller Bulka, LLC; free with an in-app monthly subscription at $19.99;
   *   iPhone, iPad, Apple-silicon Mac, Vision; "Access conversation history
   *   even when your terminal is offline"; voice free allowance then
   *   subscription; "same encryption as Signal (TweetNaCl)").
   *   Not verified: happy.engineering/docs pages are JS-rendered and returned
   *   titles only; the phone app has no terminal-emulator view that I could
   *   find (its "terminal" route is the pairing screen) — the page says
   *   "conversation view" and credits the macOS app with terminals, as its
   *   README does. Happy's hosted relay hostname is deliberately not stated.
   */
  {
    slug: "spawnd-vs-happy",
    name: "Happy",
    title: "spawnd vs Happy",
    description:
      "Happy puts Claude Code and Codex in a chat app on your phone, through an encrypted relay. spawnd puts the real terminal there, peer-to-peer. The honest comparison.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "spawnd vs",
      accent: "Happy",
      sub: "Two open-source answers to the same 9pm problem — the agent is asking, and you’re not at the desk. They differ on what travels, and on where the session lives.",
    },
    intro: {
      heading: "Happy is the nearest thing to a peer.",
      paragraphs: [
        "Happy (happy.engineering) is a mobile and web client for Claude Code and Codex — its CLI wraps Gemini CLI as well — released under MIT. You install the app on iOS or Android, run `npm install -g happy`, then start `happy claude` or `happy codex` instead of the bare command. A QR code pairs the phone; from then on the session shows up as a conversation on the phone, with push notifications when the agent needs a permission or hits an error, and one keypress on the computer to take control back.",
        "What it does well, it does genuinely well. The native apps are quick and feel native; a conversation view is a better shape than a terminal for reading an agent’s reasoning on a five-inch screen; voice is built in, so you can talk a request at Claude Code from a walk; and conversation history is readable on the phone even when the computer is off. The relay server is open source and self-hostable with one command, and the code that encrypts everything before it leaves your machine is there to audit. If your question is “can I approve Claude Code’s diff from the sofa?”, Happy answers it today.",
      ],
    },
    framing: {
      heading: "The difference is what travels, and where the session lives.",
      paragraphs: [
        "Happy’s architecture is a wrapper and a relay. The `happy` command starts the agent through Happy’s own runner; when you take control from the phone it restarts the session in remote mode, and everything the app shows is a stream of encrypted blobs the phone decrypts and renders as chat. Those blobs travel through Happy’s server — hosted or yours — on every message, and the server stores them, which is how history survives the computer being off. By design the server is blind to content; what it keeps in the clear, per Happy’s privacy policy, is metadata: message IDs, timestamps, device and session IDs, push tokens. Voice, which goes to ElevenLabs, sits outside that encryption boundary.",
        "spawnd’s architecture is a daemon and a terminal. One daemon on each host you own dials out; a worker process on the host owns each session’s PTY, so the session survives the closed tab, the dropped connection, the laptop lid, and a daemon restart, scrollback intact. What reaches your phone is the real terminal — your browser talks to each daemon peer-to-peer, end-to-end encrypted; when a relay is unavoidable it forwards ciphertext it cannot decrypt, and the server that introduces them never sees session content. Sessions live on the host. And because the unit is a shell rather than a message stream, any CLI is an agent — Claude Code, Codex, OpenCode and Aider are built-in shortcuts, anything else is a named command — and several hosts sit side by side in one workspace grid.",
      ],
    },
    ledger: {
      heading: "Row by row.",
      rows: [
        {
          label: "What the phone shows",
          spawnd: "The real terminal — the same PTY the host is running",
          other: "A conversation view: messages, tool calls, permission prompts",
        },
        {
          label: "Agents",
          spawnd: "Any CLI; Claude Code, Codex, OpenCode, Aider built in",
          other: "Claude Code and Codex; Gemini CLI through the wrapper",
        },
        {
          label: "The path",
          spawnd:
            "Browser to daemon peer-to-peer, E2E; a relay only when unavoidable, ciphertext only",
          other: "Every message through Happy’s relay as encrypted blobs, hosted or self-hosted",
        },
        {
          label: "Where the session lives",
          spawnd: "On the host: a worker owns the PTY; survives tab, lid, daemon restart",
          other:
            "In the wrapper, restarted in remote mode; history stored encrypted on the relay, readable while the computer is off",
        },
        {
          label: "What the middle sees",
          spawnd: "Ciphertext, when a relay is used at all; the introducer never sees content",
          other:
            "Ciphertext plus metadata: message IDs, timestamps, device and session IDs, push tokens",
        },
        {
          label: "On the phone",
          spawnd: "Installable web app; no client app, no keys on the device",
          other: "Native iOS and Android apps, a macOS app, a web app",
        },
        {
          label: "Voice",
          spawnd: "None",
          other:
            "Built in via ElevenLabs: a free allowance, then a subscription; outside the E2E boundary",
        },
        {
          label: "Cost and provenance",
          spawnd: "Open source, MIT/Apache-2.0",
          other: "Open source, MIT; free app, optional voice subscription; self-hostable server",
        },
      ],
    },
    verdict: {
      heading: "Happy is the better chat. spawnd is the terminal.",
      paragraphs: [
        "If what you want is to read Claude Code’s reasoning and tap approve from a native app, with voice, on a phone that never needs to see a shell, Happy is the more comfortable product and there is no shame in choosing it. Its encryption is real, its relay is yours if you want it to be, and a conversation is the right shape for a thumb.",
        "spawnd is for the person who wants the terminal itself — because the agent is OpenCode or Aider or a script Happy doesn’t wrap, because the session must outlive everything including the wrapper that started it, because three machines belong in one view, or because the only acceptable middle is one that never sees the session at all. It gives up the native app and the voice. It keeps the shell.",
      ],
      choose: {
        spawnd: [
          "The agent is any CLI, not only Claude Code or Codex",
          "You want the real terminal, scrollback and all, on the phone",
          "Several hosts belong in one grid",
          "Session content should live on the host, not on a relay",
        ],
        other: {
          title: "Choose Happy when",
          items: [
            "A chat view is what you want on a small screen",
            "Voice control matters",
            "History must be readable while the computer is off",
            "You want a native app from the store",
          ],
        },
      },
    },
    faq: [
      {
        q: "Is Happy really end-to-end encrypted?",
        a: "Yes, by its published design: content is encrypted on your devices with NaCl secretbox or AES-256-GCM before it reaches the relay, and the relay stores what it cannot read. The parts outside that boundary — metadata, and the voice feature — are set out in Happy’s own privacy policy.",
      },
      {
        q: "Can I run Happy and spawnd on the same machine?",
        a: "Yes. Happy wraps the agent command; spawnd gives you a persistent shell on the host. Start `happy claude` inside a spawnd session and you get both: the chat in Happy’s app, the terminal in your browser.",
      },
      {
        q: "Does spawnd have a native app or voice?",
        a: "No. The console is your browser, installed to the home screen as a web app, and there is no voice feature. If those matter more than the terminal, Happy is the honest recommendation.",
      },
    ],
    related: [
      {
        title: "Claude Code, remote",
        blurb: "Remote Control, the web, and SSH + tmux — then the machines they leave out.",
        href: "/claude-code-remote",
      },
      {
        title: "Termius alternatives",
        blurb: "Eight clients ranked honestly, and the route that needs no client at all.",
        href: "/termius-alternatives",
      },
      {
        title: "SSH from an iPhone",
        blurb:
          "The client, the key, the reachability, the tmux — and the route with no client at all.",
        href: "/ssh-from-iphone",
      },
    ],
    cardTitle: "spawnd vs Happy",
    cardBlurb: "A chat app through an encrypted relay, versus the real terminal, peer-to-peer.",
  },
];
