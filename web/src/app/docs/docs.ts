/*
 * The design documents rendered on-site (grimoire §viii: every link an
 * essay earns should land on spawnd.dev, not on GitHub). A curated list —
 * only documents reviewed for readers outside the team. TRUST.md is not
 * listed yet: its open-source checklist is an internal to-do (a git-history
 * secret scan, credential rotation) that must be resolved or removed before
 * the document is published verbatim.
 */

export interface SiteDoc {
  slug: string;
  /** Path relative to the repo root. */
  file: string;
  title: string;
  description: string;
}

export const DOCS: SiteDoc[] = [
  {
    slug: "sessiond",
    file: "docs/SESSIOND.md",
    title: "sessiond: how a terminal session outlives everything",
    description:
      "The session architecture: a worker process per PTY on the host, so sessions survive dropped connections, closed laptops, and daemon restarts with scrollback intact.",
  },
];

export function findDoc(slug: string): SiteDoc | undefined {
  return DOCS.find((doc) => doc.slug === slug);
}
