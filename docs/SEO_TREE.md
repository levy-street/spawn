# The SEO page tree

Source of truth for spawnd's organic-search catalogue. Registry entries
(`web/src/lib/seo/`) are minted from this file, never ahead of it.
Target: **~500 pages, designed before built.** Status: **DESIGN PHASE** —
the 14 pages on `feat/seo-landing-pages` predate this bar and will be reworked.

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
7. Waves: W1 build first · W2 after W1 ships · W3 quarry. GATED = named
   verification required first.

## URL policy

**Every page is a single slug off the root.** No `/use/`, `/for/`, `/vs/`
path segments. Family lives in the registry, not the URL.

| family | slug pattern | example |
|---|---|---|
| agent pillar | `/{agent}` | `/claude-code` |
| device | `/{agent}-on-your-phone`, `/code-on-…` | `/codex-on-your-phone` |
| machine | descriptive | `/raspberry-pi-without-port-forwarding` |
| job | descriptive | `/run-agents-in-parallel` |
| comparison | `/spawnd-vs-{x}` | `/spawnd-vs-tailscale-ssh` |
| listicle | `/{x}-alternatives` | `/tmate-alternatives` |
| guide | `/how-to-…` | `/how-to-run-claude-code-from-your-phone` |
| fix | symptom, verbatim | `/claude-code-stops-when-laptop-sleeps` |
| hub | one word-ish | `/use-cases` `/agents` `/comparisons` `/guides` |

Slugs must not collide with app routes (`/login`, `/app`, `/w`, `/hosts`, …);
the registry test enforces a denylist.

## On-page requirements (every page, checked before a wave ships)

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
- Q&A sections: `FAQPage`. Guides: `HowTo` + `Article` with
  `datePublished`/`dateModified` kept honest. Comparisons: no `Review` schema
  (we are not a neutral reviewer); plain content.

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

### Hubs (W1)

`/use-cases` · `/agents` · `/comparisons` · `/guides` (W2) — real content
pages targeting category head terms, each racking its spokes.

### Device row

| wave | slug |
|---|---|
| W1 | `/coding-agents-on-your-phone` (hub) |
| W1 | `/claude-code-on-your-phone` · `/codex-on-your-phone` · `/aider-on-your-phone` · `/opencode-on-your-phone` |
| W1 | `/code-on-an-ipad` |
| W2 | `/code-on-a-chromebook` · `/code-on-an-android-tablet` (fold into iPad if not distinct) |
| W3 | phone page per quarry agent |

### Machine row

| wave | slug |
|---|---|
| W1 | `/web-terminal-for-your-home-server` · `/ai-agents-on-your-own-gpu` |
| W1 | `/raspberry-pi-without-port-forwarding` · `/headless-mac-mini` |
| W2 | `/vps-web-terminal` · `/old-laptop-as-an-agent-box` · `/wsl2` (GATED) |
| W3 | mini-PC (N100/NUC) · gaming PC · Proxmox VM · Docker/LXC · Jetson · homelab hub · per-distro row (GATED per distro) |

### Job pages

| wave | slug |
|---|---|
| W1 | `/remote-access-without-open-ports` · `/keep-agents-running` |
| W1 | `/run-agents-in-parallel` · `/self-host` |
| W2 | `/monitor-your-agents` · `/agent-fleet-across-machines` |

### Agent pillars

| wave | slugs |
|---|---|
| W1 (rework) | `/claude-code` · `/codex` · `/aider` · `/opencode` |
| W3 quarry | `/gemini-cli` · `/amp` · `/goose` · `/cline` · `/qwen-code` · `/cursor-cli` · `/copilot-cli` · `/crush` · `/plandex` · `/ra-aid` · `/droid` · `/grok-cli` · emerging (~20–30 total). Minting an agent = pillar + phone page + 2–3 guides, fact-checked. |

### Comparisons

| wave | slugs |
|---|---|
| W1 (rework) | `/spawnd-vs-ssh-and-tmux` · `/spawnd-vs-vscode-remote-tunnels` · `/spawnd-vs-tmate` · `/spawnd-vs-coder` · `/spawnd-vs-tailscale-ssh` |
| W1 | `/spawnd-vs-mosh` · `/spawnd-vs-mobile-ssh-apps` · `/spawnd-vs-self-hosted-web-terminals` · `/spawnd-vs-github-codespaces` · `/spawnd-vs-cloudflare-tunnel` |
| W2 | `/spawnd-vs-remote-desktop` |
| W3 quarry | tunnels: ngrok · frp · tailscale-funnel; mesh: zerotier · netbird · nebula · headscale; terminals: ttyd · wetty; persistence: zellij · screen · eternal-terminal; gateways: apache-guacamole · teleport; cloud IDEs: gitpod · replit · project-idx; desktop: rustdesk · chrome-remote-desktop; mobile SSH: blink-shell · termius |
| W3 | listicles: `/tmate-alternatives` · `/ngrok-alternatives-for-ssh` · `/codespaces-alternatives` · `/port-forwarding-alternatives` · ~6 more |

### Guides (W2 family)

W2: `/how-to-run-claude-code-from-your-phone` ·
`/how-to-keep-claude-code-running-after-closing-your-laptop` ·
`/how-to-run-claude-code-on-a-raspberry-pi` ·
`/how-to-run-multiple-claude-code-sessions` ·
`/how-to-access-a-home-server-without-port-forwarding`

W3 quarry: agent × {phone, keep-running, machine, parallel, first-setup},
~3–5 per quarry agent. Largest branch (~100–150 pages); a guide without the
agent's real commands and one agent-specific troubleshooting section is not
minted.

### Fix pages (W3 family, template TBD)

Symptom-verbatim slugs: `/claude-code-stops-when-laptop-sleeps` ·
`/ssh-connection-drops-keep-session-alive` · `/tmux-session-lost-after-reboot`
· `/codex-timed-out-overnight` · ~30–50 total. Template: diagnosis → general
fixes → the structural fix. Lead with the honest cause, not the pitch.

## Arithmetic

hubs+tier0 6 · device ~30 · machine ~25 · jobs ~12 · pillars ~30 · vs ~45 ·
listicles ~10 · guides ~150 · fix ~40 · emerging headroom ~50 → **~400–500**.
Quarry overshoots on purpose; prune at minting, never pad.

## Implementation notes

- Flat URLs: one root-level `[slug]` catch-all beside the static app routes
  (Next prefers static matches); registry denylist test guards collisions.
  Existing `/use|/for|/vs` routes migrate at rework time — dev-only today, no
  redirects owed.
- Registry gains: per-family signature sections, custom-JSX escape hatch, two
  new templates (guide, fix), automated OG images, Lighthouse CI budgets.
- Rework the existing 14 to Rule 5 before minting anything new.
