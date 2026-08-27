/*
 * The SEO landing-page registry's shape. Pages are pure data — no JSX — so
 * the whole catalogue can be rendered by one template, enumerated by the
 * sitemap, and invariant-checked by unit tests. Titles and H1s speak the
 * searcher's language; the demon voice lives in body copy and the chrome.
 */

export type SeoFamily = "use" | "for" | "vs";

/** A heading split so the template can ink the accent in hellfire. */
export type Accent = {
  plain: string;
  accent?: string;
};

export type Faq = {
  q: string;
  a: string;
};

/** One column of a two-panel comparison card (the honest-ledger pattern). */
export type Panel = {
  title: string;
  /** bone = ours/the strong claim, ash = theirs/the concession. */
  tone: "bone" | "ash";
  items: string[];
};

export type Section =
  | {
      /** Numbered ritual: how it works, in order. */
      kind: "steps";
      eyebrow: string;
      heading: Accent;
      lede?: string;
      items: { title: string; body: string }[];
      /** Set the install one-liner under the steps. */
      installCommand?: boolean;
    }
  | {
      /** Two-column grid of titled claims — the mechanism plate. */
      kind: "grid";
      eyebrow: string;
      heading: Accent;
      lede?: string;
      items: { title: string; body: string }[];
    }
  | {
      /** Two cards side by side — us/them, can/cannot. */
      kind: "split";
      eyebrow: string;
      heading: Accent;
      lede?: string;
      left: Panel;
      right: Panel;
    }
  | {
      /** A row-by-row comparison table for the /vs pages. */
      kind: "table";
      eyebrow: string;
      heading: Accent;
      lede?: string;
      columns: [string, string];
      rows: { label: string; a: string; b: string }[];
    }
  | {
      /** Plain argued prose under a heading. */
      kind: "prose";
      eyebrow: string;
      heading: Accent;
      paragraphs: string[];
    };

export type SeoPage = {
  family: SeoFamily;
  slug: string;
  /** <title> — plain language, matched to the query, ≤ 65 chars. */
  title: string;
  /** Meta description, ≤ 165 chars. */
  description: string;
  eyebrow: string;
  h1: Accent;
  lede: string;
  sections: Section[];
  faq: Faq[];
  /** "family/slug" keys of sibling pages to cross-link. */
  related: string[];
  /** Short label + blurb for index pages and related-page cards. */
  cardTitle: string;
  cardBlurb: string;
};
