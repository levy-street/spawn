import { describe, expect, it } from "bun:test";
import { FLAT_PAGES } from "./flat";
import {
  resolveRelatedCard,
  SEO_FAMILIES,
  SEO_PAGES,
  seoPageHref,
  seoPagesByFamily,
} from "./registry";

describe("seo landing-page registry", () => {
  it("has globally unique hrefs", () => {
    const hrefs = SEO_PAGES.map(seoPageHref);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("uses kebab-case slugs that make clean URLs", () => {
    for (const page of SEO_PAGES) {
      expect(page.slug, page.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("populates every family (vs lives on flat slugs)", () => {
    for (const family of Object.keys(SEO_FAMILIES) as (keyof typeof SEO_FAMILIES)[]) {
      const count =
        family === "vs"
          ? FLAT_PAGES.filter((page) => page.template === "comparison").length
          : seoPagesByFamily(family).length;
      expect(count, family).toBeGreaterThan(0);
    }
  });

  it("keeps titles and descriptions inside search-snippet budgets", () => {
    for (const page of SEO_PAGES) {
      expect(page.title.length, `${page.slug} title`).toBeGreaterThan(0);
      expect(page.title.length, `${page.slug} title: ${page.title}`).toBeLessThanOrEqual(65);
      expect(page.description.length, `${page.slug} description`).toBeGreaterThan(0);
      expect(
        page.description.length,
        `${page.slug} description: ${page.description}`,
      ).toBeLessThanOrEqual(165);
    }
  });

  it("gives every page a body, questions, and card copy", () => {
    for (const page of SEO_PAGES) {
      expect(page.sections.length, page.slug).toBeGreaterThan(0);
      expect(page.faq.length, page.slug).toBeGreaterThanOrEqual(2);
      expect(page.cardTitle, page.slug).not.toBe("");
      expect(page.cardBlurb, page.slug).not.toBe("");
    }
  });

  it("cross-links only to pages that exist, never to itself", () => {
    for (const page of SEO_PAGES) {
      expect(page.related.length, page.slug).toBeGreaterThan(0);
      for (const key of page.related) {
        const card = resolveRelatedCard(key);
        expect(card, `${page.slug} → ${key}`).toBeDefined();
        expect(`${page.family}/${page.slug}`, `${page.slug} links to itself`).not.toBe(key);
      }
    }
  });
});
