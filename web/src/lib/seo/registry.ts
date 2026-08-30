import { AGENTS } from "./agents";
import { findFlatPage, flatPageCard } from "./flat";
import type { SeoFamily, SeoPage } from "./types";
import { USE_CASES } from "./use-cases";

/*
 * The one catalogue every consumer reads: the family routes render from it,
 * the sitemap enumerates it, the colophon links its indexes, and the tests
 * hold its invariants. Adding a landing page is one entry in one of the
 * family files — everything else follows.
 *
 * The comparison family has moved to flat slugs (lib/seo/flat.ts, rendered
 * by app/[slug] — docs/SEO_TREE.md): the /vs hub now racks flat cards, and
 * `related` keys starting with "/" resolve against the flat catalogue.
 */

export const SEO_PAGES: SeoPage[] = [...USE_CASES, ...AGENTS];

export const SEO_FAMILIES: Record<
  SeoFamily,
  { title: string; blurb: string; indexTitle: string; indexDescription: string }
> = {
  use: {
    title: "Use cases",
    blurb: "The jobs spawnd is summoned for.",
    indexTitle: "What people use spawnd for",
    indexDescription:
      "Remote terminals for coding agents, home servers, and GPU rigs — from any browser, with no open ports and end-to-end encryption.",
  },
  for: {
    title: "Agents",
    blurb: "The daemons your daemons run.",
    indexTitle: "Run any CLI coding agent remotely",
    indexDescription:
      "Claude Code, Codex, Aider, and OpenCode on your own machines, reachable from every device you approve. Agents are visible command shortcuts — never a wrapper.",
  },
  vs: {
    title: "Compared",
    blurb: "Where spawnd stands among the alternatives.",
    indexTitle: "spawnd, compared to the alternatives",
    indexDescription:
      "Honest comparisons against SSH + tmux, Tailscale, mosh, Cloudflare Tunnel, Codespaces, and the rest of the field — including when the other tool is the right choice.",
  },
};

export function seoPagesByFamily(family: SeoFamily): SeoPage[] {
  return SEO_PAGES.filter((page) => page.family === family);
}

export function findSeoPage(family: SeoFamily, slug: string): SeoPage | undefined {
  return SEO_PAGES.find((page) => page.family === family && page.slug === slug);
}

/** "family/slug" → the page, for resolving `related` keys. */
export function findSeoPageByKey(key: string): SeoPage | undefined {
  const [family, ...rest] = key.split("/");
  return findSeoPage(family as SeoFamily, rest.join("/"));
}

export function seoPageHref(page: SeoPage): string {
  return `/${page.family}/${page.slug}`;
}

export interface RelatedCard {
  href: string;
  familyTitle: string;
  title: string;
  blurb: string;
}

/**
 * Resolve one `related` key to card copy: "family/slug" against this
 * registry, "/flat-slug" against the flat catalogue. Undefined means the
 * key is dead — the tests treat that as a failure, the template skips it.
 */
export function resolveRelatedCard(key: string): RelatedCard | undefined {
  if (key.startsWith("/")) {
    const flat = findFlatPage(key.slice(1));
    if (!flat) return undefined;
    const card = flatPageCard(flat);
    return { href: card.href, familyTitle: "Compared", title: card.title, blurb: card.blurb };
  }
  const page = findSeoPageByKey(key);
  if (!page) return undefined;
  return {
    href: seoPageHref(page),
    familyTitle: SEO_FAMILIES[page.family].title,
    title: page.cardTitle,
    blurb: page.cardBlurb,
  };
}
