import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FLAT_PAGES, findFlatPage, flatPageContent, flatPageHref } from "./flat";
import { inlineLinks } from "./inline";

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
      const { title, description } = flatPageContent(page);
      expect(title.length, `${page.slug} title: ${title}`).toBeLessThanOrEqual(60);
      expect(title.length, `${page.slug} title`).toBeGreaterThan(0);
      expect(description.length, `${page.slug} description`).toBeGreaterThanOrEqual(110);
      expect(description.length, `${page.slug} description: ${description}`).toBeLessThanOrEqual(
        165,
      );
    }
  });

  it("keeps dates honest ISO, cards filled, and questions answered", () => {
    for (const page of FLAT_PAGES) {
      const c = flatPageContent(page);
      expect(c.datePublished, page.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.dateModified, page.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.dateModified >= c.datePublished, `${page.slug} modified before published`).toBe(
        true,
      );
      expect(c.cardTitle, page.slug).not.toBe("");
      expect(c.cardBlurb, page.slug).not.toBe("");
      expect(c.faq.length, page.slug).toBeGreaterThanOrEqual(2);
    }
  });

  it("gives every comparison its full editorial shape", () => {
    for (const page of FLAT_PAGES) {
      if (page.template !== "comparison") continue;
      const c = page.comparison;
      expect(c.intro.paragraphs.length, page.slug).toBeGreaterThan(0);
      expect(c.framing.paragraphs.length, page.slug).toBeGreaterThan(0);
      expect(c.ledger.rows.length, `${page.slug} ledger`).toBeGreaterThanOrEqual(5);
      expect(c.verdict.paragraphs.length, page.slug).toBeGreaterThan(0);
      expect(c.verdict.choose.spawnd.length, page.slug).toBeGreaterThan(0);
      expect(c.verdict.choose.other.items.length, page.slug).toBeGreaterThan(0);
    }
  });

  it("gives every device page real captures that exist on disk", () => {
    for (const page of FLAT_PAGES) {
      if (page.template !== "device") continue;
      const d = page.device;
      expect(d.intro.paragraphs.length, page.slug).toBeGreaterThan(0);
      expect(d.shape.paragraphs.length, page.slug).toBeGreaterThan(0);
      expect(d.away.paragraphs.length, page.slug).toBeGreaterThan(0);
      const captures = [d.grid, ...d.moments.vignettes];
      for (const vignette of captures) {
        expect(vignette.alt.length, `${page.slug} ${vignette.src} alt`).toBeGreaterThan(20);
        expect(
          existsSync(join(PUBLIC_DIR, vignette.src)),
          `${page.slug}: capture missing on disk: ${vignette.src}`,
        ).toBe(true);
      }
    }
  });

  it("gives every article a body, a resolvable hub, and links that resolve", () => {
    const reserved = reservedNames();
    const resolves = (href: string) => {
      if (!href.startsWith("/")) return /^https:\/\//.test(href);
      const segment = href.slice(1).split(/[#?]/)[0];
      if (segment.includes("/")) return true;
      return findFlatPage(segment) !== undefined || reserved.has(segment);
    };
    for (const page of FLAT_PAGES) {
      if (page.template !== "article") continue;
      const a = page.article;
      expect(a.body.length, page.slug).toBeGreaterThanOrEqual(3);
      expect(resolves(a.hub.href), `${page.slug} hub ${a.hub.href}`).toBe(true);
      expect(
        a.body.filter((block) => block.kind === "capture").length,
        page.slug,
      ).toBeLessThanOrEqual(1);
      if (a.kind === "guide") {
        expect(
          a.body.some((block) => block.kind === "steps"),
          `${page.slug} guide has no steps`,
        ).toBe(true);
      }
      const texts: string[] = [a.hero.sub, ...a.faq.map((item) => item.a)];
      for (const block of a.body) {
        if (block.kind === "prose") texts.push(...block.paragraphs);
        if (block.kind === "steps") texts.push(block.lead ?? "", ...block.steps.map((s) => s.body));
        if (block.kind === "points")
          texts.push(block.lead ?? "", ...block.items.map((i) => i.body));
        if (block.kind === "table")
          texts.push(block.lead ?? "", block.note ?? "", ...block.rows.flat());
      }
      for (const text of texts) {
        for (const href of inlineLinks(text)) {
          expect(resolves(href), `${page.slug} → ${href} resolves to nothing`).toBe(true);
          expect(href, `${page.slug} links to itself`).not.toBe(flatPageHref(page));
        }
      }
    }
  });

  it("cross-links only to site-relative pages, never to itself", () => {
    for (const page of FLAT_PAGES) {
      const { related } = flatPageContent(page);
      expect(related.length, page.slug).toBeGreaterThan(0);
      for (const link of related) {
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
