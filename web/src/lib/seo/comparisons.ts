import type { SeoPage } from "./types";

/*
 * Comparison pages. House rule: every row is checkable, the alternative’s
 * strengths are stated plainly, and each page ends by naming the cases where
 * the other tool is the right choice. Credibility is the ranking strategy.
 */

export const COMPARISONS: SeoPage[] = [
  {
    family: "vs",
    slug: "ssh-and-tmux",
    title: "spawnd vs SSH + tmux",
    description:
      "SSH + tmux is the classic for persistent remote terminals. Here’s what changes when the sessions live behind a browser, zero open ports, and one approval per device.",
    eyebrow: "Compared",
    h1: { plain: "spawnd vs", accent: "SSH + tmux." },
    lede: "SSH plus tmux is the venerable answer, and it still works: expose a port, distribute keys, remember to attach. spawnd keeps the idea — sessions that outlive connections — and rebuilds everything around it: no listener on the host, no key ceremony per device, and a terminal that’s as real on a phone as at a desk.",
    sections: [
      {
        kind: "table",
        eyebrow: "The ledger",
        heading: { plain: "Row by row." },
        columns: ["spawnd", "SSH + tmux"],
        rows: [
          {
            label: "Network exposure",
            a: "None — the daemon dials out",
            b: "sshd listens; a port, VPN, or bastion faces the network",
          },
          {
            label: "Session persistence",
            a: "Every session, by default; survives daemon restarts",
            b: "Only inside tmux, when you remembered to start it",
          },
          {
            label: "New device",
            a: "Sign in, approve once against a short code",
            b: "Generate and distribute a key; repeat per host",
          },
          {
            label: "From a phone",
            a: "Installable web app with a touch-real terminal",
            b: "A third-party SSH app, small type, and patience",
          },
          {
            label: "Revoking a device",
            a: "One click; every host refuses it",
            b: "Edit authorized_keys on every machine it knew",
          },
          {
            label: "Encryption",
            a: "End-to-end, browser to daemon; relay sees ciphertext",
            b: "End-to-end, client to sshd — genuinely equivalent here",
          },
          {
            label: "Cost and provenance",
            a: "Open source, MIT/Apache-2.0",
            b: "Open source, decades of scrutiny — the gold standard",
          },
        ],
      },
      {
        kind: "prose",
        eyebrow: "The honest verdict",
        heading: { plain: "When SSH + tmux is still right." },
        paragraphs: [
          "If your machines share a LAN or a VPN you already trust, your keys are managed, and your fingers speak tmux — keep it. There is nothing wrong with the classic, and spawnd’s encryption story is a peer of SSH’s, not an improvement on it.",
          "spawnd earns the switch at the edges the classic never covered: machines you’d rather not expose to anything, devices you’d rather not provision keys onto, phones, and the agent era’s long unattended runs — where “did I start this inside tmux?” is a question with an expensive wrong answer. Sessions here are detachable by construction, not by discipline.",
        ],
      },
      {
        kind: "split",
        eyebrow: "Choose by situation",
        heading: { plain: "Two right answers." },
        left: {
          title: "Choose spawnd when",
          tone: "bone",
          items: [
            "Hosts must present zero inbound surface",
            "You reach machines from browsers and phones",
            "Long agent runs must survive your absence, always",
            "Devices come and go and revocation must be instant",
          ],
        },
        right: {
          title: "Stay with SSH + tmux when",
          tone: "ash",
          items: [
            "Everything lives on one trusted network",
            "Your workflow is already scripted around ssh",
            "You need SCP/SFTP-style tooling everywhere today",
            "Zero new daemons is a hard requirement",
          ],
        },
      },
    ],
    faq: [
      {
        q: "Is spawnd’s encryption weaker than SSH’s?",
        a: "No — it’s the same end-to-end property by different means: encrypted channels negotiated directly between browser and daemon, with pinned endpoint keys. When a relay is unavoidable it forwards ciphertext it cannot decrypt.",
      },
      {
        q: "Can I keep using SSH alongside spawnd?",
        a: "Of course. The daemon adds an outbound path; it removes nothing. Many hosts run both while the port forward earns its retirement.",
      },
      {
        q: "Does spawnd replace tmux’s window management?",
        a: "It replaces the persistence, and its workspaces give you a grid of sessions across hosts. If you love tmux’s in-terminal multiplexing itself, you can still run tmux inside a spawnd session.",
      },
    ],
    related: [
      "use/remote-access-without-open-ports",
      "use/keep-agents-running",
      "vs/tailscale-ssh",
    ],
    cardTitle: "vs SSH + tmux",
    cardBlurb: "The classic, versus persistence and reach without a listener.",
  },

  {
    family: "vs",
    slug: "vscode-remote-tunnels",
    title: "spawnd vs VS Code Remote Tunnels",
    description:
      "VS Code tunnels remote an editor; spawnd remotes terminals. Where the trust boundaries differ, where each shines, and why agent workflows changed the question.",
    eyebrow: "Compared",
    h1: { plain: "spawnd vs", accent: "VS Code tunnels." },
    lede: "Remote Tunnels are excellent at their actual job: putting VS Code in front of a distant machine. spawnd’s job is different — terminals, many of them, across machines, from any browser including a phone’s, with the introducing server locked out of the content. The overlap is smaller than it looks.",
    sections: [
      {
        kind: "table",
        eyebrow: "The ledger",
        heading: { plain: "Different jobs, measured anyway." },
        columns: ["spawnd", "VS Code Remote Tunnels"],
        rows: [
          {
            label: "Centre of gravity",
            a: "The terminal: sessions, agents, shells",
            b: "The editor: files, extensions, debugging",
          },
          {
            label: "Trust path",
            a: "E2E-encrypted browser↔daemon; the introducer can’t read sessions and it’s open source — verify it",
            b: "Tunnels traverse Microsoft’s service under your GitHub/Microsoft account; you trust the operator",
          },
          {
            label: "From a phone",
            a: "A terminal built for touch and the virtual keyboard",
            b: "vscode.dev on mobile — workable, editor-shaped",
          },
          {
            label: "Session persistence",
            a: "Sessions live on the host and reattach with scrollback",
            b: "The tunnel persists; your terminal panes are the editor’s to keep",
          },
          {
            label: "Many machines",
            a: "A sidebar of hosts; sessions from several in one grid",
            b: "One window per tunnelled machine",
          },
          {
            label: "Account & licensing",
            a: "Your spawnd account; stack is MIT/Apache-2.0",
            b: "GitHub/Microsoft sign-in; client is free, service is Microsoft’s",
          },
        ],
      },
      {
        kind: "prose",
        eyebrow: "The honest verdict",
        heading: { plain: "Editor work is theirs. Terminal work is ours." },
        paragraphs: [
          "If what you miss is VS Code itself — the debugger, the extensions, the file tree — use Remote Tunnels; that’s the product, and it’s good. spawnd doesn’t remote an editor and won’t pretend a terminal is one.",
          "But agent-era work moved the centre: what needs remoting now is often not the editor but the long-running CLI beside it — Claude Code grinding through a refactor, a test loop, a build. Those want a session that persists on the host, reattaches from anything, and answers from a phone. That’s the job spawnd was shaped for, with a trust model you can audit rather than accept.",
        ],
      },
    ],
    faq: [
      {
        q: "Can Microsoft’s service read what goes through a tunnel?",
        a: "Tunnel traffic flows through Microsoft’s infrastructure under your account; the operator’s own documentation governs what’s protected and how. spawnd’s design goal is stronger and checkable: terminal content is end-to-end encrypted past the introducer, and the code proving it is open.",
      },
      {
        q: "Can I use both?",
        a: "Yes, and it’s a sensible split: tunnels for editor sessions, spawnd for the terminals and agents that must outlive them. They don’t conflict on the host.",
      },
      {
        q: "Does spawnd have file editing?",
        a: "spawnd is terminal-first. You get real shells — so vim, helix, and every TUI editor work — plus file transfer, but it is not a graphical IDE and doesn’t aim to be.",
      },
    ],
    related: ["vs/coder", "use/keep-agents-running", "use/claude-code-on-your-phone"],
    cardTitle: "vs VS Code Tunnels",
    cardBlurb: "Editor remoting versus terminal possession — a smaller overlap than it looks.",
  },

  {
    family: "vs",
    slug: "tmate",
    title: "spawnd vs tmate",
    description:
      "tmate shares a terminal instantly; spawnd runs your fleet’s terminals permanently. Different jobs — here is the boundary, drawn honestly.",
    eyebrow: "Compared",
    h1: { plain: "spawnd vs", accent: "tmate." },
    lede: "tmate is tmux with an instant-sharing superpower: one command, a link, and a colleague is in your session. It’s built for the moment. spawnd is built for the standing arrangement — your machines, your devices, encrypted access that persists past the emergency.",
    sections: [
      {
        kind: "table",
        eyebrow: "The ledger",
        heading: { plain: "The moment versus the arrangement." },
        columns: ["spawnd", "tmate"],
        rows: [
          {
            label: "Built for",
            a: "Standing access to machines you own",
            b: "Sharing one session, right now, with someone else",
          },
          {
            label: "Who connects",
            a: "Your devices, each explicitly approved and revocable",
            b: "Whoever holds the session string while it lives",
          },
          {
            label: "Relay’s view",
            a: "Ciphertext only; content is E2E-encrypted past it",
            b: "The tmate server terminates SSH — it is a party to the session unless you self-host it",
          },
          {
            label: "Lifetime",
            a: "Sessions persist on the host until you end them",
            b: "The share dies with the tmate process",
          },
          {
            label: "From a phone",
            a: "First-class touch terminal",
            b: "Whatever SSH client the invitee has",
          },
          {
            label: "Provenance",
            a: "Open source, MIT/Apache-2.0",
            b: "Open source, self-hostable relay",
          },
        ],
      },
      {
        kind: "prose",
        eyebrow: "The honest verdict",
        heading: { plain: "Keep tmate for the fire drill." },
        paragraphs: [
          "Pair-debugging a colleague’s broken box you’ll never touch again? tmate’s one-liner is unbeatable, and nothing here replaces it. It made ephemeral sharing effortless and deserves its reputation.",
          "The mistake is using an ephemeral sharing tool as your permanent access path — a session string as authentication, a content-terminating relay as infrastructure. For the machines you return to every day, spawnd gives you named, approved, revocable devices and encryption the relay can’t look through. The fire drill and the front door are different problems.",
        ],
      },
    ],
    faq: [
      {
        q: "Can spawnd share a session with someone else, like tmate does?",
        a: "spawnd’s model is devices you approve on your account, not anonymous invite links — deliberate, for standing access. For one-off pairing with a stranger’s machine, tmate remains the right tool.",
      },
      {
        q: "Does the tmate relay really see session content?",
        a: "tmate’s architecture terminates the SSH connection at its server, which is why its own documentation offers self-hosting for the privacy-conscious. spawnd’s relay, by contrast, only ever forwards ciphertext — even our hosted one.",
      },
      {
        q: "Can multiple of my devices watch the same spawnd session?",
        a: "Yes — any device you’ve approved can attach to the same live session; they all see the same terminal and scrollback.",
      },
    ],
    related: [
      "vs/ssh-and-tmux",
      "use/remote-access-without-open-ports",
      "use/web-terminal-for-your-home-server",
    ],
    cardTitle: "vs tmate",
    cardBlurb: "Instant sharing versus standing possession — different problems.",
  },

  {
    family: "vs",
    slug: "coder",
    title: "spawnd vs Coder and code-server",
    description:
      "Coder provisions cloud dev environments; code-server puts VS Code in a browser tab. spawnd possesses the machines you already have. Which fits, and when.",
    eyebrow: "Compared",
    h1: { plain: "spawnd vs", accent: "Coder & code-server." },
    lede: "Coder answers “give every engineer a fresh, standard dev environment” — provisioned workspaces, templates, a platform to operate. code-server answers “put VS Code on that one box’s browser”. spawnd answers a third question: the machines already exist, you own them, and you want their terminals from anywhere without exposing or operating anything.",
    sections: [
      {
        kind: "table",
        eyebrow: "The ledger",
        heading: { plain: "Three tools, one table." },
        columns: ["spawnd", "Coder / code-server"],
        rows: [
          {
            label: "The unit",
            a: "A machine you already own, possessed by a daemon",
            b: "Coder: a provisioned workspace. code-server: an editor served off one host",
          },
          {
            label: "Operations burden",
            a: "One daemon per host; hosted or self-hosted control plane",
            b: "Coder: a platform to deploy and run. code-server: your own TLS, auth, and exposure",
          },
          {
            label: "Network model",
            a: "Outbound-only daemons; nothing listens",
            b: "Something serves HTTP(S) and must be reachable and guarded",
          },
          {
            label: "Interface",
            a: "Terminals — sessions, agents, workspace grids",
            b: "VS Code in the browser; terminals as editor panes",
          },
          {
            label: "Content visibility",
            a: "E2E-encrypted browser↔daemon; introducer reads nothing",
            b: "Your deployment terminates TLS; visibility is yours to architect",
          },
          {
            label: "Best at",
            a: "Standing terminal access to your own fleet",
            b: "Coder: team-standard environments. code-server: an editor on a headless box",
          },
        ],
      },
      {
        kind: "prose",
        eyebrow: "The honest verdict",
        heading: { plain: "Provisioning is a real job — when you have it." },
        paragraphs: [
          "If you run a team that needs reproducible environments stamped out from templates, with central control over images and resources, Coder is built for exactly that and spawnd is not a substitute. If what you want is VS Code itself in a tab on one machine you’re happy to expose properly, code-server does it.",
          "spawnd is for the other shape of life, common to individuals and small teams: a handful of real machines — the dev box, the home server, the GPU rig — that need no provisioning because they already exist, and whose terminals you want in your pocket without standing up a platform or a reverse proxy. One daemon each, one approval per device, nothing to operate.",
        ],
      },
    ],
    faq: [
      {
        q: "Is spawnd a dev-environment platform?",
        a: "No. It provisions nothing and standardises nothing — it gives you encrypted terminals on machines that already exist. That narrowness is the point.",
      },
      {
        q: "Can spawnd work for a team?",
        a: "spawnd is built around personal ownership: your account, your machines, your approved devices. Shared-fleet and team stories are deliberately not the current product.",
      },
      {
        q: "Do I need to put a reverse proxy or TLS in front of spawnd?",
        a: "No. Daemons dial out; browsers connect to the control plane. There is nothing of yours to expose, certificate, or harden — the usual code-server homework disappears.",
      },
    ],
    related: [
      "use/ai-agents-on-your-own-gpu",
      "vs/vscode-remote-tunnels",
      "use/web-terminal-for-your-home-server",
    ],
    cardTitle: "vs Coder & code-server",
    cardBlurb: "Provisioned workspaces versus machines you already own.",
  },

  {
    family: "vs",
    slug: "tailscale-ssh",
    title: "spawnd vs Tailscale SSH",
    description:
      "Tailscale builds you a private network; spawnd hands you terminals. Where the two overlap, where they don’t, and why many people run both.",
    eyebrow: "Compared",
    h1: { plain: "spawnd vs", accent: "Tailscale SSH." },
    lede: "Tailscale is a superb answer to “my devices should share a network”, and Tailscale SSH rides that network to kill key management. spawnd never builds a network at all: it delivers exactly one thing — terminals on your machines, from any approved browser — and encrypts them past its own introducer. Narrower, and for terminal work, more complete.",
    sections: [
      {
        kind: "table",
        eyebrow: "The ledger",
        heading: { plain: "A network versus a channel." },
        columns: ["spawnd", "Tailscale SSH"],
        rows: [
          {
            label: "What you get",
            a: "Terminals, as a product: sessions, agents, grids",
            b: "A mesh network; SSH is one thing you do over it",
          },
          {
            label: "Blast radius of access",
            a: "A terminal on the host — nothing else is reachable",
            b: "The device joins your tailnet; ACLs scope what it reaches",
          },
          {
            label: "Client requirement",
            a: "Any modern browser; installable as a web app",
            b: "Tailscale on every device, plus an SSH client",
          },
          {
            label: "From a phone",
            a: "First-class touch terminal, no extra apps",
            b: "Tailscale app + a terminal app, working in tandem",
          },
          {
            label: "Session persistence",
            a: "Built in; survives disconnects and daemon restarts",
            b: "Not SSH’s job — bring tmux, same as ever",
          },
          {
            label: "Coordination trust",
            a: "E2E encryption past the introducer; pinned endpoint keys; open source",
            b: "Coordination server distributes keys; tailnet lock exists to check it; clients open source, control plane not",
          },
        ],
      },
      {
        kind: "prose",
        eyebrow: "The honest verdict",
        heading: { plain: "If you need a network, use the network." },
        paragraphs: [
          "Tailscale solves problems spawnd doesn’t touch: reaching a NAS’s web UI, printing to the office, any TCP service on any machine. If your need is “my devices, one private network”, install Tailscale and don’t look back — it’s the best of its kind, and its SSH mode genuinely does end key sprawl within it.",
          "But if the need is specifically terminals — especially agent sessions that must persist, reattach from a phone, and stay unreadable to every intermediary — a network is the long way round. spawnd skips the tailnet, the per-device clients, and the tmux discipline, and its trust claim is narrower and checkable: not “the coordinator is trustworthy”, but “the coordinator is deaf”. Plenty of people run both: Tailscale for the network, spawnd for the terminals.",
        ],
      },
    ],
    faq: [
      {
        q: "Can I run spawnd over Tailscale?",
        a: "Yes — the daemon just makes outbound connections, which a tailnet carries fine. They’re orthogonal layers; neither needs the other.",
      },
      {
        q: "Doesn’t Tailscale also avoid open ports?",
        a: "Within the tailnet, yes — WireGuard tunnels are established without inbound exposure. The difference is scope: joining a tailnet grants network reachability governed by ACLs; approving a spawnd device grants terminals, and nothing else exists to reach.",
      },
      {
        q: "Is spawnd’s trust model actually different from Tailscale’s?",
        a: "Both pin keys at the endpoints and both offer a check against a tampering coordinator — tailnet lock there, pinned endpoint identities here. The structural difference: spawnd’s coordinator never carries decryptable session content in the first place, and every layer of spawnd is open to inspection.",
      },
    ],
    related: [
      "use/remote-access-without-open-ports",
      "vs/ssh-and-tmux",
      "use/claude-code-on-your-phone",
    ],
    cardTitle: "vs Tailscale SSH",
    cardBlurb: "A private network versus a deaf channel — and why some run both.",
  },
];
