/*
 * Shapes for flat-slug landing pages (docs/SEO_TREE.md URL policy: every
 * page is a single slug off the root). Pages are pure data — no JSX — so
 * the sitemap enumerates them, tests hold the invariants, and each template
 * component turns one entry into a page. New templates extend FlatPage's
 * union; the [slug] router switches on `template`.
 */

export interface FlatFaq {
  q: string;
  a: string;
}

/** A card for related racks and hub featuring. */
export interface FlatRelatedLink {
  title: string;
  blurb: string;
  /** Site-relative href — flat pages and static routes both allowed. */
  href: string;
}

export interface LedgerRow {
  label: string;
  spawnd: string;
  other: string;
}

export interface FlatProse {
  heading: string;
  paragraphs: string[];
}

/** @deprecated alias kept while comparisons predate the generic name. */
export type ComparisonProse = FlatProse;

/** One device-frame capture: a real session moment from the live app. */
export interface DeviceVignette {
  src: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
}

/**
 * One hub page (the hub template): an essay that teaches the category,
 * then the rack of spokes. Hubs carry the site-level schema
 * (Organization + SoftwareApplication) per docs/SEO_TREE.md.
 */
export interface HubEntry {
  slug: string;
  title: string;
  description: string;
  datePublished: string;
  dateModified: string;
  hero: { plain: string; accent: string; sub: string };
  essay: FlatProse[];
  /** The spoke rack: the pages this hub exists to route. */
  spokes: FlatRelatedLink[];
  /** The rack's heading; the template's default when absent. */
  rackHeading?: string;
  faq: FlatFaq[];
  related: FlatRelatedLink[];
  cardTitle: string;
  cardBlurb: string;
}

/**
 * One device page (the device template): teach-first intro, what spawnd
 * makes of the device, the signature agent moments in phone frames, and
 * the away-from-desk close. Captures are real sessions, per the runbook.
 */
export interface DeviceEntry {
  slug: string;
  title: string;
  description: string;
  datePublished: string;
  dateModified: string;
  hero: { plain: string; accent: string; sub: string };
  /** Teach-first: the honest routes that exist without spawnd. */
  intro: FlatProse;
  /** What spawnd makes of the device. */
  shape: FlatProse;
  /** The whole app on the device — media for the shape section. */
  grid: DeviceVignette;
  /** The signature: two agent moments, side by side in phone frames. */
  moments: {
    heading: string;
    lead: string;
    vignettes: [DeviceVignette, DeviceVignette];
  };
  /** The away-from-desk close: persistence and attention. */
  away: FlatProse;
  faq: FlatFaq[];
  related: FlatRelatedLink[];
  cardTitle: string;
  cardBlurb: string;
}

/**
 * One comparison page (the comparison template): teach-first intro, the
 * categorical difference, the ledger, one product capture, the honest
 * verdict. House rules live in comparisons.ts.
 */
export interface ComparisonEntry {
  /** The full flat slug, e.g. "spawnd-vs-tailscale-ssh". */
  slug: string;
  /** The incumbent's name — ledger column head and breadcrumb material. */
  name: string;
  /** <title>, ≤60 chars, query-matched. */
  title: string;
  /** Meta description, 140–160 chars. */
  description: string;
  /** ISO dates, kept honest. */
  datePublished: string;
  dateModified: string;
  hero: { plain: string; accent: string; sub: string };
  /** Teach-first: what the incumbent is and what it's honestly good at. */
  intro: ComparisonProse;
  /** Where the jobs genuinely diverge — spawnd enters here. */
  framing: ComparisonProse;
  ledger: { heading: string; rows: LedgerRow[] };
  /** Caption for the one product capture the page shows. */
  capture: { caption: string };
  verdict: {
    heading: string;
    paragraphs: string[];
    choose: {
      spawnd: string[];
      other: { title: string; items: string[] };
    };
  };
  faq: FlatFaq[];
  related: FlatRelatedLink[];
  /** Short label + blurb for hub cards and related racks. */
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
 * markup of lib/seo/inline.ts: `code` spans and [text](href) links, nothing
 * else — enough to cite a doc or name a flag, not enough to smuggle layout
 * into data.
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
  | { kind: "points"; heading: string; lead?: string; items: { title: string; body: string }[] }
  /** The one product capture, placed by the author where the product enters. */
  | { kind: "capture"; caption: string };

export type ArticleKind = "guide" | "fix" | "explainer" | "reference" | "roundup" | "definition";

/**
 * One article page (the article template): the editorial frame around a
 * sequence of blocks. It serves the guide, fix, explainer, reference,
 * roundup, and definition rows of docs/SEO_TREE.md — pages whose signature
 * is the writing itself, not a capture. `kind` selects the schema (guides
 * emit HowTo from their steps) and the crumb; the hub racks the page.
 */
export interface ArticleEntry {
  slug: string;
  kind: ArticleKind;
  /** The hub that crumbs and racks this page — a flat hub or a static route. */
  hub: { name: string; href: string };
  title: string;
  description: string;
  datePublished: string;
  dateModified: string;
  hero: { plain: string; accent: string; sub: string };
  body: ArticleBlock[];
  /** The CTA moment's heading; the frame's default when absent. */
  start?: string;
  faq: FlatFaq[];
  related: FlatRelatedLink[];
  cardTitle: string;
  cardBlurb: string;
}

export type FlatPage =
  | { template: "comparison"; slug: string; comparison: ComparisonEntry }
  | { template: "device"; slug: string; device: DeviceEntry }
  | { template: "hub"; slug: string; hub: HubEntry }
  | { template: "article"; slug: string; article: ArticleEntry };
