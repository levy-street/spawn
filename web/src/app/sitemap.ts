import type { MetadataRoute } from "next";
import { DOCS } from "@/app/docs/docs";
import { PAGES, pageContent, pageHref } from "@/lib/grimoire/catalogue";
import { TOOLS } from "@/lib/grimoire/tools";

const ORIGIN = "https://spawnd.dev";

/**
 * Every public page, enumerated: the hand-built marketing surfaces, the
 * grimoire catalogue, the tool pages, and the docs rendered on-site. App
 * surfaces behind the account gate are absent (and disallowed in robots.ts).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const marketing: MetadataRoute.Sitemap = [
    { url: `${ORIGIN}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${ORIGIN}/security`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${ORIGIN}/download`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${ORIGIN}/docs`, changeFrequency: "monthly", priority: 0.6 },
  ];
  const tools: MetadataRoute.Sitemap = TOOLS.map((tool) => ({
    url: `${ORIGIN}${tool.href}`,
    lastModified: new Date(tool.dateModified),
    changeFrequency: "monthly",
    priority: 0.8,
  }));
  const docs: MetadataRoute.Sitemap = DOCS.map((doc) => ({
    url: `${ORIGIN}/docs/${doc.slug}`,
    changeFrequency: "monthly",
    priority: 0.6,
  }));
  const pages: MetadataRoute.Sitemap = PAGES.map((page) => ({
    url: `${ORIGIN}${pageHref(page)}`,
    lastModified: new Date(pageContent(page).dateModified),
    changeFrequency: "monthly",
    priority: page.template === "hub" ? 0.9 : 0.8,
  }));
  return [...marketing, ...tools, ...docs, ...pages];
}
