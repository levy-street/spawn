# SEO runbook

How a landing page goes from a row in `docs/SEO_TREE.md` to shipped, and the
bar it has to clear. The tree says *what* pages exist and why;
`docs/SEO_PRECEDENTS.md` says why the templates look the way they do; this
document is the *how* — the process, the quality bar, and the checklists.

**The canonical example is `/run-agents-in-parallel`** — the flagship job
page (`web/src/app/run-agents-in-parallel/page.tsx` on the job template in
`web/src/components/seo/templates/`). Every rule below is implemented there;
when a rule here is ambiguous, diff your page against that one and do what it
does. Key commits: `9af72c7` (template + first capture), `623b245`/`4bed93c`
(content multiplication, whole-app capture), `f46dba3` (the performance
pass), `03a72ad` (schema and crawlability).

Measured result, production build over a real network hop: Lighthouse
**99 / 100 / 100 / 100** mobile, **100 / 100 / 100 / 100** desktop.
That is the bar, not the ceiling.

---

## 1. The page itself: content before optimization

None of the technical work below rescues a page that isn't worth ranking.
The flagship earns its position with the content, in this order:

**Search intent first.** Before the page exists, read the SERP for its
query. The keyword grimoire (`spawnd-seo-grimoire.html`, repo root) gives
volume and difficulty; it does not give intent, and several of its richest
queries navigate to a vendor's own feature (Claude Code's Remote Control,
Anthropic's Team plan). A page for such a query concedes and teaches the
vendor's thing first, or it is the wrong page.

**Teach first.** The page is written for someone who has never heard of
spawnd and doesn't need it yet. It opens by teaching the thing they actually
searched for — running several Claude Code sessions at once — and teaches it
honestly: the worktree-and-panes setup, doable today in iTerm2 or tmux, no
product mentioned. The reader who stops after section one still got what
they came for. That honesty is the ranking strategy: it's what makes the
page linkable, quotable, and trustworthy when the product does enter.

**The product enters where the honest setup runs out.** Not before. The
pivot is a real limitation (the lid closes, the second machine, the prompt
that waits all afternoon), stated as the reader's experience, not as a
sales objection. From there, every section pairs one claim with one proof.

**Editorial discipline.** Sentence case everywhere. Whitespace separates
sections — no borders, no eyebrows, no section markers. A centered ~68ch
article column; figures may break wider. One media jewel per section, never
two. Brand red is rationed to the H1 accent and links. Complete sentences;
no filler, no feature-dump bullets. If a sentence wouldn't survive being
read aloud, rewrite it.

**Every claim survives a diff against `docs/TRUST.md` and the README.**
The E2E claim is phrased as shipped copy phrases it ("your browser talks to
each daemon peer-to-peer, end-to-end encrypted") — never invent a new
formulation of a security property for a landing page.

**No thin pages.** A page that can't fill its template honestly is pruned
from the tree, not padded.

## 2. Representing the app: real, working, whole

The captures are the argument. The flagship's standards, all mandatory:

- **Real product captures only.** Recorded from a live instance of the app —
  never mockups, never wireframes, never staged HTML that resembles the app.
- **Real work in the terminals.** Actual Claude Code and Codex sessions doing
  recognizable work on real repositories — real test suites passing, real
  diffstats growing, real dev servers. The centerpiece is spawn building
  spawn: agent sessions across web, server, daemon, and mobile of this very
  repo. Filler text and obvious demo loops read as fake in one glance and
  poison the whole page.
- **The whole app, credibly inhabited.** Frames show the real product
  chrome: the sidebar roster of workspaces (real-caliber projects), named
  tabs (web ui, server, daemon, mobile, security), one workspace = one
  project. The app must look like a power user's daily driver, not a demo
  account.
- **No permission modals in frame.** The audience is agent power users;
  sessions run in accept-edits mode. A capture waiting on a permission
  prompt is a retake, unless the page's point *is* the remote approval flow.
- **Everything in frame visibly works.** Videos are verified pane-by-pane
  with frame diffs before shipping — a tile that doesn't move is a retake.
  Dispatch prompts on camera (agents finish fast; a recording started after
  dispatch captures stillness). Honest attention badges: occupy idle shells
  so every workspace doesn't show a phantom "needs attention".
- **Assets live in `web/public/product/`** (captures) and
  `web/public/brand/` (ink). Videos get an in-flow still fallback so
  reduced-motion readers lose nothing.

## 3. Performance: how the flagship scores 100

The scores come from architecture, not tweaks. The rules, each learned the
expensive way:

**The headline is the LCP, by design.** Decorative full-bleed hero media
must never be the measured element. The hero ink still is one tiny blurred
webp (458 bytes on the flagship) sitting below Chrome's LCP entropy
threshold (~0.05 bits per displayed pixel — tune empirically; 1.0KB was
*not* excluded, 458B was; verify via the `lcp-discovery-insight` node in the
Lighthouse JSON, which names the LCP element). Behind the hero dim, the blur
reads as atmosphere. The crisp film overlays it after `window` load, and
**desktop only** — a phone never fetches megabytes of decoration
(`HeroInkVideo.tsx`, the `matchMedia` gate).

**`autoplay` overrides `preload="metadata"`.** An autoplaying product video
fetches its entire file at page load, wherever it sits on the page. Product
captures mount their `<video>` via IntersectionObserver as the reader
approaches, over an in-flow lazy `next/image` still (`CaptureVideo.tsx`).

**Marketing routes ship no app machinery.** The warm terminal pool loads
xterm and the WebRTC glue via `React.lazy` only when a session mounts a
terminal — landing pages never fetch it (~150KB gzipped saved,
`LiveTerminalProvider.tsx`). Watch first-load JS per route in the build
output; the budget in SEO_TREE is ≤170KB.

**Small sharp edges:**
- Next merges `viewport` exports **per-field**: a marketing page must
  explicitly set `maximumScale: 5, userScalable: true` or it inherits the
  app layout's zoom lock (an accessibility failure).
- Next replaces `openGraph` metadata **wholesale**: a page that declares
  `openGraph` without `images` has no OG image at all.
- `next/image`'s `priority` does not emit `fetchpriority=high` — pass
  `fetchPriority="high"` explicitly on a genuine LCP image.
- `prefetch={false}` on template links; cold search traffic first.
- The masthead on SEO pages is static (`MastheadStatic`) — no auth probe,
  no 401 in a stranger's console, best-practices stays 100.

**How to measure — localhost lies.** Build production in a detached
worktree (never in the live `web/` while the dev stack runs) and serve it:

```bash
git -C ../spawn-lh checkout <sha> && cd ../spawn-lh/web
SPAWN_API_PROXY_TARGET=http://127.0.0.1:<api> bun run build
node scripts/next-with-proxy-target.mjs start -p 3999
npx lighthouse http://127.0.0.1:3999/<page> --output=json \
  --chrome-flags="--headless=new --no-sandbox"   # CHROME_PATH → full Chrome
```

Lighthouse against localhost caps around 96–98 no matter what: with zero
latency every request starts inside the observed-LCP window and the
simulator's pessimistic graph swallows the whole waterfall. For the real
number, measure through a real network hop (a temporary tunnel works), and
run PageSpeed Insights against the live URL once deployed. Judge mobile and
desktop separately; a plain-HTTP preview fails two best-practices audits
that HTTPS passes.

## 4. Metadata and schema, per page

- Title ≤60 chars, query-matched, unique. Description 140–160 chars.
  Self-referencing absolute canonical.
- **Per-page OG image**: a screenshot of the page's own hero (hide the
  masthead, force the hero to 630px, capture 1200×630 at 2× — see the
  flagship's `public/og/`). `web/scripts/og-shots.mjs slug…` does exactly
  that against a running dev server. Declared with width/height/alt in
  `openGraph` *and* `twitter.images`. No page ships `summary_large_image`
  without an image.
- JSON-LD by template (schema column in SEO_TREE's template table):
  `BreadcrumbList` on everything; `FAQPage` where there's a Q&A section;
  `Article` with honest `datePublished`/`dateModified` on dated editorial
  pages (jobs, comparisons, guides — the `article` prop on `JobPage`);
  `HowTo` on guides (the article template emits it from a guide's steps);
  `Organization` + `SoftwareApplication` on `/` and the hubs only
  (`SiteStructuredData.tsx`); **no `Review`** on comparisons.
- Dates are kept honest or not shown. `og:type=article` pages carry matching
  `article:published_time`/`modified_time`.
- Expectation check: FAQ and HowTo rich results are retired for ordinary
  sites. The markup is for machine readability — including AI answers — not
  SERP decoration. Don't measure it by expecting expandable snippets.

## 5. Crawlability: no orphans

- Every indexable page is in `app/sitemap.ts` (registry pages map
  automatically; flat-slug pages by hand until the `[slug]` router lands).
- Every page is reachable in ≤3 clicks from `/`: its hub features or lists
  it, siblings cross-link it (the `related` rack), and site-wide surfaces
  link the flagship tier (the footer's "Parallel agents").
- Descriptive anchors, never "read more". App surfaces stay disallowed in
  `robots.ts`; `/signup` stays crawlable on purpose.

## 6. Ship checklist

In order, all of it, before a page is called done:

1. `npm run lint && npx tsc --noEmit && npx bun test src` in `web/`.
2. Production build in the worktree; check the route's first-load JS.
3. `curl` the built page and verify emissions: every JSON-LD blob parses,
   `og:image` + `twitter:image` + canonical present, the page is in
   `sitemap.xml`, inbound links exist.
4. Lighthouse mobile **and** desktop; over a network hop for the real
   number. Investigate any category below 100 — the artifact exceptions
   above are the only accepted ones.
5. Visual pass at phone and desktop widths: hero (still and film), every
   capture playing, reduced-motion fallbacks, no horizontal scroll.
6. Copy pass: claims vs `docs/TRUST.md`; product name is **SPAWN D** in
   anything a person reads.
7. After deploy: PageSpeed Insights on the live URL, Google's Rich Results
   Test on the live URL, sitemap submitted in Search Console, then watch
   CWV field data.

## Keeping this true

This runbook, SEO_TREE's requirements, and the flagship implementation move
together: a commit that changes the process or the bar updates this file in
the same commit, and the flagship stays the canonical example — if a better
page dethrones it, this document is where that's recorded.
