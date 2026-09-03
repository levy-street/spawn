/*
 * The design documents rendered on-site (grimoire §viii: every link an
 * essay earns should land on spawnd.dev, not on GitHub). A curated list —
 * only the documents written for readers outside the team.
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
    slug: "trust",
    file: "docs/TRUST.md",
    title: "Designing a control plane that can’t read your data",
    description:
      "The threat model behind spawnd, verbatim: what the server sees, what it structurally cannot, the relay as ciphertext fallback, and how to verify it yourself.",
  },
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
