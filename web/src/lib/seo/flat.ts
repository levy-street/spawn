import { COMPARISONS } from "./comparisons";
import { DEVICES } from "./devices";
import type { FlatFaq, FlatPage, FlatRelatedLink } from "./flat-types";
import { HUBS } from "./hubs";

/*
 * The flat-slug page catalogue: app/[slug] renders from it, the sitemap
 * enumerates it, hubs and related racks resolve cards from it, and
 * flat.test.ts holds the invariants — including the denylist that keeps
 * flat slugs off the static app routes. Adding a flat page is one entry in
 * a template file (comparisons.ts, devices.ts); everything else follows.
 */

export const FLAT_PAGES: FlatPage[] = [
  ...COMPARISONS.map((comparison) => ({
    template: "comparison" as const,
    slug: comparison.slug,
    comparison,
  })),
  ...DEVICES.map((device) => ({
    template: "device" as const,
    slug: device.slug,
    device,
  })),
  ...HUBS.map((hub) => ({
    template: "hub" as const,
    slug: hub.slug,
    hub,
  })),
];

export function findFlatPage(slug: string): FlatPage | undefined {
  return FLAT_PAGES.find((page) => page.slug === slug);
}

export function flatPageHref(page: FlatPage): string {
  return `/${page.slug}`;
}

/** The eyebrow a related-rack card shows for a flat page's family. */
export const FLAT_FAMILY_TITLES: Record<FlatPage["template"], string> = {
  comparison: "Compared",
  device: "Devices",
  hub: "Hubs",
};

export interface FlatPageContent {
  title: string;
  description: string;
  datePublished: string;
  dateModified: string;
  faq: FlatFaq[];
  related: FlatRelatedLink[];
  cardTitle: string;
  cardBlurb: string;
}

/** The template-independent face of a flat page, for metadata and tests. */
export function flatPageContent(page: FlatPage): FlatPageContent {
  const entry =
    page.template === "comparison"
      ? page.comparison
      : page.template === "device"
        ? page.device
        : page.hub;
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

/** Card copy for a flat page, for hubs and related racks. */
export function flatPageCard(page: FlatPage): { title: string; blurb: string; href: string } {
  const content = flatPageContent(page);
  return {
    title: content.cardTitle,
    blurb: content.cardBlurb,
    href: flatPageHref(page),
  };
}
