import type { ArticleEntry } from "../flat-types";

/*
 * Fix pages and essays (grimoire §iv–v): Tailscale stuck on starting, vibe
 * coding vs traditional, mosh vs SSH. Pure data on the article template;
 * see definitions.ts for the exemplar.
 *
 * Facts checked 2026-09-03 against:
 *   Tailscale —
 *   https://tailscale.com/docs/reference/tailscale-cli (status, up, login,
 *     logout, netcheck, bugreport, ping, set, dns status ≥1.76)
 *   https://tailscale.com/docs/reference/tailscaled (systemctl verbs,
 *     `net stop|start Tailscale`, tailscaled.state, log locations,
 *     `tailscale debug daemon-logs`)
 *   https://tailscale.com/kb/1082/firewall-ports (TCP 443 to the control
 *     plane and DERP, UDP 41641, STUN 3478, hostnames)
 *   https://tailscale.com/kb/1028/key-expiry (180-day default, Disable key
 *     expiry, Temporarily extend key, `up --force-reauth`)
 *   https://tailscale.com/kb/1065/macos-variants and
 *   https://tailscale.com/kb/1080/cli (three macOS variants; App Store CLI
 *     at /Applications/Tailscale.app/Contents/MacOS/Tailscale)
 *   https://tailscale.com/kb/1105/other-vpns (VPN firewall rules; one VPN
 *     at a time on iOS/Android)
 *   https://tailscale.com/docs/reference/messages/client/network-status
 *   https://tailscale.com/docs/reference/glossary (admin console)
 *   github.com/tailscale/tailscale: ipn/backend.go and ipnstate.Status
 *     (BackendState values), cmd/tailscale/cli/{status,up,set,netcheck,
 *     bugreport,ping}.go (printed strings and flag help), issues #14966,
 *     #16783, #17875, #7497, #9220
 *   https://gordonbeeming.com/blog/2026-01-12/tailscale-stuck-on-starting-503-fix
 *   https://www.allthethings.dev/blog/fixing-tailscale-stuck-on-starting-windows-10-docker-hyper-v
 *   Vibe coding —
 *   https://en.wikipedia.org/wiki/Vibe_coding (Karpathy's 2025-02-02 post,
 *     Merriam-Webster March 2025)
 *   https://x.com/karpathy/status/2019137879310836075 (his retrospective)
 *   https://blog.collinsdictionary.com/language-lovers/collins-word-of-the-year-2025-ai-meets-authenticity-as-society-shifts/
 *   https://simonwillison.net/2025/Mar/6/vibe-coding/ and
 *   https://simonwillison.net/2025/Oct/7/vibe-engineering/
 *   https://thenewstack.io/vibe-coding-is-passe/ (agentic engineering)
 *   https://www.businesswire.com/news/home/20250730694951/en/ (Veracode
 *     2025 GenAI Code Security Report: 80 tasks, 100+ models, 45%)
 *   https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/
 *   https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
 *   mosh —
 *   https://mosh.org/ (SSP, UDP 60000–61000 from 60001, AES-128 OCB,
 *     heartbeat, roaming rule, underlined predictions, visible-state-only
 *     scrollback, `Ctrl-^ .`, `-p`, `--ssh`, 1.4.0 of 2022-10-31)
 *   https://github.com/mobile-shell/mosh (README: no X forwarding or
 *     non-interactive uses including port forwarding)
 *   https://manpages.debian.org/testing/mosh/mosh.1.en.html (--predict)
 *   https://github.com/mobile-shell/mosh/issues/120 and pull/696 (agent
 *     forwarding never merged)
 *   https://github.com/MisterTea/EternalTerminal (TCP 2022, ssh handshake,
 *     native scrolling, tmux -CC, `-t` tunnels, /etc/et.cfg)
 *   https://man.openbsd.org/ssh_config (ServerAliveInterval/CountMax)
 *   https://linux.die.net/man/1/autossh (`-M 0`)
 *   https://blink.sh/ and https://docs.termius.com/ (mosh clients)
 * Not verifiable, so not stated: what the GUI shows at key expiry; whether
 * a re-registered machine keeps its Tailscale IP; mosh's `experimental`
 * prediction mode (not in the man page fetched).
 */

export const FIXES_AND_ESSAYS: ArticleEntry[] = [
  {
    slug: "tailscale-stuck-on-starting",
    kind: "fix",
    hub: { name: "Guides", href: "/guides" },
    title: "Tailscale stuck on “Starting…”: causes and fixes",
    description:
      "What Tailscale’s “Starting…” state is waiting for, the six causes behind it, and the fixes in order — from netcheck to clearing a stale tailscaled state.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Tailscale stuck on",
      accent: "“Starting…”",
      sub: "What the client is waiting for, how to find out which wait it is, and the fixes in the order that costs you the least.",
    },
    body: [
      {
        kind: "prose",
        heading: "What “Starting…” actually means.",
        paragraphs: [
          "The Tailscale client is a small state machine and the menu bar shows you one word of it. The daemon, `tailscaled`, is in one of `NoState`, `NeedsLogin`, `NeedsMachineAuth`, `Stopped`, `Starting`, or `Running`. NeedsLogin means no valid login for this machine; Running means the tunnel is up and the network map has arrived. Everything between — reaching the coordination server over HTTPS, fetching the map, bringing up the tunnel interface — happens under “Starting…”. A client that sits there is stuck on one of those steps, or the app can’t talk to `tailscaled` at all, which looks identical from the icon.",
          "So ask the daemon, not the icon. `tailscale status` prints “Logged out.” and a login URL when the real state is NeedsLogin, “Tailscale is stopped.” for Stopped, and otherwise the state name or the peer table; `--json` carries it as `BackendState`. On the Mac App Store build the CLI lives at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; the Standalone build can install `tailscale` into `/usr/local/bin` from its settings.",
        ],
        code: {
          caption: "The daemon’s own word for it",
          lines: ["tailscale status", "tailscale status --json | grep BackendState"],
        },
      },
      {
        kind: "points",
        heading: "The usual causes.",
        lead: "Six things account for nearly every report on GitHub and the forums.",
        items: [
          {
            title: "The app can’t reach tailscaled",
            body: "On Windows, `tailscale login` answering “503 Service Unavailable: no backend” means the service runs but its state is unreadable — a power loss or a Windows update is the usual culprit ([#16783](https://github.com/tailscale/tailscale/issues/16783)). On any OS, “failed to connect to local tailscaled” means the daemon isn’t running at all.",
          },
          {
            title: "The coordination server is unreachable",
            body: "The client needs outbound TCP 443 to `controlplane.tailscale.com` and `login.tailscale.com`; the DERP relays speak HTTPS on 443 too. A captive portal, a corporate proxy, or another VPN’s kill switch — “most VPNs set aggressive firewall rules to ensure all network traffic goes through them”, in [Tailscale’s words](https://tailscale.com/kb/1105/other-vpns) — holds the client at Starting indefinitely.",
          },
          {
            title: "UDP is blocked",
            body: "Direct connections use UDP from port 41641 and STUN on UDP 3478. Blocked UDP alone shouldn’t stop Starting, since DERP falls back over 443 — but a network that blocks UDP usually blocks more.",
          },
          {
            title: "The node key has expired",
            body: "Keys expire after 180 days by default, and then “connections to/from the given endpoint will stop working”. The fix is a re-authentication, or an admin disabling expiry for that machine in the admin console — what most people mean by the Tailscale admin panel.",
          },
          {
            title: "Stale daemon state",
            body: "`tailscaled` keeps its identity in `/var/lib/tailscale/tailscaled.state` on Linux and under `C:\\ProgramData\\Tailscale` on Windows. Corrupt it and the daemon starts, loads garbage, and never gets further; the Windows 11 25H2 upgrade leaving clients at “401 Unauthorized” ([#17875](https://github.com/tailscale/tailscale/issues/17875)) is the same family.",
          },
          {
            title: "The platform itself",
            body: "Windows needs the Wintun-based “Tailscale Tunnel” adapter; Docker Desktop, Hyper-V, and old VPN drivers can corrupt the network stack so it never appears. macOS has three builds — App Store, Standalone, and Homebrew `tailscaled` — and the App Store one has a known [start-at-login hang](https://github.com/tailscale/tailscale/issues/7497) that quitting and reopening clears.",
          },
        ],
      },
      {
        kind: "steps",
        heading: "The fixes, in order.",
        lead: "Cheapest first. Stop when the state flips to Running.",
        steps: [
          {
            title: "Read the network",
            body: "`tailscale netcheck` prints `UDP:`, `IPv4:`, `IPv6:`, `CaptivePortal:`, `Nearest DERP:`, and `DERP latency:`. No DERP latencies at all means 443 outbound is blocked or a captive portal is in the way; `UDP: false` means you’ll relay — slow, not stuck. Once connected, `tailscale ping <machine>` says whether each reply came direct or via DERP.",
            code: { lines: ["tailscale netcheck", "tailscale ping my-server"] },
          },
          {
            title: "Restart the daemon and read its log",
            body: "Linux below. Windows, in an administrator prompt: `net stop Tailscale` then `net start Tailscale`; logs are under `C:\\ProgramData\\Tailscale\\Logs`. macOS App Store or Standalone: quit from the menu bar icon and reopen. Homebrew: `sudo brew services restart tailscale`. On any OS, `tailscale debug daemon-logs` streams the daemon’s log live.",
            code: {
              lines: [
                "sudo systemctl restart tailscaled",
                'journalctl -u tailscaled --since "10 min ago"',
              ],
            },
          },
          {
            title: "Re-authenticate",
            body: "`tailscale logout` then `tailscale up` gets a fresh login URL; `tailscale up --force-reauth` does it in one step, with Tailscale’s own warning that it “may bring down the Tailscale connection” — don’t run it over SSH to the machine you’re fixing. If the key expired while you were away, an admin can use “Temporarily extend key” on the Machines page for a 30-minute window, then “Disable key expiry” if the box is meant to live forever.",
            code: { lines: ["tailscale logout", "tailscale up"] },
          },
          {
            title: "Clear stale state",
            body: "Stop the daemon, move its state aside, start it, and log in again. The device comes back as a new machine, so delete the old entry on the [Machines page](https://login.tailscale.com/admin/machines) afterwards. Linux and Windows below; on macOS, uninstalling and reinstalling the app is the equivalent.",
            code: {
              caption: "Linux, then Windows PowerShell as administrator",
              lines: [
                "sudo systemctl stop tailscaled",
                "sudo mv /var/lib/tailscale/tailscaled.state /var/lib/tailscale/tailscaled.state.bak",
                "sudo systemctl start tailscaled && sudo tailscale up",
                "",
                "Stop-Service Tailscale -Force",
                "Rename-Item -Path 'C:\\ProgramData\\Tailscale' -NewName 'Tailscale.bak'",
                "Start-Service Tailscale; tailscale up --force-reauth",
              ],
            },
          },
          {
            title: "Rebuild the Windows adapter",
            body: "If Network Connections shows no “Tailscale Tunnel” adapter after all of the above, the network stack itself is damaged. The [recovery that works](https://www.allthethings.dev/blog/fixing-tailscale-stuck-on-starting-windows-10-docker-hyper-v) is to uninstall Tailscale, run `netsh winsock reset`, `netsh int ip reset`, and `netcfg -d` as administrator, reboot, and reinstall. `netcfg -d` wipes every adapter’s configuration, so expect to re-enter Wi-Fi passwords.",
          },
          {
            title: "Rule out DNS, then file it",
            body: "If the state reaches Running but names don’t resolve, the problem was never Starting: check `tailscale dns status` and try `tailscale set --accept-dns=false`. If nothing above moved the needle, `tailscale bugreport --diagnose` prints a marker that support or a GitHub issue can pull logs from.",
            code: { lines: ["tailscale dns status", "tailscale bugreport --diagnose"] },
          },
        ],
      },
      {
        kind: "prose",
        heading: "Fix it and stay — unless the job was only ever a terminal.",
        paragraphs: [
          "A tailnet is a good answer to “my devices should share a network”, and one afternoon of Starting… doesn’t change that. If you reach a NAS’s web UI, a printer, and a handful of TCP services over it, get it Running and move on.",
          "The structural question is narrower. If the reason you have a tailnet is to reach your own terminals — an agent grinding on a build box, a shell on the Mac mini — every step above is the cost of a network built to carry one thing. The other design skips the network: a daemon on each host that only dials out, nothing listening, no client on the device, a browser as the terminal. That’s [spawnd](/spawnd-vs-tailscale-ssh). Sessions live on the host and survive the closed tab and the dropped connection, a new device is approved once against a short code, and your browser talks to each daemon peer-to-peer, end-to-end encrypted. Plenty of people run both — Tailscale for the network, spawnd for the terminals — and neither has to be Starting for the other to work.",
        ],
      },
    ],
    start: "Reach your terminals without a tailnet at all.",
    faq: [
      {
        q: "Why does the app say Starting… when tailscale status says Logged out?",
        a: "Because the app is showing you its own guess and the CLI is showing you the daemon’s state. “Logged out.” means NeedsLogin: run `tailscale up` and open the URL it prints, and the icon will follow.",
      },
      {
        q: "Will clearing tailscaled.state lose anything?",
        a: "It discards the machine’s identity, so the device re-registers as a new machine and needs a fresh login. Remove the stale entry from the Machines page afterwards, and re-apply anything that was attached to the old one.",
      },
      {
        q: "Does spawnd replace Tailscale?",
        a: "No. Tailscale builds a private network; spawnd delivers terminals from hosts that dial out, with no network built at all. If you need the network, keep it. If you only needed the terminals, you can skip it — and the two run side by side without conflict.",
      },
    ],
    related: [
      {
        title: "spawnd vs Tailscale SSH",
        blurb: "a private network versus a deaf channel — and why some run both",
        href: "/spawnd-vs-tailscale-ssh",
      },
      {
        title: "No open ports",
        blurb: "the outbound-only network model, in full",
        href: "/use/remote-access-without-open-ports",
      },
      {
        title: "Web terminal for your home server",
        blurb: "the box under the desk, reachable without a VPN",
        href: "/use/web-terminal-for-your-home-server",
      },
    ],
    cardTitle: "Tailscale stuck on Starting…",
    cardBlurb: "What the state means, six causes, and the fixes in cost order.",
  },

  {
    slug: "vibe-coding-vs-traditional-coding",
    kind: "explainer",
    hub: { name: "Guides", href: "/guides" },
    title: "Vibe coding vs traditional coding: an honest comparison",
    description:
      "Where the term came from, what vibe coding actually describes, where it works and where it breaks, what traditional coding has become, and the tradeoffs in a table.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "Vibe coding vs",
      accent: "traditional coding",
      sub: "The term is eighteen months old and already in two dictionaries. Here is what it describes, where it works, where it fails, and what the other side of the versus has quietly become.",
    },
    body: [
      {
        kind: "prose",
        heading: "Where the term came from.",
        paragraphs: [
          "On 2 February 2025 Andrej Karpathy posted that there was “a new kind of coding I call ‘vibe coding’, where you fully give in to the vibes, embrace exponentials, and forget that the code even exists.” The rest of the post is the definition that matters: “I ‘Accept All’ always, I don’t read the diffs anymore,” and it was “not too bad for throwaway weekend projects.” He later called it [a shower-thoughts throwaway](https://x.com/karpathy/status/2019137879310836075). It became a Merriam-Webster “slang & trending” entry within five weeks and [Collins’ Word of the Year](https://blog.collinsdictionary.com/language-lovers/collins-word-of-the-year-2025-ai-meets-authenticity-as-society-shifts/) that November, defined as “the use of artificial intelligence prompted by natural language to write computer code.”",
          "The dictionary definition is too wide, because by it every professional using a coding agent is vibe coding. The useful line is Simon Willison’s: “If an LLM wrote every line of your code but you’ve reviewed, tested and understood it all, that’s not vibe coding in my book — that’s using an LLM as a typing assistant.” Vibe coding is defined by what you don’t do. You don’t read it. You describe, run, paste the error back, and keep going while it mostly works.",
        ],
      },
      {
        kind: "prose",
        heading: "What traditional coding means now.",
        paragraphs: [
          "The other side of the versus moved while nobody was looking. Traditional coding used to mean a person typing every line and holding the whole system in their head, with autocompletion and a search engine as the tools. That version is already gone for most working developers. Agents write most of the lines; the person’s job is the parts around them — specifying what should exist, deciding the architecture, writing the tests the agent has to pass, reviewing what comes back, supervising several agents at once.",
          "Willison calls the disciplined form [vibe engineering](https://simonwillison.net/2025/Oct/7/vibe-engineering/) and lists what it leans on: automated tests, planning, documentation, version control, a review culture, manual QA — “almost all of these are characteristics of senior software engineers already.” Karpathy, on the term’s first anniversary, moved on to [agentic engineering](https://thenewstack.io/vibe-coding-is-passe/): you aren’t writing the code directly most of the time, you’re orchestrating the agents that do and acting as oversight. And the caution is real. METR’s [randomised trial](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) of sixteen experienced open-source developers on their own repositories found early-2025 tools made them 19% slower while they believed they were 20% faster. Traditional coding didn’t die. It became the review layer.",
        ],
      },
      {
        kind: "points",
        heading: "Where vibe coding works.",
        lead: "The honest list is short and the items on it are genuinely good.",
        items: [
          {
            title: "Prototypes and throwaways",
            body: "Karpathy’s own case. When the point is to see whether an idea holds — a screen, a flow, a demo for Friday — the code is scaffolding, and nobody reads scaffolding.",
          },
          {
            title: "Personal tools",
            body: "The script that renames the photos, the dashboard with one user, the bot that watches one feed. If it breaks you are the only casualty, and you fix it the way you built it.",
          },
          {
            title: "One-off glue",
            body: "Converting a CSV, calling an API once, migrating a folder. Work that runs a handful of times and is never maintained has no maintenance cost to hide.",
          },
          {
            title: "Learning by watching",
            body: "People who can read code but never wrote much get a working example of every idiom they ask for — a real on-ramp, as long as the reading happens.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "Where it fails.",
        paragraphs: [
          "It fails on security first, because the model doesn’t know which of two working versions is the safe one. Veracode’s [2025 report](https://www.businesswire.com/news/home/20250730694951/en/) ran 80 coding tasks across more than a hundred models and found that where a secure and an insecure way to write the code both existed, the models chose the insecure one 45% of the time — and newer, larger models did no better. Nobody reading the diffs means nobody catching the 45%.",
          "It fails on maintainability next; Willison’s warning is the plain version: “Vibe coding your way to a production codebase is clearly risky.” Most software work is changing something that already exists, and the tenth change to a codebase nobody understands is where the speed goes. And it fails hardest at the person who can’t read the output — not from carelessness, but because an agent will sometimes report success it didn’t achieve and there is no one to notice. In July 2025 a Replit agent [deleted a production database](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/) during a declared code freeze, then told its user a rollback was impossible. It wasn’t. The fault line isn’t AI versus human. It’s whether anyone in the loop can tell when it’s wrong.",
        ],
      },
      {
        kind: "table",
        heading: "The tradeoffs, side by side.",
        columns: ["", "Vibe coding", "Traditional coding, 2026 edition"],
        rows: [
          ["Who reads the code", "Nobody, by definition", "A person, before it merges"],
          ["Time to first working version", "Minutes", "Hours — the plan and the tests come first"],
          [
            "Time to the tenth change",
            "Grows with every change nobody understood",
            "Roughly constant",
          ],
          [
            "Security",
            "Whatever the model picked",
            "Whatever review, tests, and a threat model caught",
          ],
          [
            "When it breaks",
            "Paste the error back and hope",
            "Read the stack trace; you know where it lives",
          ],
          [
            "Best at",
            "Prototypes, personal tools, one-off glue",
            "Anything other people depend on",
          ],
          [
            "Fails at",
            "Production, data, other people’s money",
            "Nothing structural — it’s just slower",
          ],
          [
            "Skill it rewards",
            "Describing what you want, clearly",
            "Judgement: architecture, review, supervision",
          ],
          [
            "The tools",
            "Chat-first builders and agents on Accept All",
            "The same agents, plus a person who says no",
          ],
        ],
        note: "Both columns use the same models. The difference is a reader.",
      },
      {
        kind: "prose",
        heading: "The part both sides share: the agent has to run somewhere.",
        paragraphs: [
          "Whichever column you sit in, the agent lives on a machine, and the good ones live on a real computer with your project on it — a Mac at home, a box under the desk — not in a chat tab. The vibe coder’s actual workflow is to start the agent there and reach it from wherever they are, mostly a phone, to answer the question it stopped on. The honest routes are the vendors’ own web and mobile apps and the SSH-app-plus-tunnel setup; [Coding agents on your phone](/coding-agents-on-your-phone) teaches both.",
          "spawnd is that with no setup ceremony. One command on the machine that runs your agent; after that, any browser — your phone, installed to the home screen as a web app — is a window onto it. Nothing to open on your router, no VPN, no app to install. The session keeps running when you close the tab or the laptop lid, scrollback and all, and your phone gets a notification when the agent is waiting on a yes. Claude Code, Codex, OpenCode, and Aider are built in and sign in on the machine exactly as they always do — your subscription works as the vendor’s own tool uses it, nothing added on top. [Claude Code on your phone](/claude-code-on-your-phone) shows a day run that way, and [the agents roundup](/best-ai-coding-agents) is where to start if you haven’t picked one.",
        ],
      },
    ],
    start: "One box, one command, every device a window.",
    faq: [
      {
        q: "Is vibe coding bad?",
        a: "Not for the things it is for — prototypes, personal tools, one-off scripts. It becomes a problem the moment other people, their data, or their money depend on code nobody read.",
      },
      {
        q: "Do I need to know how to code to vibe code?",
        a: "No, and that is both the point and the risk. You can ship a working thing without reading a line; you just can’t tell when the agent is wrong, which is fine for a weekend project and not fine for a production one.",
      },
      {
        q: "Does spawnd make vibe coding safer?",
        a: "It doesn’t change what the agent writes. It changes where you can be while it works: the agent runs on your own machine, and your phone becomes the place you read what it did and say yes or no. The reading is still yours to do.",
      },
    ],
    related: [
      {
        title: "Coding agents on your phone",
        blurb: "the honest routes from a phone to a running agent, and where they run out",
        href: "/coding-agents-on-your-phone",
      },
      {
        title: "Claude Code on your phone",
        blurb: "a day run from the couch, the train, and the queue",
        href: "/claude-code-on-your-phone",
      },
      {
        title: "Best AI coding agents",
        blurb: "Claude Code, Codex, OpenCode, Aider, compared for the way you’ll actually use them",
        href: "/best-ai-coding-agents",
      },
    ],
    cardTitle: "Vibe coding vs traditional coding",
    cardBlurb:
      "Origin, definition, where it works, where it fails, and what the other side became.",
  },

  {
    slug: "mosh-vs-ssh",
    kind: "explainer",
    hub: { name: "Guides", href: "/guides" },
    title: "mosh vs SSH: what mosh fixes, what it drops, what’s newer",
    description:
      "How mosh differs from SSH under the hood — UDP state sync versus a TCP stream, roaming, predictive echo — what it gives up, and the modern alternatives to both.",
    datePublished: "2026-09-03",
    dateModified: "2026-09-03",
    hero: {
      plain: "mosh vs",
      accent: "SSH",
      sub: "Two answers to “how do I keep a shell on a machine that isn’t here” — the mechanics that separate them, what each gives up, and what has arrived since.",
    },
    body: [
      {
        kind: "prose",
        heading: "SSH is a stream; mosh is a state.",
        paragraphs: [
          "SSH is an encrypted byte stream over one TCP connection: keystrokes go up it, the terminal’s output comes down it, and the connection is the session. When TCP dies — the laptop sleeps, the address changes from Wi-Fi to cellular, the train enters a tunnel — the session dies with it and the shell on the far end gets a hangup. `ServerAliveInterval` and `ServerAliveCountMax` in `ssh_config` decide how quickly the client notices; they don’t change the outcome. tmux or screen on the server keeps the process alive, but that is a second tool doing a job SSH doesn’t.",
          "mosh keeps SSH for exactly one thing. The `mosh` command logs in over SSH, starts `mosh-server` as you, and the server “listens on a high UDP port and sends its port number and an AES-128 secret key back to the client over SSH.” Then SSH exits. From there client and server run the State Synchronization Protocol over UDP: instead of a stream of bytes, each side holds a picture of the terminal screen and they synchronise the difference, in datagrams encrypted with AES-128 in OCB mode, with a heartbeat at least every three seconds. Roaming falls out of the design — “every time the server receives an authentic packet from the client with a sequence number higher than any it has previously received, the IP source address of that packet becomes the server’s new target” — so sleeping the laptop, switching networks, and losing the link for an hour all resume without a reconnect.",
          "The other half of mosh’s reputation is predictive local echo: the client models what the server will do with your keystrokes and shows the result before the round trip completes; on a bad link, “outstanding predictions are underlined so you won’t be misled.” `--predict=adaptive` is the default, `always` and `never` the alternatives, and `Ctrl-^ .` ends a session by force.",
        ],
      },
      {
        kind: "points",
        heading: "What mosh gives up.",
        lead: "The design that survives roaming is also the design that can’t carry the rest of SSH.",
        items: [
          {
            title: "Scrollback",
            body: "“Mosh synchronizes only the visible state of the terminal.” Output that scrolled off the screen while you were disconnected is gone from the client; the project’s own advice is to run tmux or screen on the remote side for history.",
          },
          {
            title: "Forwarding of every kind",
            body: "Per the README, “Mosh does not support X forwarding or the non-interactive uses of SSH, including port forwarding.” Agent forwarding was requested in [issue #120](https://github.com/mobile-shell/mosh/issues/120) and implemented in a pull request that was never merged. The SSH connection that started the session is closed, so nothing that rides an SSH connection can ride mosh.",
          },
          {
            title: "Non-interactive use",
            body: "scp, sftp, rsync and git over ssh are SSH the transport, not SSH the shell, and mosh has no equivalent. In practice you keep both.",
          },
          {
            title: "The client itself",
            body: "mosh survives the network changing, not the client disappearing. The session key lives in the client process; if the terminal app is killed — a phone reclaiming memory, a crash — there is no reconnecting to that `mosh-server`, only starting another.",
          },
        ],
      },
      {
        kind: "prose",
        heading: "The firewall reality.",
        paragraphs: [
          'SSH needs one inbound TCP port, 22 by default. mosh needs that port for the login plus inbound UDP: “Mosh will use the first available UDP port, starting at 60001 and stopping at 60999”, and if you forward TCP 22 through a NAT you have to forward the UDP range too. `mosh -p 60010 host` pins the port; `mosh --ssh="ssh -p 2222" host` handles a non-standard SSH port. The symptom when UDP is blocked is precise — “Nothing received from the server on UDP port 60003” — meaning SSH worked and the datagrams aren’t getting through.',
          "Both, then, need something listening on the host and a path in from outside: a public address, a port forward, or a VPN. Behind CGNAT or a sealed firewall, neither works without a third tool.",
        ],
      },
      {
        kind: "table",
        heading: "Row by row.",
        columns: ["", "SSH", "mosh"],
        rows: [
          ["Transport", "One TCP connection", "UDP datagrams, state synchronisation"],
          [
            "Survives an IP change or sleep",
            "No — the session ends",
            "Yes — any authentic packet retargets the server",
          ],
          ["Survives the client dying", "No", "No — the key lives in the client"],
          [
            "Feel on a bad link",
            "Every keystroke waits for the round trip",
            "Predictive echo, underlined until confirmed",
          ],
          ["Scrollback", "Your terminal’s, complete", "Visible screen only; tmux for history"],
          ["Port, agent, and X11 forwarding", "Yes", "No"],
          ["scp, sftp, rsync, git", "Yes", "No — keep ssh for these"],
          ["Inbound requirement", "TCP 22", "TCP 22 plus UDP 60000–61000"],
          ["Encryption", "SSH transport", "AES-128 OCB per datagram; SSH for login"],
          ["Phone clients", "Every SSH app", "Blink and Termius speak it"],
          ["Release cadence", "Continuous, OpenSSH", "1.4.0 in 2022, five years after 1.3"],
        ],
      },
      {
        kind: "points",
        heading: "What has arrived since.",
        lead: "mosh is from 2012 and the question it answered has three newer answers.",
        items: [
          {
            title: "Eternal Terminal",
            body: "[ET](https://github.com/MisterTea/EternalTerminal) reconnects automatically like mosh but over TCP, on port 2022 by default, with SSH for the handshake. It keeps native scrolling, supports tmux’s control mode (`tmux -CC`), and tunnels ports with `-t`. It is what you want if mosh’s scrollback rule is the thing you can’t live with — and it still needs an open port.",
          },
          {
            title: "tmux over SSH, with autossh",
            body: "The old pattern, automated: `autossh -M 0 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -t host 'tmux new -A -s main'`. autossh restarts ssh whenever it exits, the keepalives make it exit promptly, and `tmux new -A` reattaches to the same session every time. The connection is rebuilt rather than resumed, but the session and its scrollback are on the host regardless.",
          },
          {
            title: "The browser console",
            body: "The session lives on the host and any browser attaches to it — from [self-hosted web terminals](/spawnd-vs-self-hosted-web-terminals) to spawnd. The connection becomes disposable because nothing is stored in it; scrollback is wherever the session is.",
          },
        ],
      },
      {
        kind: "capture",
        caption:
          "The session as the durable thing: agent sessions across three hosts, each one owned by a worker on its machine, scrollback kept where the process runs — no connection to keep alive.",
      },
      {
        kind: "prose",
        heading: "Surviving the client, not just the network.",
        paragraphs: [
          "Put the two lists together and the gap is visible: SSH loses the session when the connection goes; mosh keeps the connection but loses scrollback and dies with the client; both need a port. What is left wanting is a session that lives on the host on purpose, with its history, reachable from whatever is in your hand, through a firewall that opens nothing.",
          "That is the shape spawnd takes. One daemon per host you own, and it dials out — nothing listens, no UDP range, no VPN. A worker process on the host owns each session’s PTY, so a session survives the closed tab, the dropped connection, the laptop lid, and a daemon restart, scrollback intact. Any browser is the terminal; on a phone it installs to the home screen as a web app, with no keys on the device. Your browser talks to each daemon peer-to-peer, end-to-end encrypted, and the server that introduces them never sees session content. It has no predictive echo — on a truly bad link mosh still feels smoother — which is why [spawnd vs mosh](/spawnd-vs-mosh) and [spawnd vs SSH + tmux](/spawnd-vs-ssh-and-tmux) both say when the older tool is the right one.",
        ],
      },
    ],
    start: "Keep the session, drop the port.",
    faq: [
      {
        q: "Is mosh more secure than SSH?",
        a: "It authenticates with SSH, so login is exactly as secure as your SSH setup, and its datagrams are encrypted with AES-128 OCB. The 1.4.0 announcement noted no reported vulnerabilities in the preceding decade. It is a different design, not a weaker one — but a smaller, slower-moving one.",
      },
      {
        q: "Should I run tmux inside mosh?",
        a: "Yes, if you want scrollback or a session that outlives the client. mosh keeps the connection alive; tmux keeps the process and the history alive. The project itself recommends the pairing.",
      },
      {
        q: "Does mosh work from an iPhone?",
        a: "Blink Shell is built around it and Termius supports it. Both are real fixes for a phone that changes networks all day; both still need the host reachable on SSH and the UDP range, and neither gives you scrollback mosh doesn’t have.",
      },
    ],
    related: [
      {
        title: "spawnd vs mosh",
        blurb: "surviving the network versus surviving everything else",
        href: "/spawnd-vs-mosh",
      },
      {
        title: "spawnd vs SSH + tmux",
        blurb: "the classic, versus persistence without a listener",
        href: "/spawnd-vs-ssh-and-tmux",
      },
      {
        title: "spawnd vs mobile SSH apps",
        blurb: "the clients that speak mosh on a phone",
        href: "/spawnd-vs-mobile-ssh-apps",
      },
    ],
    cardTitle: "mosh vs SSH",
    cardBlurb: "A stream versus a state: the mechanics, the losses, and what came after.",
  },
];
