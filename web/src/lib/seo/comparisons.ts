import type { ComparisonEntry } from "./flat-types";

/*
 * Comparison pages, flat-slug edition (docs/SEO_TREE.md, comparison
 * template). House rules unchanged from the first generation: every ledger
 * row is checkable, the alternative's strengths are stated plainly, and
 * every page names the cases where the other tool is the right choice.
 * Credibility is the ranking strategy. Each entry opens teach-first — what
 * the incumbent actually is and what it's honestly good at — before spawnd
 * enters where the incumbent's job ends.
 */

export const COMPARISONS: ComparisonEntry[] = [
  {
    slug: "spawnd-vs-ssh-and-tmux",
    name: "SSH + tmux",
    title: "spawnd vs SSH + tmux",
    description:
      "SSH + tmux is the classic for persistent remote terminals. Here’s what changes when the sessions live behind a browser, zero open ports, and one approval per device.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "SSH + tmux",
      sub: "The venerable pair, taken seriously — what it already does well, where it genuinely runs out, and what changes when persistence stops being a discipline.",
    },
    intro: {
      heading: "The classic earned its place.",
      paragraphs: [
        "SSH plus tmux is the oldest answer to remote terminal work, and it still works: expose a port or ride a VPN, distribute keys, and remember to start tmux before anything that matters. sshd’s encryption has decades of scrutiny behind it; tmux detaches and reattaches sessions with complete reliability once you’re inside it. If your machines share a network you trust and your fingers already speak the prefix key, nothing here says you’re doing it wrong.",
        "The pattern’s costs are real but familiar: something must listen on the network, every new device means another key to generate and distribute, revoking one means editing authorized_keys on every host that knew it, and persistence only covers what you remembered to run inside tmux. On a phone, the whole arrangement leans on a third-party SSH app and patience.",
      ],
    },
    framing: {
      heading: "spawnd keeps the idea and inverts the mechanics.",
      paragraphs: [
        "Sessions that outlive connections — that’s the idea worth keeping, and spawnd makes it structural instead of disciplined. Every session’s PTY is owned by a worker process on the host, so it survives the closed tab, the dropped connection, and a restart of the daemon itself, scrollback intact. There is no “did I start this inside tmux?” — there is no wrong way to start a session.",
        "The network model inverts too: the daemon dials out, so nothing on your host listens. A new device signs in and gets approved once against a short code; revoking it is one click that every host honors. The terminal in the browser is the same terminal on the phone — end-to-end encrypted from your browser to each host’s own daemon, with the server that introduces them locked out of the content.",
      ],
    },
    ledger: {
      heading: "Row by row.",
      rows: [
        {
          label: "Network exposure",
          spawnd: "None — the daemon dials out",
          other: "sshd listens; a port, VPN, or bastion faces the network",
        },
        {
          label: "Session persistence",
          spawnd: "Every session, by default; survives daemon restarts",
          other: "Only inside tmux, when you remembered to start it",
        },
        {
          label: "New device",
          spawnd: "Sign in, approve once against a short code",
          other: "Generate and distribute a key; repeat per host",
        },
        {
          label: "From a phone",
          spawnd: "Installable web app with a touch-real terminal",
          other: "A third-party SSH app, small type, and patience",
        },
        {
          label: "Revoking a device",
          spawnd: "One click; every host refuses it",
          other: "Edit authorized_keys on every machine it knew",
        },
        {
          label: "Encryption",
          spawnd: "End-to-end, browser to daemon; relay sees ciphertext",
          other: "End-to-end, client to sshd — genuinely equivalent here",
        },
        {
          label: "Cost and provenance",
          spawnd: "Open source, MIT/Apache-2.0",
          other: "Open source, decades of scrutiny — the gold standard",
        },
      ],
    },
    capture: {
      caption:
        "What replaces the wall of tmux panes: workspaces per project in the sidebar, sessions from three machines in one grid, every one persistent by construction.",
    },
    verdict: {
      heading: "When SSH + tmux is still right.",
      paragraphs: [
        "If your machines share a LAN or a VPN you already trust, your keys are managed, and your fingers speak tmux — keep it. There is nothing wrong with the classic, and spawnd’s encryption story is a peer of SSH’s, not an improvement on it.",
        "spawnd earns the switch at the edges the classic never covered: machines you’d rather not expose to anything, devices you’d rather not provision keys onto, phones, and the agent era’s long unattended runs — where “did I start this inside tmux?” is a question with an expensive wrong answer. Sessions here are detachable by construction, not by discipline.",
      ],
      choose: {
        spawnd: [
          "Hosts must present zero inbound surface",
          "You reach machines from browsers and phones",
          "Long agent runs must survive your absence, always",
          "Devices come and go and revocation must be instant",
        ],
        other: {
          title: "Stay with SSH + tmux when",
          items: [
            "Everything lives on one trusted network",
            "Your workflow is already scripted around ssh",
            "You need SCP/SFTP-style tooling everywhere today",
            "Zero new daemons is a hard requirement",
          ],
        },
      },
    },
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
      {
        title: "spawnd vs Tailscale SSH",
        blurb: "a private network versus a deaf channel — and why some run both",
        href: "/spawnd-vs-tailscale-ssh",
      },
      {
        title: "Run agents in parallel",
        blurb: "the management problem the grid was shaped for",
        href: "/run-agents-in-parallel",
      },
      {
        title: "Keep agents running",
        blurb: "what happens to sessions when the laptop closes",
        href: "/use/keep-agents-running",
      },
      {
        title: "No open ports",
        blurb: "the outbound-only network model, in full",
        href: "/use/remote-access-without-open-ports",
      },
    ],
    cardTitle: "vs SSH + tmux",
    cardBlurb: "The classic, versus persistence and reach without a listener.",
  },

  {
    slug: "spawnd-vs-vscode-remote-tunnels",
    name: "VS Code Remote Tunnels",
    title: "spawnd vs VS Code Remote Tunnels",
    description:
      "VS Code tunnels remote an editor; spawnd remotes terminals. Where the trust boundaries differ, where each shines, and why agent workflows changed the question.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "VS Code Remote Tunnels",
      sub: "An editor in front of a distant machine versus terminals across all of them — the overlap is smaller than it looks, and the agent era moved the center.",
    },
    intro: {
      heading: "Remote Tunnels are excellent at their actual job.",
      paragraphs: [
        "The job is putting VS Code in front of a distant machine: run the tunnel on the host, sign in with a GitHub or Microsoft account, and the full editor — debugger, extensions, file tree — appears in a local window or at vscode.dev. For editor work on a remote box it’s hard to beat, and the setup is genuinely painless.",
        "The shape of the trust is worth seeing plainly: tunnel traffic traverses Microsoft’s service under your account. That’s not a scandal — it’s the design — but it means the operator is a party to the arrangement, and what’s protected is governed by their documentation rather than by anything you can verify.",
      ],
    },
    framing: {
      heading: "What needs remoting changed.",
      paragraphs: [
        "Agent-era work moved the center of gravity: what needs reaching now is often not the editor but the long-running CLI beside it — Claude Code grinding through a refactor, a test loop, a build that finishes at 2am. Those want a session that persists on the host, reattaches from anything, and answers from a phone with one keystroke.",
        "That’s the job spawnd is shaped for. Sessions, many of them, across machines, in one grid — with a trust model you can audit rather than accept: your browser talks to each daemon peer-to-peer, end-to-end encrypted, and the server that introduces them never hears a word.",
      ],
    },
    ledger: {
      heading: "Different jobs, measured anyway.",
      rows: [
        {
          label: "Centre of gravity",
          spawnd: "The terminal: sessions, agents, shells",
          other: "The editor: files, extensions, debugging",
        },
        {
          label: "Trust path",
          spawnd:
            "E2E-encrypted browser↔daemon; the introducer can’t read sessions, and it’s open source",
          other: "Tunnels traverse Microsoft’s service under your account; you trust the operator",
        },
        {
          label: "From a phone",
          spawnd: "A terminal built for touch and the virtual keyboard",
          other: "vscode.dev on mobile — workable, editor-shaped",
        },
        {
          label: "Session persistence",
          spawnd: "Sessions live on the host and reattach with scrollback",
          other: "The tunnel persists; terminal panes are the editor’s to keep",
        },
        {
          label: "Many machines",
          spawnd: "A sidebar of hosts; sessions from several in one grid",
          other: "One window per tunnelled machine",
        },
        {
          label: "Account & licensing",
          spawnd: "Your spawnd account; stack is MIT/Apache-2.0",
          other: "GitHub/Microsoft sign-in; client free, service is Microsoft’s",
        },
      ],
    },
    capture: {
      caption:
        "The terminal-first shape: agent sessions across three machines in one grid, each tile its own encrypted channel to its own host.",
    },
    verdict: {
      heading: "Editor work is theirs. Terminal work is ours.",
      paragraphs: [
        "If what you miss is VS Code itself — the debugger, the extensions, the file tree — use Remote Tunnels; that’s the product, and it’s good. spawnd doesn’t remote an editor and won’t pretend a terminal is one.",
        "If what you miss is the terminal — the agent mid-refactor, the test loop, the shell on the GPU rig — that’s spawnd’s whole product, built around persistence, phones, and a coordinator that carries only ciphertext. Plenty of people run both and split the work along exactly that line.",
      ],
      choose: {
        spawnd: [
          "The thing to reach is a long-running CLI, not an editor",
          "Sessions must survive the tab, the network, the day",
          "You answer agents from a phone",
          "The coordinator must be unable to read content",
        ],
        other: {
          title: "Use Remote Tunnels when",
          items: [
            "You want VS Code itself, remotely",
            "Debugging and extensions are the point",
            "One machine at a time is fine",
            "A Microsoft-operated path is acceptable trust",
          ],
        },
      },
    },
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
    related: [
      {
        title: "spawnd vs Coder & code-server",
        blurb: "provisioned workspaces versus machines you already own",
        href: "/spawnd-vs-coder",
      },
      {
        title: "Run agents in parallel",
        blurb: "the fleet the terminal-first shape exists for",
        href: "/run-agents-in-parallel",
      },
      {
        title: "Keep agents running",
        blurb: "persistence as a property, not a habit",
        href: "/use/keep-agents-running",
      },
      {
        title: "Claude Code on your phone",
        blurb: "the device that answers the permission prompt",
        href: "/use/claude-code-on-your-phone",
      },
    ],
    cardTitle: "vs VS Code Tunnels",
    cardBlurb: "Editor remoting versus terminal possession — a smaller overlap than it looks.",
  },

  {
    slug: "spawnd-vs-tmate",
    name: "tmate",
    title: "spawnd vs tmate",
    description:
      "tmate shares a terminal instantly; spawnd runs your fleet’s terminals permanently. Different jobs — here is the boundary, drawn honestly.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "tmate",
      sub: "Instant terminal sharing versus standing access to your own machines — the fire drill and the front door are different problems.",
    },
    intro: {
      heading: "tmate made ephemeral sharing effortless.",
      paragraphs: [
        "tmate is tmux with an instant-sharing superpower: one command, a link, and a colleague is inside your session — no accounts, no setup on their end, nothing to install beyond an SSH client they already have. For pair-debugging a broken box you’ll never touch again, the one-liner is unbeatable, and it deserves its reputation.",
        "Its architecture matches the moment it serves: the session string is the authentication, the share lives as long as the tmate process does, and the connection terminates at tmate’s server — which is why its own documentation offers self-hosting for the privacy-conscious. All fine for an emergency; all wrong as infrastructure.",
      ],
    },
    framing: {
      heading: "Standing access is a different problem.",
      paragraphs: [
        "The machines you return to every day want the opposite properties: named devices instead of whoever holds a string, approval and revocation instead of link possession, sessions that persist on the host until you end them, and a relay that cannot read what it forwards. spawnd is that arrangement — each device approved once against a short code, each terminal end-to-end encrypted from your browser to the host’s own daemon.",
      ],
    },
    ledger: {
      heading: "The moment versus the arrangement.",
      rows: [
        {
          label: "Built for",
          spawnd: "Standing access to machines you own",
          other: "Sharing one session, right now, with someone else",
        },
        {
          label: "Who connects",
          spawnd: "Your devices, each explicitly approved and revocable",
          other: "Whoever holds the session string while it lives",
        },
        {
          label: "Relay’s view",
          spawnd: "Ciphertext only; content is E2E-encrypted past it",
          other: "The tmate server terminates SSH — a party to the session unless you self-host",
        },
        {
          label: "Lifetime",
          spawnd: "Sessions persist on the host until you end them",
          other: "The share dies with the tmate process",
        },
        {
          label: "From a phone",
          spawnd: "First-class touch terminal",
          other: "Whatever SSH client the invitee has",
        },
        {
          label: "Provenance",
          spawnd: "Open source, MIT/Apache-2.0",
          other: "Open source, self-hostable relay",
        },
      ],
    },
    capture: {
      caption:
        "The standing arrangement: your own machines in the sidebar, their sessions in one grid, every device that can see this approved by name.",
    },
    verdict: {
      heading: "Keep tmate for the fire drill.",
      paragraphs: [
        "Pair-debugging a colleague’s broken box you’ll never touch again? tmate’s one-liner is unbeatable, and nothing here replaces it. It made ephemeral sharing effortless and deserves its reputation.",
        "The mistake is using an ephemeral sharing tool as your permanent access path — a session string as authentication, a content-terminating relay as infrastructure. For the machines you return to every day, spawnd gives you named, approved, revocable devices and encryption the relay can’t look through. The fire drill and the front door are different problems.",
      ],
      choose: {
        spawnd: [
          "The machines are yours and access is permanent",
          "Devices must be named, approved, and revocable",
          "Sessions must outlive the connection and the day",
          "No intermediary may read terminal content",
        ],
        other: {
          title: "Reach for tmate when",
          items: [
            "You’re sharing one session with another person",
            "It’s their machine, or a machine you’ll never see again",
            "Zero setup on the invitee’s side is the point",
            "The session should die when the moment passes",
          ],
        },
      },
    },
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
      {
        title: "spawnd vs SSH + tmux",
        blurb: "the classic, versus persistence without a listener",
        href: "/spawnd-vs-ssh-and-tmux",
      },
      {
        title: "No open ports",
        blurb: "the outbound-only network model, in full",
        href: "/use/remote-access-without-open-ports",
      },
      {
        title: "Web terminal for a home server",
        blurb: "the closet machine, reachable from the sofa and beyond",
        href: "/use/web-terminal-for-your-home-server",
      },
      {
        title: "Run agents in parallel",
        blurb: "what standing access is for in the agent era",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "vs tmate",
    cardBlurb: "Instant sharing versus standing possession — different problems.",
  },

  {
    slug: "spawnd-vs-coder",
    name: "Coder / code-server",
    title: "spawnd vs Coder and code-server",
    description:
      "Coder provisions cloud dev environments; code-server puts VS Code in a browser tab. spawnd possesses the machines you already have. Which fits, and when.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "Coder & code-server",
      sub: "Provisioned workspaces and a browser editor versus the machines you already own — three tools answering three different questions.",
    },
    intro: {
      heading: "Two good answers to two real questions.",
      paragraphs: [
        "Coder answers “give every engineer a fresh, standard dev environment”: workspaces provisioned from templates, central control over images and resources, a platform a team deploys and operates. If reproducible environments are your problem, it’s built for exactly that.",
        "code-server answers a smaller question — “put VS Code on that one box’s browser” — and does it directly: the editor served over HTTP from the host, yours to expose, certificate, and guard. Both are honest tools; both assume the machine or workspace is something you stand up and operate.",
      ],
    },
    framing: {
      heading: "spawnd answers a third question.",
      paragraphs: [
        "The machines already exist. The dev box, the home server, the GPU rig — nothing to provision, no platform to operate, no reverse proxy to harden. You want their terminals from anywhere, and you’d rather expose nothing: one daemon per host, dialing out; one approval per device; every session end-to-end encrypted from your browser to that host’s own daemon.",
        "That narrowness is the product. spawnd provisions nothing and standardises nothing — it turns machines you already own into a fleet you can reach, and stops there.",
      ],
    },
    ledger: {
      heading: "Three tools, one table.",
      rows: [
        {
          label: "The unit",
          spawnd: "A machine you already own, possessed by a daemon",
          other: "Coder: a provisioned workspace. code-server: an editor served off one host",
        },
        {
          label: "Operations burden",
          spawnd: "One daemon per host; hosted or self-hosted control plane",
          other:
            "Coder: a platform to deploy and run. code-server: your own TLS, auth, and exposure",
        },
        {
          label: "Network model",
          spawnd: "Outbound-only daemons; nothing listens",
          other: "Something serves HTTP(S) and must be reachable and guarded",
        },
        {
          label: "Interface",
          spawnd: "Terminals — sessions, agents, workspace grids",
          other: "VS Code in the browser; terminals as editor panes",
        },
        {
          label: "Content visibility",
          spawnd: "E2E-encrypted browser↔daemon; introducer reads nothing",
          other: "Your deployment terminates TLS; visibility is yours to architect",
        },
        {
          label: "Best at",
          spawnd: "Standing terminal access to your own fleet",
          other: "Coder: team-standard environments. code-server: an editor on a headless box",
        },
      ],
    },
    capture: {
      caption:
        "The fleet that needed no provisioning: three machines that already existed, their agent sessions in one grid, nothing exposed on any of them.",
    },
    verdict: {
      heading: "Provisioning is a real job — when you have it.",
      paragraphs: [
        "If you run a team that needs reproducible environments stamped out from templates, with central control over images and resources, Coder is built for exactly that and spawnd is not a substitute. If what you want is VS Code itself in a tab on one machine you’re happy to expose properly, code-server does it.",
        "spawnd is for the other shape of life, common to individuals and small teams: a handful of real machines — the dev box, the home server, the GPU rig — that need no provisioning because they already exist, and whose terminals you want in your pocket without standing up a platform or a reverse proxy. One daemon each, one approval per device, nothing to operate.",
      ],
      choose: {
        spawnd: [
          "The machines already exist and are yours",
          "Terminals and agents are the interface, not an IDE",
          "Nothing may listen on any host",
          "Operating a platform is a cost, not a feature",
        ],
        other: {
          title: "Use Coder or code-server when",
          items: [
            "A team needs template-stamped environments",
            "Central control of images and resources matters",
            "You want VS Code itself in the browser",
            "You’re equipped to expose and guard a service",
          ],
        },
      },
    },
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
      {
        title: "spawnd vs VS Code Remote Tunnels",
        blurb: "editor remoting versus terminal possession",
        href: "/spawnd-vs-vscode-remote-tunnels",
      },
      {
        title: "AI agents on your own GPU",
        blurb: "the rig as a first-class host in the grid",
        href: "/use/ai-agents-on-your-own-gpu",
      },
      {
        title: "Web terminal for a home server",
        blurb: "the closet machine, reachable without exposure",
        href: "/use/web-terminal-for-your-home-server",
      },
      {
        title: "Run agents in parallel",
        blurb: "what the fleet looks like when it’s working",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "vs Coder & code-server",
    cardBlurb: "Provisioned workspaces versus machines you already own.",
  },

  {
    slug: "spawnd-vs-tailscale-ssh",
    name: "Tailscale SSH",
    title: "spawnd vs Tailscale SSH",
    description:
      "Tailscale builds you a private network; spawnd hands you terminals. Where the two overlap, where they don’t, and why many people run both.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "Tailscale SSH",
      sub: "A private network with SSH riding it versus terminals as the whole product — narrower on purpose, and for terminal work, more complete.",
    },
    intro: {
      heading: "Tailscale is a superb answer to its question.",
      paragraphs: [
        "The question is “my devices should share a network”, and Tailscale answers it about as well as it can be answered: WireGuard tunnels established without inbound exposure, a mesh that just works across NATs, and ACLs to scope who reaches what. Tailscale SSH rides that network to genuinely end key management within it — the tailnet vouches for the device, so there are no keys to sprawl.",
        "Everything on the tailnet benefits: the NAS’s web UI, the printer, any TCP service on any machine. If your need is a private network, install it and don’t look back — it’s the best of its kind.",
      ],
    },
    framing: {
      heading: "A network is the long way round to a terminal.",
      paragraphs: [
        "If the need is specifically terminals — agent sessions that persist, reattach from a phone, and stay unreadable to every intermediary — the network path still leaves work on the table: a client on every device, an SSH app beside it on the phone, and tmux discipline for persistence, same as ever.",
        "spawnd never builds a network at all. It delivers exactly one thing — terminals on your machines, from any approved browser — and encrypts them past its own introducer. The trust claim is narrower and checkable: not “the coordinator is trustworthy”, but “the coordinator is deaf”. Approving a device grants terminals; nothing else exists to reach.",
      ],
    },
    ledger: {
      heading: "A network versus a channel.",
      rows: [
        {
          label: "What you get",
          spawnd: "Terminals, as a product: sessions, agents, grids",
          other: "A mesh network; SSH is one thing you do over it",
        },
        {
          label: "Blast radius of access",
          spawnd: "A terminal on the host — nothing else is reachable",
          other: "The device joins your tailnet; ACLs scope what it reaches",
        },
        {
          label: "Client requirement",
          spawnd: "Any modern browser; installable as a web app",
          other: "Tailscale on every device, plus an SSH client",
        },
        {
          label: "From a phone",
          spawnd: "First-class touch terminal, no extra apps",
          other: "Tailscale app + a terminal app, working in tandem",
        },
        {
          label: "Session persistence",
          spawnd: "Built in; survives disconnects and daemon restarts",
          other: "Not SSH’s job — bring tmux, same as ever",
        },
        {
          label: "Coordination trust",
          spawnd: "E2E past the introducer; pinned endpoint keys; open source",
          other:
            "Coordinator distributes keys; tailnet lock exists to check it; clients open, control plane not",
        },
      ],
    },
    capture: {
      caption:
        "The channel, not the network: sessions from three machines in one grid, each tile encrypted to its own host, nothing else reachable.",
    },
    verdict: {
      heading: "If you need a network, use the network.",
      paragraphs: [
        "Tailscale solves problems spawnd doesn’t touch: reaching a NAS’s web UI, printing to the office, any TCP service on any machine. If your need is “my devices, one private network”, install Tailscale and don’t look back — its SSH mode genuinely does end key sprawl within it.",
        "But if the need is specifically terminals — especially agent sessions that must persist, reattach from a phone, and stay unreadable to every intermediary — a network is the long way round. spawnd skips the tailnet, the per-device clients, and the tmux discipline. Plenty of people run both: Tailscale for the network, spawnd for the terminals.",
      ],
      choose: {
        spawnd: [
          "Terminals are the need, not general reachability",
          "Phones are first-class, with no companion apps",
          "Persistence must not depend on tmux discipline",
          "The coordinator must be unable to read content",
        ],
        other: {
          title: "Use Tailscale when",
          items: [
            "Many services need reaching, not just terminals",
            "You want one private network across your devices",
            "ACL-scoped network access is the right model",
            "SSH key sprawl is the pain being solved",
          ],
        },
      },
    },
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
      {
        title: "spawnd vs SSH + tmux",
        blurb: "the classic, versus persistence without a listener",
        href: "/spawnd-vs-ssh-and-tmux",
      },
      {
        title: "No open ports",
        blurb: "the outbound-only network model, in full",
        href: "/use/remote-access-without-open-ports",
      },
      {
        title: "Claude Code on your phone",
        blurb: "the phone as a first-class console",
        href: "/use/claude-code-on-your-phone",
      },
      {
        title: "Run agents in parallel",
        blurb: "the grid the channel exists to deliver",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "vs Tailscale SSH",
    cardBlurb: "A private network versus a deaf channel — and why some run both.",
  },
];
