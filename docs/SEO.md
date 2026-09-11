# SEO pages

The demand data is `spawnd-seo-grimoire.html` at the repo root: a Semrush
keyword study (US database, 2026-08-31; 37 seed universes, 3,086 keywords)
that prescribes the pages in four tiers and names the five plays — the
Claude Code mid-tail, the Codex CLI arbitrage, Claude plan economics, the
phone and browser terminal, rival comparisons — plus the DIY shoulder
clusters. Everything under `web/src/lib/grimoire/` exists because a row in
that document said it should.

## Where a page lives

Pages are data, not JSX. One entry per page, in a template file:

- `web/src/lib/grimoire/articles/*.ts` — one file per keyword cluster
  (claude-code, claude-code-reference, codex, open-agents, definitions,
  phone-ssh, mac-and-vscode, roundups, fixes-and-essays), aggregated by
  `articles/index.ts`. An article is typed blocks — prose, numbered steps, a
  reference table, points — and a `kind` (guide, fix, explainer, reference,
  roundup, definition); guides emit HowTo schema from their steps. Clusters
  that own a pillar hub (`/claude-code`, `/codex`) export it from the same
  file. Each file's header comment names the vendor pages its facts were
  checked against and the date.
- `web/src/lib/grimoire/hubs.ts` — `/guides`, whose rack is computed from
  the catalogue.
- `web/src/lib/grimoire/comparisons.ts` — `/spawnd-vs-*`.
- `web/src/lib/grimoire/catalogue.ts` unions them; `app/[slug]/` renders
  them through `web/src/components/grimoire/` (the frame in the pressroom's
  ink, and the article, hub, and comparison templates). Paragraph strings
  accept the inline markup of `lib/grimoire/inline.ts`: `` `code` `` spans
  and `[text](href)` links.
- Hand-built routes: `app/claude-plan-calculator/` and `app/tmux-cheatsheet/`
  (the tools; their cards are in `lib/grimoire/tools.ts`), `app/docs/` (design
  documents rendered on-site from `docs/*.md`), `app/llms.txt/`.

## The bar

Teach first: the page answers the query completely with the tools the
reader already has, and spawnd enters only where that honest route runs out.
Every third-party fact is verified against the vendor's current docs before
it is written. Claims about spawnd are phrased as the site already phrases
them and survive a diff against `docs/TRUST.md`. Intent traps the grimoire's
review found: "claude code remote" and "claude code web" mostly navigate to
Anthropic's own Remote Control and hosted product, and "claude code teams"
mostly means the Team plan — those pages concede and teach the vendor's
thing first.

## The ask

Signup is invite-only, so every page's one call is the waitlist: the Start
block on each SEO page, the landing page's closing plate, and the signup page
itself when someone arrives without a code. The form posts to
`POST /api/waitlist` with the page it sat on as `source`, so the admin page's
Waitlist section (web and mobile) shows which pages earn their keep and lets
an admin mint and mail an invite in one click. The block reads the server's
`invite_only` flag at runtime: the day signup opens, the same block shows the
door instead, with no rebuild.

## Checks and shipping

```bash
cd web
npm run lint && npx tsc --noEmit
npx bun test src/lib/grimoire src/app        # catalogue invariants, tool math
npm run dev                                  # then, in another shell:
node scripts/og-shots.mjs <slug>…            # public/og/<slug>.jpg from the page's own hero
```

`catalogue.test.ts` fails the build side of every race: a slug that would be
shadowed by a static route, a link to a page that does not exist, a title or
description outside the snippet budget, a guide without steps.

## Not built

- The live in-browser terminal demo (grimoire Tier 2): needs a sandboxed
  host and an abuse story before it exists.
- A blog.
