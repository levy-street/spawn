# The SEO page tree

The design of spawnd's organic-search catalogue. This file is the source of
truth while the tree is being designed; implementation mints registry entries
(`web/src/lib/seo/`) from it, and a page exists in code only after it exists
here. Target size: **~500 pages**, designed before built.

Status: **DESIGN PHASE.** The 14 pages currently live on `feat/seo-landing-pages`
predate this tree's quality bar and will be reworked to it, not treated as done.

## Rules

1. **A page exists only where a distinct query exists AND the page can carry
   content only it can carry.** A template × dimension cell with nothing
   dimension-specific to say is not a page; it's a paragraph on its parent.
2. **Hubs and spokes.** Every fanout family has a hub page for the generic
   query ("coding agents on your phone"); spokes target the specific ones and
   link up. Hubs collect long-tail authority; spokes take the exact-match
   intent.
3. **Honesty is the ranking strategy.** Comparison pages state when the other
   tool wins. Every claim survives a diff against `docs/TRUST.md`. No claim
   about an unverified platform (see Gates).
4. **Plain-language titles and H1s** matched to the query; the demon voice
   lives in body copy and chrome. (Owner decision, 2026-08-27.)
5. **The copy bar:** scenario first, product second, no adjective doing a
   fact's job. Calibration example — instead of "The agent runs on your
   machine; your phone is just a window onto it": "At six you gave Claude Code
   the refactor. At nine, from the couch, it's asking permission to touch
   twelve files — you read the diff on your phone, approve it, and tell it to
   run the tests. The laptop's been asleep the whole time."
6. **Bespoke mechanically:** each family gets a signature section (phone-frame
   terminal vignette for the device row, outbound-only network diagram for the
   machine row, the ledger table for /vs, numbered steps with HowTo schema for
   /guides), and the registry keeps a custom-JSX escape hatch so any page can
   carry one-off sections. Sibling pages must not share H2 phrasing.
7. **Waves.** W1 = build first. W2 = after W1 ships. W3+ = quarry (designed
   dimension, pages minted as the branch is worked). A page marked GATED needs
   a named verification first.

## Gates (open questions before certain pages can claim things)

- **Native mobile app:** phone/iPad pages say PWA-only until the owner
  confirms the native app is in stores. (Asked 2026-08-27, unanswered.)
- **WSL2:** smoke-test the Linux daemon under WSL2 before any Windows/WSL page
  exists.
- **NAS (Synology/QNAP/TrueNAS):** verify the daemon actually runs there
  (glibc/arch) before any NAS page.
- **Per-agent facts:** before a page states an agent's auth model, flags, or
  behaviour, check it against that agent's current docs — these tools change
  monthly.

---

## The tree

### Tier 0 — hand-built surfaces (exist)

`/` · `/security` · `/download`

### Hubs (W1) — the three family indexes become real content pages

- `/use` — category hub, targets "remote coding agents" head terms
- `/for` — becomes the "bring any CLI" hub; custom agent definitions are a
  differentiator no competitor page can copy
- `/vs` — comparison hub

### /use — the device row

| wave | slug | target query / angle |
|---|---|---|
| W1 | `coding-agents-on-your-phone` | hub; "coding agents from your phone", "vibe coding on phone" |
| W1 | `claude-code-on-your-phone` | rework of existing; the permission-prompt-at-9pm moment, plan review, /resume |
| W1 | `codex-on-your-phone` | approval modes + sandbox from the couch; ChatGPT-plan auth stays home |
| W1 | `aider-on-your-phone` | reading its commits land from your phone; chat-REPL suits small glass |
| W1 | `opencode-on-your-phone` | a full TUI that has to actually render on a phone — and does |
| W1 | `code-on-an-ipad` | "code on iPad" evergreen; the iPad finally earns its keyboard; Split View next to docs |
| W2 | `code-on-a-chromebook` | browser-only device meets browser-only product |
| W2 | `code-on-an-android-tablet` | only if distinct from iPad page in substance, else fold in |
| W3 | phone × each W3 agent from the agent quarry | mint as pillars are minted; same uniqueness bar |

### /use — the machine row

| wave | slug | target query / angle |
|---|---|---|
| W1 | `web-terminal-for-your-home-server` | rework of existing |
| W1 | `ai-agents-on-your-own-gpu` | rework of existing |
| W1 | `raspberry-pi-without-port-forwarding` | big evergreen: "raspberry pi remote access without port forwarding" |
| W1 | `headless-mac-mini` | the "mini as agent box" crowd; macOS daemon story |
| W2 | `vps` | they have SSH; the angle is phone + persistence + no tmux discipline |
| W2 | `old-laptop-as-an-agent-box` | "use old laptop as home server" family; zero competition for the agent angle |
| W2 | `wsl2` | GATED on WSL2 smoke test |
| W3 | mini-PC (N100/NUC) · gaming-PC-as-agent-rig · Proxmox VM · Docker/LXC container · Jetson · homelab hub | one page each only where the setup story genuinely differs; homelab likely a hub |
| W3 | per-distro row: Ubuntu · Debian · Arch · Fedora · Alpine? | GATED on installer verification per distro; low individual volume, cheap, long tail |

### /use — the job pages (deliberately not fanned out per agent unless noted)

| wave | slug | target query / angle |
|---|---|---|
| W1 | `remote-access-without-open-ports` | rework of existing |
| W1 | `keep-agents-running` | rework; absorb the "overnight runs" angle |
| W1 | `run-agents-in-parallel` | flagship: "run multiple claude code sessions"; the workspace grid IS this |
| W1 | `self-host` | "self-hosted remote terminal", "open source tailscale ssh alternative self hosted" |
| W2 | `monitor-your-agents` | "how do I know when claude code needs input"; attention cues, phone pings |
| W2 | `agent-fleet-across-machines` | many hosts, one grid; distinct from parallel-on-one-box |
| W3 | security-focused job page ("lock down agent access") · air-gapped-ish/LAN-only self-host story | mint if queries justify |

### /for — agent pillars

Each pillar links down to its device/job/guide spokes. Uniqueness bar: the
agent's own auth model, its long-run behaviour, its config surface, and why
each maps onto spawnd.

| wave | slug |
|---|---|
| W1 (rework) | `claude-code` · `codex` · `aider` · `opencode` |
| W3 quarry — mint pillar + phone page + 2 guides per agent, checking each against current docs first: | `gemini-cli` · `amp` · `goose` · `cline` (verify CLI story) · `qwen-code` · `cursor-cli` · `copilot-cli` · `crush` · `plandex` · `ra-aid` · `droid` · `grok-cli` · + emerging agents as they appear (the quarry is expected to grow; ~20–30 agents plausible) |

### /vs — comparisons (one page per named thing people actually type)

| wave | slug | the honest angle |
|---|---|---|
| W1 (rework) | `ssh-and-tmux` · `vscode-remote-tunnels` · `tmate` · `coder` · `tailscale-ssh` | existing five, to the new copy bar |
| W1 | `mosh` | roaming + local echo, but UDP inbound + no persistence + no phone story |
| W1 | `mobile-ssh-apps` | Blink/Termius/Prompt as a category; the phone searcher's other option |
| W1 | `self-hosted-web-terminals` | ttyd/Wetty/GoTTY as a category; you become the exposure engineer |
| W1 | `github-codespaces` | "codespaces alternative self hosted"; your hardware, no meter; Gitpod inside |
| W1 | `cloudflare-tunnel` | the DIY pattern; their browser terminal decrypts at the edge, ours can't; keep the tunnel for web UIs |
| W2 | `remote-desktop` | RustDesk/AnyDesk/VNC-to-code; streaming pixels vs a terminal |
| W3 quarry, individual pages where the name is searched: | tunnels: `ngrok` · `frp` · tailscale-funnel; mesh: `zerotier` · `netbird` · `nebula` · `headscale`; web-terminal singles: `ttyd` · `wetty` (only if category page proves out); persistence: `zellij` · `screen` · `eternal-terminal`; gateways: `apache-guacamole` · `teleport`; cloud IDEs: `gitpod` · `replit` · `project-idx`; remote desktop singles: `rustdesk` · `chrome-remote-desktop`; mobile SSH singles: `blink-shell` · `termius` | each needs the named tool's real strengths stated; skip any we can't describe fairly |
| W3 | "alternatives to X" listicle template: `tmate-alternatives` · `ngrok-alternatives-for-ssh` · `codespaces-alternatives` · `port-forwarding-alternatives` · ~6 more | different intent (list-shopping); we appear first but list real options honestly |

### /guides — how-tos (W2 family; HowTo schema; procedural, not promotional)

Generic five first: phone · keep-running-after-lid-close · raspberry-pi ·
multiple-sessions · home-server-no-port-forwarding (all "claude code"-flavoured
where agent-specific).

W3 quarry: the guide matrix = agent × {phone, keep-running, specific-machine,
parallel, first-setup}. Minted alongside each agent's pillar, ~3–5 guides per
agent. This branch is the single largest contributor on the road to ~500
(~100–150 pages at 20–30 agents) and the most vulnerable to thinness — every
guide must contain the agent's real commands and at least one
agent-specific troubleshooting section, or it isn't minted.

### /fix — problem pages (W3 family, design TBD)

Symptom-intent queries: "claude code stops when laptop sleeps", "ssh session
died", "tmux session lost after reboot", "codex timed out overnight". One page
per named symptom, leading with the actual cause and the general fixes before
spawnd. Est. 30–50 pages. Needs its own template (diagnosis → fixes → the
structural fix). Family name/URL to be decided — `/fix/` provisional.

---

## The arithmetic to ~500

| branch | pages (est.) |
|---|---|
| hubs + Tier 0 | 6 |
| device row (incl. phone × ~25 agents) | ~30 |
| machine row (incl. distros) | ~25 |
| job pages | ~12 |
| agent pillars | ~30 |
| /vs individual + categories | ~45 |
| /vs alternatives listicles | ~10 |
| /guides (generic + matrix) | ~150 |
| /fix | ~40 |
| headroom for emerging agents/tools | ~50 |
| **total** | **~400–500** |

The quarry overshoots on purpose; pages get pruned at minting time when the
uniqueness bar fails, not padded to hit a number.

## Implementation notes (for when building resumes)

- Registry stays the engine; add per-family signature sections, the custom-JSX
  escape hatch, and (for /guides, /fix) two new templates.
- At this scale: per-page OG images become worth automating; sitemap and
  internal linking already follow from the registry; watch build time but SSG
  of ~500 static pages is well within Next's comfort.
- Existing 14 pages: rework copy to Rule 5 before any new minting.
- Mobile-app wording: see Gates.
