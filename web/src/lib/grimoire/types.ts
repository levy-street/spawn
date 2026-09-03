/*
 * Shapes for the grimoire pages — the landing pages prescribed by the
 * keyword grimoire (spawnd-seo-grimoire.html at the repo root). Every page
 * is pure data: one slug off the root, rendered by its template through
 * app/[slug]. New templates extend the GrimoirePage union in catalogue.ts.
 */

export interface Faq {
  q: string;
  a: string;
}

/** A card for related racks and hub spokes. */
export interface RelatedLink {
  title: string;
  blurb: string;
  /** Site-relative href — grimoire pages and static routes both allowed. */
  href: string;
}

export interface Hero {
  plain: string;
  accent: string;
  /** One sentence: the page's promise to the searcher. */
  sub: string;
}

export interface Prose {
  heading: string;
  paragraphs: string[];
}

/** The fields every page carries, whatever its template. */
export interface PageBase {
  slug: string;
  /** <title>, ≤60 chars, query-matched. */
  title: string;
  /** Meta description, 110–165 chars. */
  description: string;
  /** ISO dates, kept honest. */
  datePublished: string;
  dateModified: string;
  hero: Hero;
  faq: Faq[];
  related: RelatedLink[];
  cardTitle: string;
  cardBlurb: string;
}

/** A code figure inside an article: one quiet caption, the lines verbatim. */
export interface ArticleCode {
  caption?: string;
  lines: string[];
}

export interface ArticleStep {
  title: string;
  body: string;
  code?: ArticleCode;
}

/**
 * The blocks an article is built from. Paragraph strings accept the inline
 * markup of inline.ts: `code` spans and [text](href) links, nothing else.
 */
export type ArticleBlock =
  | { kind: "prose"; heading: string; paragraphs: string[]; code?: ArticleCode }
  | { kind: "steps"; heading: string; lead?: string; steps: ArticleStep[] }
  | {
      kind: "table";
      heading: string;
      lead?: string;
      columns: string[];
      rows: string[][];
      note?: string;
    }
  | { kind: "points"; heading: string; lead?: string; items: { title: string; body: string }[] };

export type ArticleKind = "guide" | "fix" | "explainer" | "reference" | "roundup" | "definition";

/**
 * An article: the editorial frame around a sequence of blocks. Serves the
 * guides, fix pages, explainers, references, roundups, and definitions the
 * grimoire prescribes. `kind` selects the schema (guides emit HowTo from
 * their steps); `hub` is the breadcrumb and the page that racks it.
 */
export interface ArticleEntry extends PageBase {
  kind: ArticleKind;
  hub: { name: string; href: string };
  body: ArticleBlock[];
  /** The closing call's heading; the frame's default when absent. */
  start?: string;
}

/** A hub: an essay that teaches the category, then the rack of spokes. */
export interface HubEntry extends PageBase {
  essay: Prose[];
  spokes: RelatedLink[];
  rackHeading?: string;
}

export interface LedgerRow {
  label: string;
  spawnd: string;
  other: string;
}

/**
 * A comparison: respect the incumbent, name where the jobs diverge, measure
 * row by row, then say plainly when the other tool is the right choice.
 */
export interface ComparisonEntry extends PageBase {
  /** The incumbent's name — ledger column head and breadcrumb material. */
  name: string;
  intro: Prose;
  framing: Prose;
  ledger: { heading: string; rows: LedgerRow[] };
  verdict: {
    heading: string;
    paragraphs: string[];
    choose: { spawnd: string[]; other: { title: string; items: string[] } };
  };
}
