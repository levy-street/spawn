import { GITHUB_URL } from "@/components/brand/press";

/*
 * Site-level JSON-LD: who publishes this site and what the software is.
 * Rendered on `/` and the landing-page hubs per docs/SEO_TREE.md — not on
 * every spoke, where page-level schema (Breadcrumb, FAQ, Article) carries
 * the weight. Copy is reused from shipped surfaces; nothing here makes a
 * claim the site doesn't already make.
 */

const SITE = "https://spawnd.dev";

const DATA = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE}/#organization`,
    name: "SPAWN D",
    url: SITE,
    logo: {
      "@type": "ImageObject",
      url: `${SITE}/icon-512.png`,
      width: 512,
      height: 512,
    },
    sameAs: [GITHUB_URL],
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "SPAWN D",
    url: SITE,
    description:
      "The open-source control plane for CLI coding agents. A daemon on every host you own — summon your agents, reach them from any browser, and the server that connects you never hears a word.",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": `${SITE}/#organization` },
  },
];

const JSON_LD = JSON.stringify(DATA).replace(/</g, "\\u003c");

export function SiteStructuredData() {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: fixed build-time literal, serialized and escaped above
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
  );
}
