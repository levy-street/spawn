# SEO precedents — how the winners actually do it

Research pass, 2026-08-27. Live pages studied; companion to `SEO_TREE.md`.

## The headline finding

**The winners run two different page types and never hybridize them.**
Educational content pages (guides, tutorials, explainers) win informational
queries; branded landing pages serve navigational/commercial intent. Every
iteration problem we had with `/run-agents-in-parallel` traces to fusing the
two into one page.

Proof from our own flagship SERP ("run multiple claude code sessions in
parallel", checked 2026-08-27): every ranking page is guide-shaped —
Conductor's docs guide, MindStudio's blog how-tos, codeagentswarm's
"3 Ways (2026)" guide, Anthropic's own announcement. **Zero classic landing
pages rank.** Two of the winners (Conductor, codeagentswarm) are direct
competitors in the parallel-Claude niche → add both to the /vs quarry.

## Exemplars and what each proves

**Warp · Terminus (warp.dev/terminus)** — ~170+ pure-utility terminal
articles ("Bash Aliases", "Git Clone Over SSH") organized by topic (Bash 17,
Git 18, Docker 37…). Product appears as a complementary aside/download
section, never the premise. Proves: a terminal-adjacent product can build a
content moat on command-line know-how at scale; the article carries zero
sales narrative.

**Conductor docs guide (conductor.build/docs/…/run-multiple-claude-code-sessions)**
— the page that wins our flagship query. ~800 words, docs chrome, title is
the query verbatim, imperative step headings (Prepare/Create/Start/Run/
Review), **acknowledges Claude Code's native `--worktree` alternative
upfront**, positions the product as the organizational layer (sidebar,
scripts, diff review) rather than the enabler. Proves: for informational
queries, docs-style + honest-alternatives-first + product-as-optimal-layer
is the ranking format.

**DigitalOcean community tutorials** — the original tutorial moat: pure
how-to content, product only in the chrome. Proves the model compounds for
a decade-plus.

**Tailscale /compare/* (e.g. /compare/zerotier)** — ~1,200–1,400 words,
prose comparison over a fixed rubric (setup → connectivity → security →
performance → administration → bottom line), genuinely credits the
competitor ("both outstanding alternatives"), CTAs top-nav + end only.
Weakness we can beat: no table, no FAQ schema.

**Tailscale /learn/ngrok-alternatives** — the listicle pattern: ~70/30
educational-to-promotional, five alternatives covered methodically,
Tailscale listed fifth (not first), honest per-tool caveats, comparison
matrix as the link-worthy asset. Proves: appear as the impartial guide;
win on depth, not placement.

**PostHog /blog/posthog-vs-*** — comparison with named authors + dates,
one scannable feature table (with honest concessions — their own beta
features marked), testimonials mid-page, conversational voice, CTAs organic.
Proves: transparency IS the conversion strategy; bylines + freshness dates
are trust signals worth having.

**Zapier app-pair pages** — ~85% templated, data-as-content; works only
because the data itself answers the query. Analog for us: the agent × topic
guide matrix — valid only where per-agent facts are real (our no-thin-pages
rule already covers this).

## Format rules extracted (informational/guide pages)

- Title = the query, verbatim; visible date, kept fresh ("(2026)" in titles
  is working for competitors).
- Docs-like chrome: light branding, content-first; numbered ways/steps with
  imperative headings; real code blocks; anchor links.
- **Name the native/DIY answers first** (terminal tabs, tmux, Claude Code's
  own `--worktree`) before the product — the honesty is the ranking signal.
- Product enters late as "the optimal setup", framed as the layer that holds
  the taught pattern; one CTA at the end plus chrome.
- 800–1,500 words. FAQ block for long-tail + schema.

## Format rules extracted (comparison/listicle pages)

- Fixed rubric of prose sections + one scannable table with honest
  concessions; credit the competitor's real strengths; bottom-line section
  that names when to choose them.
- Authors + dates. 1,200–1,500 words. CTAs top-nav and end only.
- Listicles: cover 4–6 real options methodically; place ourselves credibly
  within the set, not atop it.

## Implications for the tree (proposed)

1. **Promote /guides from second-wave to spearhead.** The informational
   queries — including the flagship — are won by guide pages. The guide/docs
   template becomes the primary volume driver and the first template to
   perfect.
2. **Re-slot pages by intent.** Much of the current /use row is
   informational → those queries get guide-format pages. Branded landing
   pages (ink heroes, the approved baseline) remain for
   commercial/navigational intent: hubs, /vs, pillar pages, and a small set
   of product-story pages.
3. `/run-agents-in-parallel` itself should be **guide-shaped** — the
   teach-first arc we built is the right content in the wrong costume;
   recut it in the guide template (docs chrome, date, numbered ways, code
   blocks, honest "when tmux is enough", spawnd as the last way).
4. Comparison template: add the table + FAQ schema Tailscale lacks; adopt
   their fixed rubric; add bylines/dates.
5. New /vs quarry entries: conductor · codeagentswarm (direct competitors
   in the parallel-agents niche).
