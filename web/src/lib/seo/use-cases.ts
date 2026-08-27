import type { SeoPage } from "./types";

/*
 * Use-case pages: one page per job a searcher is trying to get done. Every
 * claim on these pages survives a diff against docs/TRUST.md and the README —
 * end-to-end encryption browser-to-daemon, outbound-only hosts, sessions that
 * survive daemon restarts, agent credentials that never leave the host.
 */

export const USE_CASES: SeoPage[] = [
  {
    family: "use",
    slug: "claude-code-on-your-phone",
    title: "Run Claude Code from your phone",
    description:
      "Start, steer, and review Claude Code sessions from your phone’s browser. The agent runs on your machine at home; the session survives every disconnect.",
    eyebrow: "Use case",
    h1: { plain: "Run Claude Code", accent: "from your phone." },
    lede: "The agent runs on your machine — your dev box, your home server, your GPU rig. Your phone is just a window onto it. Close the tab at dinner, reopen it on the couch: the session is exactly where you left it, scrollback intact.",
    sections: [
      {
        kind: "grid",
        eyebrow: "Why this works",
        heading: { plain: "A real terminal,", accent: "not a remote screen." },
        lede: "spawnd doesn’t stream video of a desktop. Your phone gets a first-class terminal, sized for the glass it’s on.",
        items: [
          {
            title: "The session lives on the host",
            body: "Claude Code runs in a real login shell on your machine. Your phone attaches to it and detaches from it; the work never depends on the phone staying awake.",
          },
          {
            title: "Built for the small screen",
            body: "spawnd is an installable web app with a terminal that respects the virtual keyboard, reflows on rotate, and keeps touch scrolling and copy working like they should.",
          },
          {
            title: "Survives the walk to the train",
            body: "Networks drop; sessions don’t. The daemon’s workers own the terminal, so a lost connection — or even a daemon restart — costs you nothing but the reconnect.",
          },
          {
            title: "End-to-end encrypted",
            body: "Terminal traffic is encrypted from your phone’s browser to the daemon on your host. The server that introduces them cannot read a byte of it — by architecture, not policy.",
          },
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "Three steps to a pocket terminal." },
        items: [
          {
            title: "Possess the machine",
            body: "Run one command on the host where Claude Code should live. The daemon dials out to the server — no inbound ports, no VPN, no router config.",
          },
          {
            title: "Approve your phone",
            body: "Open spawnd in your phone’s browser and confirm a short pairing code. One approval admits the device to every machine you own.",
          },
          {
            title: "Summon the agent",
            body: "Open a session and tap the Claude Code shortcut. It types the visible claude command into your shell — your login, your config, your subscription, untouched.",
          },
        ],
        installCommand: true,
      },
      {
        kind: "prose",
        eyebrow: "The honest part",
        heading: { plain: "What a phone is actually for." },
        paragraphs: [
          "Nobody writes a module on a phone, and we won’t pretend you will. What you actually do from a phone: kick off a long task before you leave, answer the permission prompt the agent has been waiting on, read the diff it produced, and tell it to keep going. That loop is the whole job, and a phone does it perfectly when the terminal underneath is real.",
          "When you’re back at a desk, the same session is waiting in the same browser app — bigger glass, same scrollback, nothing to re-establish.",
        ],
      },
    ],
    faq: [
      {
        q: "Do I need to install an app on my phone?",
        a: "No. spawnd runs in the browser and can be installed to your home screen as a web app. Your phone needs a browser; the machine running Claude Code needs the daemon.",
      },
      {
        q: "What happens to the session when my phone loses signal?",
        a: "Nothing. The session runs on your host, owned by a worker process there. When your phone reconnects, it reattaches to the live session with scrollback intact.",
      },
      {
        q: "Does my Anthropic login or API key go through spawnd’s servers?",
        a: "Never. Claude Code runs on your machine with the credentials already on it. spawnd’s server carries introductions and encrypted traffic it cannot read — it never holds agent credentials.",
      },
      {
        q: "Can I use an agent other than Claude Code?",
        a: "Yes. Codex, OpenCode, Aider, and any custom CLI are launchable the same way — an agent in spawnd is a visible command shortcut, not a lock-in.",
      },
    ],
    related: ["use/keep-agents-running", "for/claude-code", "use/ai-agents-on-your-own-gpu"],
    cardTitle: "Claude Code on your phone",
    cardBlurb: "Steer sessions from the couch; the agent never leaves your machine.",
  },

  {
    family: "use",
    slug: "ai-agents-on-your-own-gpu",
    title: "Run AI coding agents on your own GPU",
    description:
      "Put coding agents on the GPU rig you already own and reach them from any browser. No cloud dev environment, no per-seat platform — your hardware, possessed.",
    eyebrow: "Use case",
    h1: { plain: "Your agents, on", accent: "your own GPU." },
    lede: "You already own the best machine you can rent. spawnd puts a daemon on it, and every browser you trust becomes a terminal into it — the models, the checkpoints, the CUDA setup you spent a weekend on, reachable from anywhere without exposing a port.",
    sections: [
      {
        kind: "grid",
        eyebrow: "Why your hardware",
        heading: { plain: "The rig stays home.", accent: "The reach doesn’t." },
        items: [
          {
            title: "No egress bills, no idle meters",
            body: "Cloud dev boxes bill while you think. Your own machine costs what it always cost, and the agents running on it use the local toolchain — drivers, models, data — that already works.",
          },
          {
            title: "Outbound-only networking",
            body: "The daemon dials out and holds the line. Your rig needs no public IP, no port forward, no VPN — nothing for a scanner to find.",
          },
          {
            title: "One browser, every machine",
            body: "The GPU rig, the NAS, the office workstation: each runs a daemon, all of them line up in one sidebar. Sessions from different hosts sit side by side in one workspace grid.",
          },
          {
            title: "The server can’t see your work",
            body: "Terminal traffic is end-to-end encrypted between your browser and your rig. The coordinating server introduces the two and then goes deaf — it has no code path for terminal content.",
          },
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "From bare metal to summoned agent." },
        items: [
          {
            title: "Possess the rig",
            body: "One command installs the daemon and pairs it to your account. It runs as a user service and reconnects on boot.",
          },
          {
            title: "Open a session",
            body: "From any approved browser, start a shell in the directory you care about. It’s your login shell, on your machine, with your environment.",
          },
          {
            title: "Launch what you like",
            body: "Claude Code, Codex, Aider, OpenCode — or the custom entry point for your own stack. Agent shortcuts type visible commands; nothing runs behind your back.",
          },
        ],
        installCommand: true,
      },
      {
        kind: "split",
        eyebrow: "Against the alternative",
        heading: { plain: "Own the box.", accent: "Skip the platform." },
        lede: "Cloud dev environments solve provisioning. If your machine already exists, they mostly add distance.",
        left: {
          title: "Your GPU + spawnd",
          tone: "bone",
          items: [
            "Hardware you already paid for, at full speed",
            "Local models, checkpoints, and data stay local",
            "Agents authenticate on the box; keys never travel",
            "Sessions persist on the host between visits",
          ],
        },
        right: {
          title: "A rented dev environment",
          tone: "ash",
          items: [
            "GPU time billed by the hour, idle or not",
            "Your data uploaded to someone else’s disk",
            "Credentials provisioned into a remote platform",
            "Fine when you have no hardware — that’s its honest use",
          ],
        },
      },
    ],
    faq: [
      {
        q: "Does spawnd schedule or manage GPU workloads?",
        a: "No. spawnd gives you terminals on your machines. What you run in them — training scripts, inference servers, coding agents — is your shell’s business, same as if you were sitting at the box.",
      },
      {
        q: "Can I reach the same rig from my laptop and my phone?",
        a: "Yes. Approve each device once and it can reach every host you own. Sessions live on the rig, so any device attaches to the same live terminal.",
      },
      {
        q: "What does the coordinating server see?",
        a: "Metadata only: which hosts exist, when they’re online, that sessions started and stopped. Terminal content is end-to-end encrypted past it, and when NAT forces a relay, the relay carries ciphertext it cannot decrypt.",
      },
      {
        q: "Can I self-host the whole thing?",
        a: "Yes. spawnd is open source under MIT/Apache-2.0 — the daemon, the server, and the web app. If even encrypted introductions are too much trust, run the introducer yourself.",
      },
    ],
    related: ["use/web-terminal-for-your-home-server", "vs/coder", "use/claude-code-on-your-phone"],
    cardTitle: "Agents on your own GPU",
    cardBlurb: "The rig you own, reachable from any browser, with no open ports.",
  },

  {
    family: "use",
    slug: "web-terminal-for-your-home-server",
    title: "Web terminal for your home server",
    description:
      "A browser terminal for the server in your closet — no port forwarding, no VPN, no exposed SSH. The daemon dials out; you reach it from anywhere.",
    eyebrow: "Use case",
    h1: { plain: "A web terminal for the", accent: "server in your closet." },
    lede: "The machine is three metres away and somehow unreachable from the sofa. spawnd fixes the distance without opening a door: the daemon on your server dials out, and any browser you’ve approved gets a real terminal into it — from the sofa, the office, or another country.",
    sections: [
      {
        kind: "grid",
        eyebrow: "The mechanism",
        heading: { plain: "Nothing reaches in.", accent: "The daemon reaches out." },
        items: [
          {
            title: "Zero inbound surface",
            body: "No port forward on the router, no dynamic DNS, no SSH exposed to the internet’s background radiation. The daemon makes an outbound connection and keeps it warm.",
          },
          {
            title: "A real shell, not a widget",
            body: "Sessions start your login shell in a directory you choose. htop, journalctl, docker compose, your dotfiles — everything behaves, because it is a PTY, not an emulation of one.",
          },
          {
            title: "Sessions that outlive the visit",
            body: "Start a migration, close the laptop, check it from your phone at lunch. Worker processes on the host own each session, so it runs — and keeps scrollback — whether anyone is watching or not.",
          },
          {
            title: "Encrypted past the middleman",
            body: "Your keystrokes travel encrypted from browser to daemon. The coordinating server can prove the introduction happened; it cannot repeat what was said.",
          },
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "Closet to browser in a minute." },
        items: [
          {
            title: "Run the one-liner on the server",
            body: "The installer fetches the daemon, registers it as a user service, and walks the pairing. Debian in a closet, a Pi on a shelf, a Mac mini under the TV — Linux and macOS, x86 and ARM.",
          },
          {
            title: "Verify the pairing",
            body: "You approve the machine against a short code shown on both sides, so what joined your account is provably the box you just touched.",
          },
          {
            title: "Open the terminal",
            body: "The host appears in your sidebar. Click it, get a shell, pin the session to a workspace grid next to the others.",
          },
        ],
        installCommand: true,
      },
      {
        kind: "prose",
        eyebrow: "The honest part",
        heading: { plain: "When SSH is still the answer." },
        paragraphs: [
          "If you’re on the same LAN, with keys set up and a terminal you love, ssh is right there and it’s excellent. spawnd earns its place when the sofa is not on the LAN: phones, hotel wifi, the office, and every network where inbound SSH would mean a port forward you’d rather not own or a VPN you’d rather not babysit.",
          "It also earns it the day you have more than one machine. Hosts accumulate — a server, a rig, an old laptop with one job. spawnd lines them up in one place, one identity, one approval per device, instead of an ssh config that only you can read.",
        ],
      },
    ],
    faq: [
      {
        q: "Do I need to open any ports on my router?",
        a: "No. The daemon on your server makes outbound connections only. There is nothing to forward and nothing for an internet scan to discover.",
      },
      {
        q: "What operating systems does the daemon run on?",
        a: "Linux and macOS, on x86_64 and ARM — prebuilt binaries for all four, installed by one command. A Raspberry Pi qualifies.",
      },
      {
        q: "Is this a VPN?",
        a: "No. A VPN puts your device on the machine’s network. spawnd gives you a terminal on the machine itself — narrower on purpose, with nothing else exposed in the process.",
      },
      {
        q: "What if my home IP changes?",
        a: "Nothing changes for you. The daemon dials out, so it follows whatever route exists; there’s no address to keep updated and no dynamic-DNS dance.",
      },
    ],
    related: ["use/remote-access-without-open-ports", "vs/ssh-and-tmux", "use/keep-agents-running"],
    cardTitle: "Web terminal for a home server",
    cardBlurb: "The closet machine, reachable from the sofa and beyond. No port forwards.",
  },

  {
    family: "use",
    slug: "remote-access-without-open-ports",
    title: "Remote terminal access without open ports",
    description:
      "Reach every machine you own from a browser while their firewalls stay sealed. Outbound-only daemons, end-to-end encryption, and pairing you can verify.",
    eyebrow: "Use case",
    h1: { plain: "Remote access.", accent: "Zero open ports." },
    lede: "Every open port is a promise you have to keep forever. spawnd makes none: the daemon on each machine dials out to the control plane and holds the line, your browser does the same, and the two meet in an encrypted channel the middleman can’t read. Nothing listens. Nothing is exposed. Nothing needs patching against the whole internet.",
    sections: [
      {
        kind: "grid",
        eyebrow: "The security posture",
        heading: { plain: "Sealed by default,", accent: "verifiable by hand." },
        items: [
          {
            title: "Outbound-only, both ends",
            body: "Hosts and browsers both dial out. Your firewall rules can stay exactly as they are: deny inbound, allow outbound, done.",
          },
          {
            title: "End-to-end encrypted terminals",
            body: "Terminal traffic rides encrypted channels negotiated directly between browser and daemon. When NAT forces a relay, the relay forwards ciphertext it cannot decrypt.",
          },
          {
            title: "Possession you can audit",
            body: "Every device is admitted by an explicit approval you can verify with a short code on both screens. Every admission is revocable — one click and the socket dies.",
          },
          {
            title: "A server we built to distrust",
            body: "The threat model names our own control plane as an adversary. It introduces endpoints and carries metadata; there is no code path through it for terminal content. It’s open source — check.",
          },
        ],
      },
      {
        kind: "table",
        eyebrow: "Against the usual doors",
        heading: { plain: "Ways in, compared." },
        lede: "Each of these works. Each keeps a different kind of promise.",
        columns: ["spawnd", "The usual door"],
        rows: [
          {
            label: "Exposed surface",
            a: "None — outbound connections only",
            b: "SSH port, VPN endpoint, or reverse-proxy — something listens",
          },
          {
            label: "Who can read the session",
            a: "The two endpoints; the relay sees ciphertext",
            b: "SSH: endpoints. Reverse-proxied web tools: the proxy, unless you build otherwise",
          },
          {
            label: "New device setup",
            a: "Sign in, approve once against a short code",
            b: "Distribute keys or VPN profiles to each device by hand",
          },
          {
            label: "If the machine’s IP changes",
            a: "Irrelevant — the daemon dials out",
            b: "Dynamic DNS, or a broken bookmark",
          },
          {
            label: "Revoking a lost device",
            a: "One click; every host refuses it",
            b: "Rotate keys or revoke certs on every machine it touched",
          },
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "Seal the perimeter. Keep the access." },
        items: [
          {
            title: "Install outbound-only daemons",
            body: "One command per machine. Nothing in your firewall changes.",
          },
          {
            title: "Approve your devices once",
            body: "Each browser or phone is admitted by an explicit, verifiable approval — and that one approval reaches every host you own.",
          },
          {
            title: "Retire the old doors",
            body: "Close the port forwards, drop the exposed SSH, keep the VPN for what actually needs a network. Terminals no longer do.",
          },
        ],
        installCommand: true,
      },
    ],
    faq: [
      {
        q: "How do machines connect without any inbound ports?",
        a: "The daemon opens an outbound connection to the control plane and keeps it alive. Terminal channels are then negotiated end-to-end between your browser and the daemon over that introduction, using WebRTC with a ciphertext-only relay as fallback.",
      },
      {
        q: "Is this more secure than exposing SSH with keys?",
        a: "SSH with keys is cryptographically sound; its cost is an internet-facing listener you must patch and monitor forever, on every machine. spawnd removes the listener entirely and moves admission to one verifiable per-device approval.",
      },
      {
        q: "What if I don’t trust your server?",
        a: "Good. The design assumes you don’t: terminal content is end-to-end encrypted past it, endpoint keys are pinned so a tampering introducer is caught, and the whole stack is open source and self-hostable.",
      },
      {
        q: "Does it work behind CGNAT or strict corporate NAT?",
        a: "Yes. Both sides dial out, so ordinary NAT traversal covers most networks; the ones it can’t are carried by the encrypted relay, which never sees plaintext.",
      },
    ],
    related: ["vs/tailscale-ssh", "use/web-terminal-for-your-home-server", "vs/ssh-and-tmux"],
    cardTitle: "No open ports",
    cardBlurb: "Sealed firewalls, reachable terminals, and admissions you can verify.",
  },

  {
    family: "use",
    slug: "keep-agents-running",
    title: "Keep coding agents running when you step away",
    description:
      "Close the laptop; the agent keeps working. Sessions live on your hosts, survive disconnects and daemon restarts, and reattach with scrollback intact.",
    eyebrow: "Use case",
    h1: { plain: "Close the lid.", accent: "The agent keeps working." },
    lede: "An agent mid-refactor shouldn’t depend on your laptop staying open, your wifi staying up, or your terminal app staying alive. With spawnd, the session is a process on the host — your browser only visits it. Leave whenever you like; it doesn’t notice.",
    sections: [
      {
        kind: "grid",
        eyebrow: "The mechanism",
        heading: { plain: "Sessions are", accent: "revenants." },
        lede: "Each session is owned by a dedicated worker process on the host — not by your browser tab, and not even by the daemon that spawned it.",
        items: [
          {
            title: "The tab is disposable",
            body: "Closing the browser closes a window, not a session. Reopen from any approved device and reattach to the live terminal, scrollback included.",
          },
          {
            title: "Even the daemon can die",
            body: "Kill the daemon mid-session, restart it, and the worker is re-adopted with the session intact. Updates and crashes on the host cost you a blink, not a run.",
          },
          {
            title: "Scrollback is committed history",
            body: "What the agent printed while you were gone is there when you return — real emulator-committed lines, not a lossy tail of whatever the network kept.",
          },
          {
            title: "Check in from anything",
            body: "The session that started from your desk reattaches from your phone. Same terminal, same history, one approval per device.",
          },
        ],
      },
      {
        kind: "prose",
        eyebrow: "Why it matters now",
        heading: { plain: "Agents made persistence the default need." },
        paragraphs: [
          "Terminal sessions used to be short: run the command, read the output, leave. Coding agents inverted that. A single prompt can mean twenty minutes of edits, builds, and retries — and the interesting moments (a permission prompt, a failed test, a finished diff) arrive on the agent’s schedule, not yours.",
          "tmux solved detachable sessions for the SSH world, and solved it well. spawnd makes that behaviour the substrate instead of a tool you remember to use: every session is detachable, from every device, with the encryption and the pairing handled — nothing to wrap, nothing to forget before you close the lid.",
        ],
      },
      {
        kind: "steps",
        eyebrow: "The ritual",
        heading: { plain: "Start it. Leave it. Reclaim it." },
        items: [
          {
            title: "Start the run",
            body: "Open a session on the host, summon your agent, give it the task.",
          },
          {
            title: "Walk away",
            body: "Close the tab, sleep the laptop, board the flight. The worker on the host owns the run.",
          },
          {
            title: "Reattach anywhere",
            body: "From your phone or the next machine: the same session, the full scrollback, the agent’s question waiting at the prompt.",
          },
        ],
        installCommand: true,
      },
    ],
    faq: [
      {
        q: "Does the agent pause when I disconnect?",
        a: "No. The agent is a process on the host, attached to a PTY owned by a host-side worker. It runs identically whether zero or three devices are watching.",
      },
      {
        q: "How much output history do I get back when I reattach?",
        a: "The session’s committed scrollback — the lines the terminal emulator on the host actually rendered — streams back to any device that attaches, not just a recent fragment.",
      },
      {
        q: "What happens if the host reboots?",
        a: "A reboot ends processes, spawnd’s included — no tool can keep a dead machine computing. The daemon comes back with the machine and your hosts reappear; sessions survive daemon restarts, not host power cycles.",
      },
      {
        q: "Is this just tmux with extra steps?",
        a: "It’s tmux’s best idea — sessions that outlive attachments — made the default for every session, plus the parts tmux never claimed: browser and phone access, per-device approval, end-to-end encryption, and no SSH exposure to get there.",
      },
    ],
    related: ["use/claude-code-on-your-phone", "vs/ssh-and-tmux", "use/ai-agents-on-your-own-gpu"],
    cardTitle: "Agents that keep running",
    cardBlurb: "Sessions live on the host and reattach anywhere, scrollback intact.",
  },
];
