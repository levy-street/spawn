import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { findPage, PAGES, pageContent, pageHref } from "./catalogue";
import { inlineLinks } from "./inline";
import { TOOLS } from "./tools";

/*
 * Invariants for the grimoire catalogue — most importantly the denylist: a
 * slug landing on a static app route or a public/ top-level name would be
 * silently shadowed (Next prefers static matches), so the collision fails
 * here instead of in production. Every link, inline or related, must land
 * on a page that exists.
 */

const APP_DIR = join(import.meta.dir, "../../app");
const PUBLIC_DIR = join(import.meta.dir, "../../../public");

/** Names the root URL namespace already owns. */
function reservedNames(): Set<string> {
  const names = new Set<string>(["api", "ws", "healthz", "_next"]);
  for (const entry of readdirSync(APP_DIR, { withFileTypes: true })) {
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

const reserved = reservedNames();

/** A site-relative href resolves to a catalogue page, a static route, or a tool. */
function resolves(href: string): boolean {
  if (!href.startsWith("/")) return /^https:\/\//.test(href);
  const segment = href.slice(1).split(/[#?]/)[0];
  if (segment === "") return true;
  if (segment.includes("/")) return reserved.has(segment.split("/")[0]);
  return (
    findPage(segment) !== undefined ||
    reserved.has(segment) ||
    TOOLS.some((tool) => tool.href === `/${segment}`)
  );
}

/** Every string on a page that may carry inline markup. */
function texts(page: (typeof PAGES)[number]): string[] {
  const c = pageContent(page);
  const out = [...c.faq.map((item) => item.a), ...c.faq.map((item) => item.q)];
  if (page.template === "article") {
    const a = page.article;
    out.push(a.hero.sub);
    for (const block of a.body) {
      if (block.kind === "prose") out.push(...block.paragraphs);
      if (block.kind === "steps") out.push(block.lead ?? "", ...block.steps.map((s) => s.body));
      if (block.kind === "points") out.push(block.lead ?? "", ...block.items.map((i) => i.body));
      if (block.kind === "table")
        out.push(block.lead ?? "", block.note ?? "", ...block.rows.flat());
    }
  } else if (page.template === "hub") {
    out.push(...page.hub.essay.flatMap((section) => section.paragraphs));
  } else {
    const c2 = page.comparison;
    out.push(...c2.intro.paragraphs, ...c2.framing.paragraphs, ...c2.verdict.paragraphs);
  }
  return out;
}

describe("the grimoire catalogue", () => {
  it("never collides with a static route or public asset (the denylist)", () => {
    for (const page of PAGES) {
      expect(reserved.has(page.slug), `/${page.slug} shadows a static name`).toBe(false);
    }
  });

  it("has globally unique slugs that make clean URLs", () => {
    const slugs = PAGES.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug, slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("keeps titles and descriptions inside search-snippet budgets", () => {
    for (const page of PAGES) {
      const { title, description } = pageContent(page);
      expect(title.length, `${page.slug} title: ${title}`).toBeLessThanOrEqual(60);
      expect(title.length, `${page.slug} title`).toBeGreaterThan(0);
      expect(description.length, `${page.slug} description`).toBeGreaterThanOrEqual(110);
      expect(description.length, `${page.slug} description: ${description}`).toBeLessThanOrEqual(
        165,
      );
    }
  });

  it("keeps dates honest ISO, cards filled, and questions answered", () => {
    for (const page of PAGES) {
      const c = pageContent(page);
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

  it("gives every article a body, a resolvable hub, and steps when it is a guide", () => {
    for (const page of PAGES) {
      if (page.template !== "article") continue;
      const a = page.article;
      expect(a.body.length, page.slug).toBeGreaterThanOrEqual(3);
      expect(resolves(a.hub.href), `${page.slug} hub ${a.hub.href}`).toBe(true);
      if (a.kind === "guide") {
        expect(
          a.body.some((block) => block.kind === "steps"),
          `${page.slug} guide has no steps`,
        ).toBe(true);
      }
    }
  });

  it("gives every comparison its full editorial shape", () => {
    for (const page of PAGES) {
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

  it("racks every spoke on a page that exists", () => {
    for (const page of PAGES) {
      if (page.template !== "hub") continue;
      expect(page.hub.spokes.length, page.slug).toBeGreaterThan(0);
      for (const spoke of page.hub.spokes) {
        expect(resolves(spoke.href), `${page.slug} spoke → ${spoke.href} resolves to nothing`).toBe(
          true,
        );
      }
    }
  });

  it("links only to pages that exist, never to itself", () => {
    for (const page of PAGES) {
      const { related } = pageContent(page);
      expect(related.length, page.slug).toBeGreaterThan(0);
      for (const link of related) {
        expect(link.href.startsWith("/"), `${page.slug} → ${link.href}`).toBe(true);
        expect(link.href, `${page.slug} links to itself`).not.toBe(pageHref(page));
        expect(resolves(link.href), `${page.slug} → ${link.href} resolves to nothing`).toBe(true);
      }
      for (const text of texts(page)) {
        for (const href of inlineLinks(text)) {
          expect(resolves(href), `${page.slug} → ${href} resolves to nothing`).toBe(true);
          expect(href, `${page.slug} links to itself`).not.toBe(pageHref(page));
        }
      }
    }
  });

  it("keeps the tool pages real static routes", () => {
    for (const tool of TOOLS) {
      expect(reserved.has(tool.href.slice(1)), `${tool.href} is not a static route`).toBe(true);
    }
  });
});
