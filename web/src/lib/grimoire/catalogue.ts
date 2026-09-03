import { ARTICLE_HUBS, ARTICLES } from "./articles";
import { COMPARISONS } from "./comparisons";
import { HUBS } from "./hubs";
import type { ArticleEntry, ComparisonEntry, Faq, HubEntry, RelatedLink } from "./types";

/*
 * The page catalogue: app/[slug] renders from it, the sitemap enumerates
 * it, hubs and related racks resolve cards from it, and catalogue.test.ts
 * holds the invariants — including the denylist that keeps slugs off the
 * static app routes. Adding a page is one entry in a template file.
 */

export type GrimoirePage =
  | { template: "article"; slug: string; article: ArticleEntry }
  | { template: "hub"; slug: string; hub: HubEntry }
  | { template: "comparison"; slug: string; comparison: ComparisonEntry };

export const PAGES: GrimoirePage[] = [
  ...[...HUBS, ...ARTICLE_HUBS].map((hub) => ({ template: "hub" as const, slug: hub.slug, hub })),
  ...ARTICLES.map((article) => ({ template: "article" as const, slug: article.slug, article })),
  ...COMPARISONS.map((comparison) => ({
    template: "comparison" as const,
    slug: comparison.slug,
    comparison,
  })),
];

export function findPage(slug: string): GrimoirePage | undefined {
  return PAGES.find((page) => page.slug === slug);
}

export function pageHref(page: GrimoirePage): string {
  return `/${page.slug}`;
}

export interface PageContent {
  title: string;
  description: string;
  datePublished: string;
  dateModified: string;
  faq: Faq[];
  related: RelatedLink[];
  cardTitle: string;
  cardBlurb: string;
}

/** The template-independent face of a page, for metadata, racks, and tests. */
export function pageContent(page: GrimoirePage): PageContent {
  const entry =
    page.template === "article"
      ? page.article
      : page.template === "hub"
        ? page.hub
        : page.comparison;
  return {
    title: entry.title,
    description: entry.description,
    datePublished: entry.datePublished,
    dateModified: entry.dateModified,
    faq: entry.faq,
    related: entry.related,
    cardTitle: entry.cardTitle,
    cardBlurb: entry.cardBlurb,
  };
}

/** The card for a page, for hubs and related racks. */
export function pageCard(page: GrimoirePage): RelatedLink {
  const content = pageContent(page);
  return { title: content.cardTitle, blurb: content.cardBlurb, href: pageHref(page) };
}
