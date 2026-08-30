import { COMPARISONS } from "./comparisons";
import type { FlatPage } from "./flat-types";

/*
 * The flat-slug page catalogue: app/[slug] renders from it, the sitemap
 * enumerates it, hubs and related racks resolve cards from it, and
 * flat.test.ts holds the invariants — including the denylist that keeps
 * flat slugs off the static app routes. Adding a flat page is one entry in
 * a template file (comparisons.ts today); everything else follows.
 */

export const FLAT_PAGES: FlatPage[] = COMPARISONS.map((comparison) => ({
  template: "comparison" as const,
  slug: comparison.slug,
  comparison,
}));

export function findFlatPage(slug: string): FlatPage | undefined {
  return FLAT_PAGES.find((page) => page.slug === slug);
}

export function flatPageHref(page: FlatPage): string {
  return `/${page.slug}`;
}

/** Card copy for a flat page, for hubs and related racks. */
export function flatPageCard(page: FlatPage): { title: string; blurb: string; href: string } {
  return {
    title: page.comparison.cardTitle,
    blurb: page.comparison.cardBlurb,
    href: flatPageHref(page),
  };
}
