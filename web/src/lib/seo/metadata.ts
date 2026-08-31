import type { Metadata } from "next";
import { SEO_FAMILIES, seoPageHref } from "./registry";
import type { SeoFamily, SeoPage } from "./types";

/*
 * Metadata for the landing-page catalogue. The root layout supplies
 * metadataBase and the `%s · spawnd` title template; these add the
 * page-specific fields and the canonical URL the sitemap agrees with.
 */

export function seoPageMetadata(page: SeoPage): Metadata {
  const href = seoPageHref(page);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: href },
    openGraph: {
      title: page.title,
      description: page.description,
      url: href,
      siteName: "spawnd",
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
    },
  };
}

export function seoFamilyMetadata(family: SeoFamily): Metadata {
  const meta = SEO_FAMILIES[family];
  return {
    title: meta.indexTitle,
    description: meta.indexDescription,
    alternates: { canonical: `/${family}` },
    openGraph: {
      title: meta.indexTitle,
      description: meta.indexDescription,
      url: `/${family}`,
      siteName: "spawnd",
      type: "website",
    },
  };
}
