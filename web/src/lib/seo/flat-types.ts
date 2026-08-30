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

export interface ComparisonProse {
  heading: string;
  paragraphs: string[];
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

export type FlatPage = {
  template: "comparison";
  slug: string;
  comparison: ComparisonEntry;
};
