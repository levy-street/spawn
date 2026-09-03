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
        href: "/claude-code-on-your-phone",
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
        href: "/claude-code-on-your-phone",
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
  {
    slug: "spawnd-vs-mosh",
    name: "mosh",
    title: "spawnd vs mosh",
    description:
      "mosh fixed the flaky-connection problem for SSH — roaming, instant echo, UDP resilience. What it left unfixed, and where spawnd picks up the thread.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "mosh",
      sub: "The mobile shell solved the dying connection — and stopped there. Sessions, phones, and the zero-inbound host are a different project.",
    },
    intro: {
      heading: "mosh fixed the right problem, brilliantly.",
      paragraphs: [
        "mosh exists because SSH dies when the network does: close the laptop, switch from Wi-Fi to cellular, ride a train — the TCP connection is gone and the session with it. mosh authenticates over SSH, then switches to its own encrypted UDP channel that survives roaming and packet loss, and its predictive local echo makes a bad link feel instant. For a laptop that moves through networks all day, it remains a genuine quality-of-life upgrade over bare SSH.",
        "Its boundaries are equally clear, and its own documentation is honest about them: the server must have a UDP port range reachable (typically 60000–61000), which rules out the sealed-firewall host; scrollback isn't supported, so tmux rides inside anyway; and a dropped device still means a dead session — mosh survives the network changing, not the client disappearing. Persistence was never its job.",
      ],
    },
    framing: {
      heading: "Surviving the network versus surviving everything else.",
      paragraphs: [
        "spawnd starts from the piece mosh set aside: the session itself lives on the host, owned by a worker process, so it survives the closed tab, the dead phone battery, and a restart of the daemon — scrollback intact, because the host keeps it. Reconnection isn't a channel trick; there's simply nothing to lose.",
        "The network model inverts too. mosh needs inbound UDP; spawnd's daemon dials out and nothing listens. And the client requirement drops to a browser: the same terminal on the desk, the phone, and the borrowed machine, each device approved once and revocable — end-to-end encrypted to each host's own daemon.",
      ],
    },
    ledger: {
      heading: "The channel versus the session.",
      rows: [
        {
          label: "Survives",
          spawnd: "Network loss, closed tab, device death, daemon restart",
          other: "Network loss and roaming — the connection, not the session",
        },
        {
          label: "Network requirement",
          spawnd: "None inbound — the daemon dials out",
          other: "SSH for auth plus a reachable UDP range (60000–61000 typical)",
        },
        {
          label: "Scrollback",
          spawnd: "Kept on the host; reattach and it's there",
          other: "Not supported — run tmux inside for history",
        },
        {
          label: "From a phone",
          spawnd: "Any browser, installable as a web app",
          other: "A mosh-capable client app (Blink, Termius), per device",
        },
        {
          label: "Feel on a bad link",
          spawnd: "Live terminal over a resilient encrypted channel",
          other: "Superb — predictive echo is mosh's signature",
        },
        {
          label: "Auth and revocation",
          spawnd: "Approve a device once; revoke with one click everywhere",
          other: "SSH keys, same as ever, per host",
        },
        {
          label: "Provenance",
          spawnd: "Open source, MIT/Apache-2.0",
          other: "Open source, a landmark design — slow but steady releases",
        },
      ],
    },
    capture: {
      caption:
        "What persistence-as-structure looks like: agent sessions across three machines that survive any client coming or going, scrollback kept by the hosts.",
    },
    verdict: {
      heading: "Keep mosh where mosh shines.",
      paragraphs: [
        "If your workflow is a moving laptop and a reachable server, mosh plus tmux remains a fine rig — the roaming is seamless and the predictive echo still feels like magic on hotel Wi-Fi. Nothing here takes that away.",
        "spawnd earns the switch when the session matters more than the channel: agent runs that must outlive every device you own, hosts that can't open a UDP range, phones that shouldn't need a client app, and scrollback you expect to find where you left it. mosh keeps a connection alive; spawnd makes the connection optional.",
      ],
      choose: {
        spawnd: [
          "Sessions must survive devices, not just networks",
          "Hosts present zero inbound surface, UDP included",
          "Phones and borrowed machines are first-class",
          "Scrollback and reattach must be structural",
        ],
        other: {
          title: "Stay with mosh when",
          items: [
            "A moving laptop and one reachable server is the shape",
            "Predictive echo on bad links is the killer feature",
            "You're happy with tmux for persistence and history",
            "An SSH-based toolchain is a hard requirement",
          ],
        },
      },
    },
    faq: [
      {
        q: "Does spawnd have mosh-style predictive echo?",
        a: "No — spawnd sends real keystrokes over a low-latency encrypted channel rather than predicting locally. On most links the difference isn't noticeable; on truly terrible ones, mosh's prediction still feels smoother. What spawnd guarantees instead is that the session and its scrollback survive the link dying entirely.",
      },
      {
        q: "Can I run mosh inside a spawnd session?",
        a: "You can run anything in a spawnd session — it's a real shell. But mosh's job (surviving the client's network) is already covered: the session lives on the host regardless of what happens to your device.",
      },
      {
        q: "Why does mosh need open UDP ports and spawnd doesn't?",
        a: "mosh's server waits for the client's datagrams, so something must be reachable. spawnd's daemon only dials out — to the control plane, and peer-to-peer to your browser — so the host can sit behind a sealed firewall or CGNAT.",
      },
    ],
    related: [
      {
        title: "spawnd vs SSH + tmux",
        blurb: "the classic rig mosh usually rides with",
        href: "/spawnd-vs-ssh-and-tmux",
      },
      {
        title: "spawnd vs mobile SSH apps",
        blurb: "the clients that speak mosh on a phone",
        href: "/spawnd-vs-mobile-ssh-apps",
      },
      {
        title: "Keep agents running",
        blurb: "sessions that outlive every device",
        href: "/use/keep-agents-running",
      },
      {
        title: "Run agents in parallel",
        blurb: "what the persistent fleet is for",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "vs mosh",
    cardBlurb: "Surviving the network versus surviving everything else.",
  },

  {
    slug: "spawnd-vs-mobile-ssh-apps",
    name: "Termius / Blink",
    title: "spawnd vs mobile SSH apps",
    description:
      "Termius and Blink are genuinely good SSH clients for the phone. The real comparison is the shape: an SSH client app versus terminals with no client at all.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "mobile SSH apps",
      sub: "Termius, Blink, and their kin made SSH livable on a phone. The question is whether the phone needs an SSH client at all.",
    },
    intro: {
      heading: "The good ones are genuinely good.",
      paragraphs: [
        "Blink is the keyboard-first power tool of iOS terminals — hardware-keyboard bindings, themes, native mosh for connection resilience, a yearly price a professional doesn't blink at. Termius trades depth for reach: one client across phone and desktop, hosts and keys synced everywhere, teams and AI conveniences layered on a subscription. Both have earned their reputations, and both now ride mosh, so the flaky-cellular problem is largely solved inside them.",
        "What they can't change is the shape they inherit: they are SSH clients. The server must be reachable — a port, a VPN, a tailnet; the keys must get onto each device and off it again when the device goes; and the session's persistence is still tmux's job on the far end. The app polishes the window; the plumbing behind it is unchanged.",
      ],
    },
    framing: {
      heading: "spawnd removes the client, not just the friction.",
      paragraphs: [
        "On spawnd the phone needs nothing installed: the browser is the terminal, installable as a web app, built for touch and the virtual keyboard. There is no key to provision — the device is approved once against a short code, and revoked with one click that every host honors.",
        "And what you reach isn't a socket, it's your standing sessions: the agent that's been running since morning, scrollback intact, the same grid you left on the desk. End-to-end encrypted from the phone's browser to each host's own daemon, with nothing on any host listening for it.",
      ],
    },
    ledger: {
      heading: "The app versus no app.",
      rows: [
        {
          label: "On the phone",
          spawnd: "The browser — installable web app, nothing else",
          other: "A client app per platform, configured per device",
        },
        {
          label: "Reaching the host",
          spawnd: "Daemon dials out; works behind sealed firewalls and CGNAT",
          other: "Host must be reachable: port, VPN, or tailnet",
        },
        {
          label: "Credentials",
          spawnd: "One approval per device; one-click revocation everywhere",
          other: "Keys managed per device (or synced through a vendor account)",
        },
        {
          label: "Session persistence",
          spawnd: "Structural — sessions live on the host with scrollback",
          other: "mosh keeps the channel; tmux keeps the session, as ever",
        },
        {
          label: "Beyond terminals",
          spawnd: "Terminals and file transfer — deliberately narrow",
          other: "SFTP, port forwarding, snippets, any SSH target anywhere",
        },
        {
          label: "Cost and provenance",
          spawnd: "Open source, MIT/Apache-2.0",
          other: "Polished proprietary apps; subscription or yearly license",
        },
      ],
    },
    capture: {
      caption:
        "What the phone opens onto: not a socket to configure but the standing grid — the same sessions, the same scrollback, every device approved by name.",
    },
    verdict: {
      heading: "An excellent client for the old shape.",
      paragraphs: [
        "If your world is many arbitrary SSH endpoints — client boxes, jump hosts, servers you don't control — a first-class SSH app is the right tool, and Blink or Termius will serve you well. spawnd can't reach a host that doesn't run its daemon, and doesn't try to.",
        "For the machines that are yours, the calculus flips: install one daemon per host once, and every device you'll ever approve gets persistent terminals with none of the key ceremony, reachability plumbing, or tmux discipline. The agent asking permission at 9pm is answered from the sofa in the same session it asked in.",
      ],
      choose: {
        spawnd: [
          "The hosts are yours and run the daemon",
          "No client installs, no keys on phones",
          "Sessions and scrollback must persist by construction",
          "Hosts stay sealed — nothing reachable to configure",
        ],
        other: {
          title: "Use an SSH app when",
          items: [
            "You reach arbitrary servers you don't control",
            "SFTP and port forwarding are daily tools",
            "Hardware-keyboard depth on iPad is the priority",
            "Your fleet's access is already SSH-standardised",
          ],
        },
      },
    },
    faq: [
      {
        q: "Is a browser terminal really usable on a phone?",
        a: "spawnd's terminal is built for touch: a modifier bar for keys phones don't have, virtual-keyboard handling that doesn't fight the viewport, and sessions sized for the screen. It's a first-class surface, not a desktop page squeezed down.",
      },
      {
        q: "Can spawnd reach a server that doesn't run its daemon?",
        a: "No. spawnd is standing access to machines you possess, not a general SSH client. For one-off connections to arbitrary hosts, keep an SSH app — many people run both.",
      },
      {
        q: "What about SFTP and port forwarding?",
        a: "spawnd does terminals and file transfer. Port forwarding and the wider SSH toolbox aren't the product — if those are daily needs, an SSH client remains the right tool beside it.",
      },
    ],
    related: [
      {
        title: "spawnd vs mosh",
        blurb: "the protocol those apps ride for resilience",
        href: "/spawnd-vs-mosh",
      },
      {
        title: "Claude Code on your phone",
        blurb: "the phone as a first-class agent console",
        href: "/claude-code-on-your-phone",
      },
      {
        title: "spawnd vs SSH + tmux",
        blurb: "the plumbing the apps inherit, examined",
        href: "/spawnd-vs-ssh-and-tmux",
      },
      {
        title: "Run agents in parallel",
        blurb: "the grid waiting behind the phone",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "vs mobile SSH apps",
    cardBlurb: "Termius and Blink polish the window; spawnd removes the client.",
  },

  {
    slug: "spawnd-vs-self-hosted-web-terminals",
    name: "ttyd / WeTTY",
    title: "spawnd vs self-hosted web terminals",
    description:
      "ttyd and WeTTY put a terminal in the browser a decade ago. The difference is everything around it: exposure, encryption, persistence, and more than one machine.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "ttyd & WeTTY",
      sub: "The browser terminal isn't the hard part — the projects that proved it also show where the real work begins.",
    },
    intro: {
      heading: "The pioneers proved the idea.",
      paragraphs: [
        "ttyd is a small, sharp C program: point it at a command, and xterm.js serves that command's terminal to a browser over WebSocket. WeTTY does the same by spawning ssh, inheriting SSH's authentication. Both are open source, both self-hosted, and both settled the question of whether a browser can be a real terminal years ago. For a quick terminal on one box on a trusted network, they're honest, minimal tools.",
        "Everything around the terminal is left to you, and their own guidance says so: bind to localhost, put a reverse proxy in front, bring your own TLS, auth, and hardening — because what you're standing up is a listener that serves a shell. That's per host, and it's your name on the exposure.",
      ],
    },
    framing: {
      heading: "spawnd is what the wrapper never became.",
      paragraphs: [
        "Same browser, same xterm lineage — inverted plumbing. spawnd's daemon dials out, so there is no listener, no reverse proxy, no certificate, and no exposure homework on any host. Sessions are owned by worker processes, so they persist with scrollback instead of living and dying with a tab. Devices are approved and revoked account-wide instead of guarded by whatever auth you wired in front.",
        "And it's a fleet, not a box: every host's sessions in one grid, each tile end-to-end encrypted from your browser to that host's own daemon — the server that introduces them never hears a word. The browser terminal was the easy part; the product is everything the wrapper left as an exercise.",
      ],
    },
    ledger: {
      heading: "A wrapper versus a system.",
      rows: [
        {
          label: "Network model",
          spawnd: "Outbound-only daemon; nothing listens anywhere",
          other: "A listener per host — proxy, TLS, and auth are your homework",
        },
        {
          label: "Encryption",
          spawnd: "End-to-end, browser to daemon; relay sees ciphertext",
          other: "TLS to your proxy; inside, it's your architecture",
        },
        {
          label: "Sessions",
          spawnd: "Persist on the host with scrollback; reattach anywhere",
          other: "Live and die with the browser tab (bring tmux)",
        },
        {
          label: "Many machines",
          spawnd: "One grid, sessions from every host side by side",
          other: "One deployment per host, one tab per host",
        },
        {
          label: "Access control",
          spawnd: "Named devices, approved once, revoked one click everywhere",
          other: "Basic auth or SSH login — whatever you configured, per host",
        },
        {
          label: "Provenance",
          spawnd: "Open source, MIT/Apache-2.0, active",
          other: "Open source, minimal by design, slow-cadence maintenance",
        },
      ],
    },
    capture: {
      caption:
        "The system the wrapper hints at: three hosts' sessions in one grid, no listener on any of them, every tile its own encrypted channel.",
    },
    verdict: {
      heading: "Minimal is a feature — until it's your attack surface.",
      paragraphs: [
        "On a trusted LAN, for one box, ttyd is a perfectly good answer — a terminal in a tab with nothing to buy and nothing to sign up for. If that's the whole need, it's the simpler tool and you should use it.",
        "The calculus changes the moment the terminal must cross the internet, survive the tab, or cover a second machine. Then the wrapper's to-do list — proxy, TLS, auth, hardening, per host, forever — is the product spawnd already is, with a stronger property than a well-guarded listener: no listener at all, and encryption the infrastructure can't look through.",
      ],
      choose: {
        spawnd: [
          "Terminals must cross the internet safely",
          "Sessions must outlive tabs, devices, and restarts",
          "More than one machine belongs in the picture",
          "Nobody wants to own proxy-and-TLS homework per host",
        ],
        other: {
          title: "Use ttyd or WeTTY when",
          items: [
            "One box, one trusted network, one tab",
            "You want a zero-account, zero-service tool",
            "Embedding a terminal in something else is the goal",
            "You enjoy owning the whole stack yourself",
          ],
        },
      },
    },
    faq: [
      {
        q: "Isn't spawnd just ttyd with an account system?",
        a: "The browser terminal is the shared ancestor; the rest is different plumbing. ttyd serves a shell from a listener you must guard. spawnd's hosts listen on nothing, sessions persist with scrollback, devices are approved and revoked account-wide, and terminal content is end-to-end encrypted past the server that connects you.",
      },
      {
        q: "Can I self-host spawnd like I'd self-host WeTTY?",
        a: "Yes — the control plane is open source and self-hostable, and the daemons don't care whose control plane introduces them. The E2E property holds either way: even your own server only ever forwards ciphertext.",
      },
      {
        q: "Do my ttyd sessions survive a closed tab?",
        a: "Not by themselves — the process lives while the connection does, so the usual pattern is tmux inside it. spawnd sessions are owned by a worker process on the host, so the tab is just a viewer.",
      },
    ],
    related: [
      {
        title: "spawnd vs Coder & code-server",
        blurb: "the other self-hosted browser-tool comparison",
        href: "/spawnd-vs-coder",
      },
      {
        title: "Web terminal for a home server",
        blurb: "the closet machine, done without a listener",
        href: "/use/web-terminal-for-your-home-server",
      },
      {
        title: "No open ports",
        blurb: "the outbound-only network model, in full",
        href: "/use/remote-access-without-open-ports",
      },
      {
        title: "spawnd vs Cloudflare Tunnel",
        blurb: "the other way to serve without listening",
        href: "/spawnd-vs-cloudflare-tunnel",
      },
    ],
    cardTitle: "vs ttyd & WeTTY",
    cardBlurb: "The browser terminal was the easy part.",
  },

  {
    slug: "spawnd-vs-github-codespaces",
    name: "GitHub Codespaces",
    title: "spawnd vs GitHub Codespaces",
    description:
      "Codespaces rents you a fresh machine per branch; spawnd possesses the machines you already own. Different economics, different trust, different agent story.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "GitHub Codespaces",
      sub: "A rented machine that vanishes when you stop paying attention, versus your own machines that never stop — the agent era makes the difference sharp.",
    },
    intro: {
      heading: "A fresh machine per branch is a real superpower.",
      paragraphs: [
        "Codespaces gives you a disposable dev machine in GitHub's cloud: click, and a devcontainer builds itself around the branch — toolchain, extensions, secrets — reachable from VS Code or a browser tab anywhere. For onboarding, one-off contributions, and keeping laptops out of production credentials, it's genuinely excellent, and the free tier's monthly core-hours cover casual use.",
        "Its economics and rhythms are a cloud product's: metered per core-hour past the free allowance, storage billed monthly, and an idle timeout — thirty minutes by default — that stops the machine when you stop touching it. Sensible for browsers-and-humans; expensive habits for anything that runs while you sleep.",
      ],
    },
    framing: {
      heading: "Agents change what a dev machine is for.",
      paragraphs: [
        "A coding agent's best hours are unattended: the refactor dispatched at six, still grinding at nine, finished overnight. On rented compute that pattern fights both the meter and the idle timeout; on your own hardware it's free and nobody stops it. The GPU rig, the Mac Studio, the home server — the machines you already own are better agent hosts than any rental, if you can reach them.",
        "Reaching them is spawnd's whole product: persistent terminals on every host you possess, from any approved browser, end-to-end encrypted past the server that introduces them. Your code never moves to someone else's computer, because the computer was yours all along.",
      ],
    },
    ledger: {
      heading: "Rented versus possessed.",
      rows: [
        {
          label: "The machine",
          spawnd: "Yours — dev box, GPU rig, home server, laptop",
          other: "GitHub's — a devcontainer VM built per branch",
        },
        {
          label: "Economics",
          spawnd: "Open source; your hardware, your power bill",
          other: "Free core-hours monthly, then metered per core-hour + storage",
        },
        {
          label: "Long unattended runs",
          spawnd: "Native — sessions persist until you end them",
          other: "Idle timeout stops the machine (30 min default); the meter runs while it doesn't",
        },
        {
          label: "Where code lives",
          spawnd: "On your machines; sessions E2E-encrypted past the server",
          other: "In GitHub's cloud, inside your GitHub account's trust",
        },
        {
          label: "Environment reproducibility",
          spawnd: "Whatever your machines are — spawnd doesn't provision",
          other: "Devcontainers rebuild identically every time — the headline feature",
        },
        {
          label: "GPU and local models",
          spawnd: "Your GPU is a first-class host",
          other: "Machine types are GitHub's menu, priced accordingly",
        },
      ],
    },
    capture: {
      caption:
        "The owned fleet at work: agent sessions across three machines that were already paid for, running as long as the work takes.",
    },
    verdict: {
      heading: "Rent for reproducibility, own for endurance.",
      paragraphs: [
        "If the problem is environments — onboarding someone by lunch, reviewing a stranger's PR without trusting your laptop to it, keeping toolchains identical across a team — Codespaces is built for exactly that, and owning hardware doesn't solve it. Keep it for what it is: the best disposable machine in the business.",
        "If the problem is the agent era's actual workload — long runs, big checkouts, your own GPU, sessions you answer from a phone at night — the rented machine's meter and timeout are working against you. spawnd turns the hardware you already own into the fleet those workloads want, with a trust model where your terminal content is yours alone.",
      ],
      choose: {
        spawnd: [
          "Agents run for hours on machines you own",
          "The GPU rig and home server are the compute",
          "Code and terminal content stay on your hardware",
          "No meter should decide when work stops",
        ],
        other: {
          title: "Use Codespaces when",
          items: [
            "Reproducible per-branch environments are the point",
            "Onboarding and one-off contributions dominate",
            "Untrusted code needs a disposable sandbox",
            "You want zero hardware to own or maintain",
          ],
        },
      },
    },
    faq: [
      {
        q: "Can I use spawnd and Codespaces together?",
        a: "Naturally — they don't compete for the same machine. Some people prototype in a codespace and run the long agent work on their own rig through spawnd; the daemon doesn't care what else your workflow includes.",
      },
      {
        q: "Does spawnd give me reproducible environments?",
        a: "No — spawnd deliberately provisions nothing. Your machines are whatever you've made them; devcontainers and Nix solve reproducibility, and they run fine on hosts spawnd reaches.",
      },
      {
        q: "Is a codespace private from GitHub?",
        a: "A codespace runs on GitHub's infrastructure under your account, governed by GitHub's terms and controls. spawnd's claim is structural rather than contractual: sessions are end-to-end encrypted from your browser to your host's daemon, and the introducing server carries only ciphertext.",
      },
    ],
    related: [
      {
        title: "spawnd vs Coder & code-server",
        blurb: "the self-hosted flavour of provisioned environments",
        href: "/spawnd-vs-coder",
      },
      {
        title: "AI agents on your own GPU",
        blurb: "the rig as a first-class host",
        href: "/use/ai-agents-on-your-own-gpu",
      },
      {
        title: "Keep agents running",
        blurb: "runs that no meter or timeout interrupts",
        href: "/use/keep-agents-running",
      },
      {
        title: "Run agents in parallel",
        blurb: "the owned fleet, working",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "vs GitHub Codespaces",
    cardBlurb: "Rent for reproducibility, own for endurance.",
  },

  {
    slug: "spawnd-vs-cloudflare-tunnel",
    name: "Cloudflare Tunnel",
    title: "spawnd vs Cloudflare Tunnel",
    description:
      "cloudflared dials out just like spawnd's daemon — the closest cousin in the field. The fork in the road is who can read the session, and what a terminal owes you.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "Cloudflare Tunnel",
      sub: "Two outbound-only connectors, one real fork: whether the infrastructure in the middle can read what flows through it.",
    },
    intro: {
      heading: "The network model is the same, and that's a compliment.",
      paragraphs: [
        "Cloudflare Tunnel got the architecture right: cloudflared makes a persistent outbound connection to Cloudflare's edge, and inbound traffic rides it back — no open ports, no public IP, DDoS protection for free. Put Access in front and you get real authentication policies over anything you serve. For exposing a web app from a homelab, or giving a team SSH gated by SSO, it's a deservedly popular answer.",
        "Terminals are where its shape shows. The polished path — the browser-rendered terminal — has Cloudflare's edge render the session, which makes Cloudflare a party to the plaintext; the client-side path keeps SSH end-to-end but reinstates everything SSH asks: cloudflared on every device, keys or short-lived certs, and tmux for anything that must survive. The tunnel moves packets superbly; it has no opinion about sessions.",
      ],
    },
    framing: {
      heading: "Same doorway, different rooms.",
      paragraphs: [
        "spawnd's daemon dials out the same way — and then delivers a different product. Sessions are the unit: they live on the host with scrollback, show up in one grid across all your machines, and reattach from any approved browser, phone included, with no per-device client or key ceremony.",
        "And the middle stays deaf by construction: your browser talks to each daemon peer-to-peer, end-to-end encrypted, and when a relay is unavoidable it forwards ciphertext it cannot read. Not a policy promise from an operator — a property you can verify in open source.",
      ],
    },
    ledger: {
      heading: "The tunnel versus the terminal.",
      rows: [
        {
          label: "Connector",
          spawnd: "Outbound-only daemon — same architecture, honestly",
          other: "Outbound-only cloudflared — the pattern done at scale",
        },
        {
          label: "Who can read a session",
          spawnd: "You and the host — E2E past the introducer, verifiable in source",
          other:
            "Browser-rendered: Cloudflare's edge renders it. Client-side SSH: end-to-end, with client setup back",
        },
        {
          label: "What it serves",
          spawnd: "Terminals as the product: sessions, agents, grids",
          other: "Anything TCP/HTTP — terminals are one tenant among many",
        },
        {
          label: "Session persistence",
          spawnd: "Structural, with scrollback on the host",
          other: "Not the tunnel's job — tmux, as ever",
        },
        {
          label: "From a phone",
          spawnd: "First-class touch terminal, no apps",
          other: "Browser-rendered works; client-side path wants cloudflared per device",
        },
        {
          label: "Operator and account",
          spawnd: "Open source end to end; self-hostable control plane",
          other: "Cloudflare's service and dashboard; generous free tier, closed control plane",
        },
      ],
    },
    capture: {
      caption:
        "What the doorway opens onto here: standing sessions across three machines in one grid, each tile encrypted to its own host — the middle carries only ciphertext.",
    },
    verdict: {
      heading: "For services, hard to beat. For terminals, the long way.",
      paragraphs: [
        "If you're exposing web apps, APIs, or a whole homelab's services to the internet with authentication in front, Cloudflare Tunnel is excellent and spawnd is no substitute — spawnd serves terminals, not your Jellyfin. Teams already living in Cloudflare Zero Trust have every reason to route SSH through it too.",
        "But if what you need is terminals on your own machines, the tunnel path makes you choose between convenience and confidentiality: the browser terminal that Cloudflare can read, or the end-to-end path that brings back per-device clients and tmux. spawnd refuses that trade — browser convenience and end-to-end encryption in the same product, with sessions that persist because that's what the product is.",
      ],
      choose: {
        spawnd: [
          "Terminals are the need, sessions the unit",
          "No intermediary may be able to read content",
          "Phones need first-class access with no client",
          "Persistence must not depend on tmux discipline",
        ],
        other: {
          title: "Use Cloudflare Tunnel when",
          items: [
            "Web apps and services need public exposure",
            "Access/SSO policies over many apps are the point",
            "You're already invested in Cloudflare Zero Trust",
            "One vendor fronting everything is a feature",
          ],
        },
      },
    },
    faq: [
      {
        q: "Cloudflare's browser terminal — can Cloudflare really see my session?",
        a: "In browser-rendered mode the terminal is rendered at Cloudflare's edge, which means the session exists there in readable form; that's inherent to the design, not a flaw they hide. Their client-side SSH path avoids it by keeping SSH end-to-end. spawnd's browser terminal is end-to-end encrypted to the host's own daemon — the convenience without the trade.",
      },
      {
        q: "Isn't spawnd's outbound-only model just Cloudflare Tunnel's?",
        a: "The connector pattern is the same, and it's the right pattern. The difference is what rides it and who can read it: spawnd carries only terminal sessions, encrypted past its own infrastructure, with the whole stack open source.",
      },
      {
        q: "Can I run both?",
        a: "A very natural split: Cloudflare Tunnel for the services you serve to the world, spawnd for the terminals you keep to yourself. The daemons coexist happily on one host.",
      },
    ],
    related: [
      {
        title: "spawnd vs Tailscale SSH",
        blurb: "the other infrastructure giant, compared",
        href: "/spawnd-vs-tailscale-ssh",
      },
      {
        title: "No open ports",
        blurb: "the outbound-only model, in full",
        href: "/use/remote-access-without-open-ports",
      },
      {
        title: "spawnd vs self-hosted web terminals",
        blurb: "the listener-shaped way to a browser terminal",
        href: "/spawnd-vs-self-hosted-web-terminals",
      },
      {
        title: "Run agents in parallel",
        blurb: "the standing fleet behind the doorway",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "vs Cloudflare Tunnel",
    cardBlurb: "Same doorway, different rooms — and a deaf middle.",
  },

  {
    slug: "spawnd-vs-remote-desktop",
    name: "Remote desktop",
    title: "spawnd vs remote desktop",
    description:
      "RustDesk and Chrome Remote Desktop ship your screen as video. For terminal work that's the wrong unit — here's the honest boundary between pixels and text.",
    datePublished: "2026-08-30",
    dateModified: "2026-08-30",
    hero: {
      plain: "spawnd vs",
      accent: "remote desktop",
      sub: "When the job is a GUI, ship the screen. When the job is a terminal, shipping the screen is the heaviest possible way to move text.",
    },
    intro: {
      heading: "Sometimes you really do need the pixels.",
      paragraphs: [
        "Remote desktop earns its keep wherever the work is graphical: a DAW, a CAD session, a browser you must click through, a parent's machine that needs fixing. RustDesk does it open source with end-to-end encryption and a self-hostable relay — a genuinely strong trust story — and Chrome Remote Desktop does it free with nothing but a Google account. For desktops, these are the right tools.",
        "Their unit of exchange is the screen: the host renders a display, encodes it as video, and streams it. That means a GUI session must exist to capture, bandwidth is spent on every pixel, latency lives between your keystroke and its echo, and a phone shows you a desktop the size of a postage stamp with a mouse emulated under your thumb.",
      ],
    },
    framing: {
      heading: "Terminal work wants text, not video of text.",
      paragraphs: [
        "A terminal session is a few kilobytes of text and control codes. spawnd moves exactly that — real terminal I/O, end-to-end encrypted from your browser to the host's own daemon — so it's crisp on hotel Wi-Fi, native on a phone, and runs fine against a headless box that has never rendered a desktop in its life.",
        "Sessions are also the right unit for the agent era: they persist on the host with scrollback, sit side by side in one grid across machines, and reattach from anything you've approved. A desktop stream shows you one machine's screen; the grid shows you the fleet's work.",
      ],
    },
    ledger: {
      heading: "Pixels versus text.",
      rows: [
        {
          label: "What travels",
          spawnd: "Terminal I/O — kilobytes of text, E2E-encrypted",
          other: "The screen, encoded as video, continuously",
        },
        {
          label: "Host requirement",
          spawnd: "A daemon; headless is native",
          other: "A GUI session to capture (or one stood up for the purpose)",
        },
        {
          label: "On a phone",
          spawnd: "A terminal shaped for the screen and touch",
          other: "A desktop squeezed onto it, cursor under a fingertip",
        },
        {
          label: "Bad networks",
          spawnd: "Text degrades gracefully; sessions survive drops entirely",
          other: "Compression artifacts, lag, reconnect roulette",
        },
        {
          label: "Many machines",
          spawnd: "One grid of sessions across the fleet",
          other: "One window per machine's screen",
        },
        {
          label: "Trust model",
          spawnd: "E2E past the introducer; open source, self-hostable",
          other: "RustDesk: E2E, self-hostable — credit where due. CRD: rides your Google account",
        },
      ],
    },
    capture: {
      caption:
        "The fleet as text: agent sessions from three machines in one grid — kilobytes moving where a desktop stream would ship megabits of pixels.",
    },
    verdict: {
      heading: "Ship the screen for GUIs. Not for shells.",
      paragraphs: [
        "If the work is graphical, use the right tool: RustDesk if you want open source and your own relay, Chrome Remote Desktop if you want free and effortless. Nothing terminal-shaped substitutes for a real desktop when a real desktop is the job.",
        'But an enormous amount of "I need to get to that machine" is terminal work wearing a desktop costume — a shell reached by streaming an entire screen to click on a terminal emulator inside it. For that, spawnd is the honest shape: the text itself, encrypted end to end, persistent on the host, in a grid with every other machine you own, from any browser including the one in your pocket.',
      ],
      choose: {
        spawnd: [
          "The work is shells, agents, and logs",
          "Hosts are headless or should be",
          "Phones must be genuinely usable",
          "The fleet belongs in one view",
        ],
        other: {
          title: "Use remote desktop when",
          items: [
            "The work is genuinely graphical",
            "You're supporting someone else's screen",
            "One machine's full desktop is the target",
            "A GUI app has no terminal equivalent",
          ],
        },
      },
    },
    faq: [
      {
        q: "Isn't RustDesk also end-to-end encrypted and self-hostable?",
        a: "Yes — RustDesk's encryption and self-hosted relay are real strengths, and this page doesn't pretend otherwise. The comparison is the unit of work: it ships screens, spawnd ships terminal sessions, and for terminal work the session is the better primitive on every axis from bandwidth to phones to persistence.",
      },
      {
        q: "Can I run a terminal inside a remote desktop session?",
        a: "Of course — that's how many people work today. You're paying video bandwidth and latency to move text, the host must keep a desktop rendered, and the session still dies with the stream. It works; it's just the long way round.",
      },
      {
        q: "What about the occasional GUI need on a spawnd host?",
        a: "Keep a remote desktop tool beside spawnd for it — they coexist fine. The point isn't that pixels are bad; it's that terminals shouldn't ride them.",
      },
    ],
    related: [
      {
        title: "spawnd vs SSH + tmux",
        blurb: "the text-native classic, compared",
        href: "/spawnd-vs-ssh-and-tmux",
      },
      {
        title: "Web terminal for a home server",
        blurb: "the headless box, reached as text",
        href: "/use/web-terminal-for-your-home-server",
      },
      {
        title: "Claude Code on your phone",
        blurb: "what a phone-shaped terminal actually looks like",
        href: "/claude-code-on-your-phone",
      },
      {
        title: "Run agents in parallel",
        blurb: "the grid a desktop stream can't show",
        href: "/run-agents-in-parallel",
      },
    ],
    cardTitle: "vs remote desktop",
    cardBlurb: "Pixels versus text — and why terminals shouldn't ride video.",
  },
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
    capture: {
      caption:
        "The other shape: agents from three hosts in one grid, each the real terminal, with nothing in the middle that stores what it carries.",
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
        title: "Claude Code on your phone",
        blurb: "what the terminal shape looks like on a phone",
        href: "/claude-code-on-your-phone",
      },
      {
        title: "spawnd vs mobile SSH apps",
        blurb: "the other way people reach a phone terminal today",
        href: "/spawnd-vs-mobile-ssh-apps",
      },
      {
        title: "Coding agents on your phone",
        blurb: "the hub for every agent, every device",
        href: "/coding-agents-on-your-phone",
      },
    ],
    cardTitle: "spawnd vs Happy",
    cardBlurb: "A chat app through an encrypted relay, versus the real terminal, peer-to-peer.",
  },
];
