import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { FLAT_PAGES, findFlatPage, flatPageHref } from "./flat";

/*
 * Invariants for the flat-slug catalogue — most importantly the denylist:
 * a flat slug landing on a static app route or a public/ top-level name
 * would be silently shadowed (Next prefers static matches), so the
 * collision fails here instead of in production.
 */

const APP_DIR = join(import.meta.dir, "../../app");
const PUBLIC_DIR = join(import.meta.dir, "../../../public");

/** Names the root URL namespace already owns. */
function reservedNames(): Set<string> {
  const names = new Set<string>(["api", "ws", "healthz", "_next"]);
  for (const entry of readdirSync(APP_DIR, { withFileTypes: true })) {
    // Route groups don't take a URL segment; the catch-all is the router itself.
    if (entry.isDirectory() && !entry.name.startsWith("[") && !entry.name.startsWith("(")) {
      names.add(entry.name);
    }
  }
  for (const entry of readdirSync(PUBLIC_DIR, { withFileTypes: true })) {
    names.add(entry.isDirectory() ? entry.name : entry.name.replace(/\.[^.]+$/, ""));
    names.add(entry.name);
  }
  return names;
}

describe("flat-slug page catalogue", () => {
  it("never collides with a static route or public asset (the denylist)", () => {
    const reserved = reservedNames();
    for (const page of FLAT_PAGES) {
      expect(reserved.has(page.slug), `/${page.slug} shadows a static name`).toBe(false);
    }
  });

  it("has globally unique slugs that make clean URLs", () => {
    const slugs = FLAT_PAGES.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug, slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("keeps titles and descriptions inside search-snippet budgets", () => {
    for (const page of FLAT_PAGES) {
      const { title, description } = page.comparison;
      expect(title.length, `${page.slug} title: ${title}`).toBeLessThanOrEqual(60);
      expect(title.length, `${page.slug} title`).toBeGreaterThan(0);
      expect(description.length, `${page.slug} description`).toBeGreaterThanOrEqual(110);
      expect(description.length, `${page.slug} description: ${description}`).toBeLessThanOrEqual(
        165,
      );
    }
  });

  it("keeps dates honest ISO and cards filled", () => {
    for (const page of FLAT_PAGES) {
      const c = page.comparison;
      expect(c.datePublished, page.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.dateModified, page.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.dateModified >= c.datePublished, `${page.slug} modified before published`).toBe(
        true,
      );
      expect(c.cardTitle, page.slug).not.toBe("");
      expect(c.cardBlurb, page.slug).not.toBe("");
    }
  });

  it("gives every comparison its full editorial shape", () => {
    for (const page of FLAT_PAGES) {
      const c = page.comparison;
      expect(c.intro.paragraphs.length, page.slug).toBeGreaterThan(0);
      expect(c.framing.paragraphs.length, page.slug).toBeGreaterThan(0);
      expect(c.ledger.rows.length, `${page.slug} ledger`).toBeGreaterThanOrEqual(5);
      expect(c.verdict.paragraphs.length, page.slug).toBeGreaterThan(0);
      expect(c.verdict.choose.spawnd.length, page.slug).toBeGreaterThan(0);
      expect(c.verdict.choose.other.items.length, page.slug).toBeGreaterThan(0);
      expect(c.faq.length, page.slug).toBeGreaterThanOrEqual(2);
    }
  });

  it("cross-links only to site-relative pages, never to itself", () => {
    for (const page of FLAT_PAGES) {
      expect(page.comparison.related.length, page.slug).toBeGreaterThan(0);
      for (const link of page.comparison.related) {
        expect(link.href.startsWith("/"), `${page.slug} → ${link.href}`).toBe(true);
        expect(link.href, `${page.slug} links to itself`).not.toBe(flatPageHref(page));
        // A single-segment href must be a real flat page or a static route.
        const segment = link.href.slice(1);
        if (!segment.includes("/")) {
          const known = findFlatPage(segment) !== undefined || reservedNames().has(segment);
          expect(known, `${page.slug} → ${link.href} resolves to nothing`).toBe(true);
        }
      }
    }
  });
});
