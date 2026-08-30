import type { MetadataRoute } from "next";
import { SEO_PAGES, seoPageHref } from "@/lib/seo/registry";

const ORIGIN = "https://spawnd.dev";

/**
 * Every public page, enumerated: the hand-built marketing surfaces plus the
 * whole landing-page registry. App surfaces behind the account gate are
 * deliberately absent (and disallowed in robots.ts).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const marketing: MetadataRoute.Sitemap = [
    { url: `${ORIGIN}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${ORIGIN}/security`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${ORIGIN}/download`, changeFrequency: "monthly", priority: 0.8 },
    // Flat-slug job pages (docs/SEO_TREE.md). The [slug] router will make
    // this a map over the flat-page registry; until then, by hand.
    {
      url: `${ORIGIN}/run-agents-in-parallel`,
      lastModified: new Date("2026-08-30"),
      changeFrequency: "monthly",
      priority: 0.9,
    },
    { url: `${ORIGIN}/use`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${ORIGIN}/for`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${ORIGIN}/vs`, changeFrequency: "weekly", priority: 0.6 },
  ];
  const landing: MetadataRoute.Sitemap = SEO_PAGES.map((page) => ({
    url: `${ORIGIN}${seoPageHref(page)}`,
    changeFrequency: "monthly",
    priority: 0.7,
  }));
  return [...marketing, ...landing];
}
