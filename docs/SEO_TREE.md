# The SEO page tree

Source of truth for spawnd's organic-search catalogue. Registry entries
(`web/src/lib/seo/`) are minted from this file, never ahead of it.
Target: **~500 pages, designed before built.** Status: **DESIGN PHASE** —
the 14 pages on `feat/seo-landing-pages` predate this bar and will be reworked.
The build process and quality bar live in `docs/SEO_RUNBOOK.md`, with
`/run-agents-in-parallel` as the canonical example.

## Strategy

spawnd straddles two categories, and the play differs by category:

- **Remote terminal access** — old category, established queries, incumbents
  everywhere. We *compete* here: comparison and machine pages harvest the
  long tail with honesty-first content that outranks vendor copy.
- **AI agent operations** — new category, exploding queries ("run claude code
  in parallel", "vibe coding on phone"), almost no incumbent pages. We *own*
  here: get the definitive page up before the category has a canon. This is
  where the growth is; when in doubt, agent-ops pages come first.

Funnel roles: comparisons and fix pages are bottom-funnel (searcher already
has the problem and a shortlist); device/machine/job pages are mid; guides and
vibe pages are top-of-funnel and brand-building. Every page names exactly one
primary ICP and is written in that ICP's register.

### ICPs

| ICP | who they are | what they type into Google | register | families that serve them |
|---|---|---|---|---|
| **Agent power user** | runs 3–10 Claude Code/Codex sessions as a fleet; throughput-obsessed; away-from-desk anxiety | "run multiple claude code sessions", "claude code worktrees parallel", "keep codex running overnight", "claude code mission control" | dense, specific, zero hand-holding | job pages, pillars, device row, guides |
| **Vibe coder** | prompt-first builder, maybe no terminal background; phone-native; ships side projects | "vibe coding setup", "vibe coding from phone", "build an app with ai from my phone", "code without a laptop" | zero infra jargon — ports, daemons, PTYs never appear un-explained; install reads as "one command, done" | vibe row, phone hub, guides |
| **Homelab / self-hoster** | owns Pi/NAS/home server; r/selfhosted; privacy-first; loves open source and E2E claims | "raspberry pi remote access without port forwarding", "self hosted web terminal", "open source tailscale alternative" | trust-forward; threat model is a feature | machine row, self-host, comparisons |
| **Pro dev with machines** | dev box + laptop + SSH muscle memory; evaluates by comparison table | "spawnd vs tailscale", "mosh alternative", "vs code tunnels vs ssh" | tables and tradeoffs; respects what they already use | comparisons, job pages, machine row |

Notes: the GPU/local-AI owner is served as the overlap of homelab × power
user (GPU machine page, parallel pages) rather than a fifth ICP. Vibe-coder
pages deliberately avoid the comparison family — that ICP isn't shortlisting
infrastructure, they're looking for a way in.

## Rules

1. A page exists only where a distinct query exists AND the page can carry
   content only it can carry. Otherwise it's a paragraph on its parent.
2. Hub-and-spoke: hubs take the generic query, spokes take exact-match ones,
   spokes link up and across.
3. Honesty ranks: comparison pages state when the other tool wins; every claim
   survives a diff against `docs/TRUST.md`.
4. Plain-language titles and H1s; demon voice in body copy only.
5. Copy bar — scenario first, product second, no adjective doing a fact's job:
   > "At six you gave Claude Code the refactor. At nine, from the couch, it's
   > asking permission to touch twelve files — you read the diff on your
   > phone, approve it, and tell it to run the tests. The laptop's been asleep
   > the whole time."
6. Bespoke mechanically: signature section per family (phone vignette / network
   diagram / ledger table / numbered steps), custom-JSX escape hatch per page,
   no shared H2 phrasing between siblings.
7. One primary ICP per page, written in that ICP's register (see table).
8. **Serve the query before the pitch.** Write for someone who has never
   heard of spawnd: open with genuinely usable, product-free content — the
   pattern, the honest comparison, the fix — including what their existing
   tools (iTerm2, tmux, SSH) already cover. spawnd enters only where the
   taught approach runs out. A reader who bounces must still leave better
   off; a reader who stays should feel the product arrive as the obvious
   next step, not the premise.
9. GATED = named verification required before the page exists.

## URL policy

**Every page is a single slug off the root.** No `/use/`, `/for/`, `/vs/`
path segments. Family lives in the registry, not the URL.

| family | slug pattern | example |
|---|---|---|
| agent pillar | `/{agent}` | `/claude-code` |
| device | `/{agent}-on-your-phone`, `/code-on-…` | `/codex-on-your-phone` |
| machine | descriptive | `/raspberry-pi-without-port-forwarding` |
| job / vibe | descriptive | `/run-agents-in-parallel`, `/vibe-coding-setup` |
| comparison | `/spawnd-vs-{x}` | `/spawnd-vs-tailscale-ssh` |
| listicle | `/{x}-alternatives` | `/tmate-alternatives` |
| guide | `/how-to-…` | `/how-to-run-claude-code-from-your-phone` |
| fix | symptom, verbatim | `/claude-code-stops-when-laptop-sleeps` |
| hub | one word-ish | `/use-cases` `/agents` `/comparisons` `/guides` |

Slugs must not collide with app routes (`/login`, `/app`, `/w`, `/hosts`, …);
the registry test enforces a denylist.

## On-page requirements (every page, checked before it ships)

**Performance — verified with PageSpeed Insights (mobile):**
- Performance score ≥ 95; Core Web Vitals green: LCP < 2.5s, CLS < 0.1,
  INP < 200ms.
- Statically generated (SSG). First-load JS budget ≤ 170KB; marketing pages
  carry no app code. Fonts via `next/font` (no FOIT/CLS); images via
  `next/image` with explicit dimensions; no layout shift from any section.
- Lighthouse CI added to the web checks once templates stabilize; budgets
  fail the build, not a human's memory.

**Metadata:**
- `<title>` ≤ 60 chars, query-matched, unique. Meta description 140–160 chars,
  unique. Self-referencing canonical, absolute. OpenGraph + Twitter card with a
  per-page OG image (automated at this scale). Indexable pages in
  `sitemap.xml`; app surfaces disallowed in `robots.txt`.

**Structured data (JSON-LD, validated with Google's Rich Results Test):**
- Site-wide: `Organization` + `SoftwareApplication` (on `/` and hubs).
- All pages: `BreadcrumbList` (root → hub → page).
- Q&A sections: `FAQPage`. Dated editorial pages (jobs, guides): `Article`;
  guides add `HowTo`. `datePublished`/`dateModified` kept honest. Comparisons:
  no `Review` schema (we are not a neutral reviewer); plain content.
  Expectation check: Google no longer shows FAQ rich results for ordinary
  sites and retired HowTo rich results entirely — this markup is for
  machine-readability (including AI answers), not SERP decoration.

**Content & semantics:**
- Exactly one `<h1>`, primary phrase in title + H1 + first ~100 words, proper
  heading hierarchy, descriptive anchors (never "read more").
- Internal links: every spoke links its hub, its pillar, and 2–3 siblings;
  every page reachable ≤ 3 clicks from `/`.
- Alt text on all images; body never scrolls horizontally (wide content
  scrolls in its own container); WCAG AA contrast.
- No thin pages: a page that can't fill its template honestly is pruned, not
  padded.

## Gates

- **Native app wording** — phone/iPad pages stay PWA-only until owner confirms
  store availability.
- **WSL2** — smoke-test daemon under WSL2 before the page exists.
- **NAS** — verify daemon runs (glibc/arch) before any NAS page.
- **Per-agent facts** — check each agent's current docs before stating auth,
  flags, or behaviour.

---

## The tree

Tier 0 (hand-built): `/` · `/security` · `/download`

**Hubs:** `/use-cases` · `/agents` · `/comparisons` · `/guides` — real content
pages targeting category head terms, each racking its spokes.

### Device row — primary ICP: power user (hub also serves vibe coders)

- `/coding-agents-on-your-phone` (hub)
- `/claude-code-on-your-phone` · `/codex-on-your-phone` ·
  `/aider-on-your-phone` · `/opencode-on-your-phone`
- `/code-on-an-ipad`
- `/code-on-a-chromebook` · `/code-on-an-android-tablet` (fold into iPad if
  not distinct)
- quarry: phone page per quarry agent

### Vibe row — primary ICP: vibe coder

- `/vibe-coding-from-your-phone` (the ICP's front door; overlaps the phone hub
  in topic, not in register — no terminal literacy assumed)
- `/vibe-coding-setup` (the setup that runs itself: one box, one command,
  every device becomes a window)
- `/your-first-coding-agent` (the on-ramp: what an agent is, pick one, give it
  a machine, talk to it from anywhere)
- quarry: `/vibe-coding-with-{agent}` per quarry agent where searched

### Machine row — primary ICP: homelab / self-hoster

- `/web-terminal-for-your-home-server` · `/ai-agents-on-your-own-gpu`
- `/raspberry-pi-without-port-forwarding` · `/headless-mac-mini`
- `/vps-web-terminal` · `/old-laptop-as-an-agent-box` · `/wsl2` (GATED)
- quarry: mini-PC (N100/NUC) · gaming PC · Proxmox VM · Docker/LXC · Jetson ·
  homelab hub · per-distro row (GATED per distro)

### Job pages — primary ICP: power user

- `/run-agents-in-parallel` (flagship: the workspace grid is the answer)
- `/keep-agents-running` · `/overnight-agent-runs`
- `/monitor-your-agents` (attention cues, the phone ping when an agent needs
  a yes)
- `/agent-fleet-across-machines` · `/ai-agent-command-center`
- `/remote-access-without-open-ports` · `/self-host` (these two serve homelab)

### Agent pillars — primary ICP: power user

- `/claude-code` · `/codex` · `/aider` · `/opencode`
- quarry (~20–30 with emerging): `/gemini-cli` · `/amp` · `/goose` · `/cline`
  · `/qwen-code` · `/cursor-cli` · `/copilot-cli` · `/crush` · `/plandex` ·
  `/ra-aid` · `/droid` · `/grok-cli`. Minting an agent = pillar + phone page
  + 2–3 guides, fact-checked (see Gates).

### Comparisons — primary ICP: pro dev

- `/spawnd-vs-ssh-and-tmux` · `/spawnd-vs-vscode-remote-tunnels` ·
  `/spawnd-vs-tmate` · `/spawnd-vs-coder` · `/spawnd-vs-tailscale-ssh`
- `/spawnd-vs-mosh` · `/spawnd-vs-mobile-ssh-apps` ·
  `/spawnd-vs-self-hosted-web-terminals` · `/spawnd-vs-github-codespaces` ·
  `/spawnd-vs-cloudflare-tunnel` · `/spawnd-vs-remote-desktop`
- quarry: tunnels (ngrok · frp · tailscale-funnel), mesh (zerotier · netbird ·
  nebula · headscale), terminals (ttyd · wetty), persistence (zellij · screen ·
  eternal-terminal), gateways (apache-guacamole · teleport), cloud IDEs
  (gitpod · replit · project-idx), desktop (rustdesk · chrome-remote-desktop),
  mobile SSH (blink-shell · termius)
- listicles: `/tmate-alternatives` · `/ngrok-alternatives-for-ssh` ·
  `/codespaces-alternatives` · `/port-forwarding-alternatives` · ~6 more

### Guides — ICP split: power user (agent guides) and vibe coder (starter guides)

- `/how-to-run-claude-code-from-your-phone`
- `/how-to-keep-claude-code-running-after-closing-your-laptop`
- `/how-to-run-claude-code-on-a-raspberry-pi`
- `/how-to-run-multiple-claude-code-sessions`
- `/how-to-run-claude-code-in-parallel-with-worktrees` (heavily searched
  power-user workflow; spawnd is where the worktree fleet becomes visible)
- `/how-to-access-a-home-server-without-port-forwarding`
- quarry: agent × {phone, keep-running, machine, parallel, first-setup},
  ~3–5 per quarry agent. Largest branch (~100–150 pages); a guide without the
  agent's real commands and one agent-specific troubleshooting section is not
  minted.

### Fix pages — ICP: whoever has the symptom (template TBD)

- `/claude-code-stops-when-laptop-sleeps` ·
  `/ssh-connection-drops-keep-session-alive` ·
  `/tmux-session-lost-after-reboot` · `/codex-timed-out-overnight` · ~30–50
  total. Template: diagnosis → general fixes → the structural fix. Lead with
  the honest cause, not the pitch.

## Templates

**Baseline recipe (owner-approved on the job prototype, 2026-08-27), all
templates inherit it:** hero = heavy branding, minimal words — a dimmed
full-bleed ink print (family-mapped: grid-ink jobs · pocket-ink device ·
hosts-ink machine · handoff-ink comparisons · hero-ink hubs) under exactly
the keyword H1 and one subheading (phrased as the page's promise to the
searcher, not the product's), breadcrumb small above, no CTAs; body = the
teach-first arc of Rule 8 — the pattern, taught neutrally → where it honestly
breaks → spawnd as the substrate that holds it (a product capture may appear
once at that turn, framed and captioned as an example); one CTA moment
("Start") near the end; quiet small-type FAQ; ~550-word budget above the FAQ
with the product-free half leading; single
shared rail and hairline borders. Reference implementation:
`web/src/components/seo/templates/JobPage.tsx` + `/run-agents-in-parallel`.

| template | serves | signature section | schema | status |
|---|---|---|---|---|
| hub | 4 hubs | intro essay + spoke rack | Organization, SoftwareApplication, Breadcrumb | exists as bare card rack; needs content upgrade |
| device | phone pages, iPad, Chromebook | phone-frame terminal vignette (an agent moment: permission prompt, diff) | Breadcrumb, FAQ | new |
| vibe | vibe row | device template base, softer chrome; jargon-free register enforced editorially | Breadcrumb, FAQ | new (variant) |
| machine | machine row | outbound-only network diagram | Breadcrumb, FAQ | new |
| job | job pages | workspace-grid vignette (the parallel fleet, live) | Breadcrumb, FAQ, Article (honest dates) | flagship built (`/run-agents-in-parallel`) |
| pillar | agent pillars | agent fact card + spoke rack | Breadcrumb, FAQ | new |
| comparison | /spawnd-vs-* | ledger table + honest verdict | Breadcrumb, FAQ, **no Review** | exists; rework to copy bar |
| listicle | /{x}-alternatives | ranked options w/ mini-ledgers, real tools listed honestly | Breadcrumb, FAQ | new |
| guide | /how-to-* | numbered steps, code blocks, troubleshooting | HowTo, Article (honest dates), Breadcrumb | new |
| fix | symptom pages | diagnosis → general fixes → structural fix | Breadcrumb, FAQ | new |

Shared parts under all ten: the flat `[slug]` router + denylist, the
signature-section components (phone vignette, network diagram, grid vignette),
JSON-LD builders, per-ICP closing CTAs, related-pages rack, automated OG
images, Lighthouse CI budgets.

## Arithmetic

hubs+tier0 7 · device ~30 · vibe ~10 · machine ~25 · jobs ~14 · pillars ~30 ·
vs ~45 · listicles ~10 · guides ~150 · fix ~40 · emerging headroom ~40 →
**~400–500**. Quarry overshoots on purpose; prune at minting, never pad.

## Implementation notes

- Flat URLs: one root-level `[slug]` catch-all beside the static app routes
  (Next prefers static matches); registry denylist test guards collisions.
  Existing `/use|/for|/vs` routes migrate at rework time — dev-only today, no
  redirects owed.
- Registry gains: per-family signature sections, custom-JSX escape hatch, two
  new templates (guide, fix), automated OG images, Lighthouse CI budgets.
- Rework the existing 14 to Rules 5–7 before minting anything new.
