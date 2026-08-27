import { AGENTS } from "./agents";
import { COMPARISONS } from "./comparisons";
import type { SeoFamily, SeoPage } from "./types";
import { USE_CASES } from "./use-cases";

/*
 * The one catalogue every consumer reads: the three dynamic routes render
 * from it, the sitemap enumerates it, the colophon links its indexes, and
 * the tests hold its invariants. Adding a landing page is one entry in one
 * of the family files — everything else follows.
 */

export const SEO_PAGES: SeoPage[] = [...USE_CASES, ...AGENTS, ...COMPARISONS];

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
      "Honest comparisons against SSH + tmux, VS Code Remote Tunnels, tmate, Coder, and Tailscale SSH — including when the other tool is the right choice.",
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
