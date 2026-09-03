import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Frame, Section } from "@/components/grimoire/frame";
import { DOCS } from "./docs";

const TITLE = "Docs: the design documents, on-site";
const DESCRIPTION =
  "spawnd’s design documents rendered where they can be read and linked: the threat model that names our own server as the adversary, and the session architecture.";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#000000",
};

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/docs" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/docs",
    siteName: "spawnd",
    type: "website",
    images: [{ url: "/og.jpg", width: 2400, height: 1260, alt: TITLE }],
  },
};

export default function DocsIndexPage() {
  return (
    <Frame
      pageName="Docs"
      canonicalPath="/docs"
      hero={{
        title: { plain: "The design", accent: "documents" },
        sub: "The documents the daemon and server are built from, rendered here so they can be read without a checkout and linked without a redirect.",
      }}
      date="2026-09-03"
      faq={[]}
      related={[
        {
          title: "Guides",
          blurb: "agent guides, device guides, definitions, fixes, tools",
          href: "/guides",
        },
        {
          title: "Security",
          blurb: "the trust model, plainly, with the honest ledger",
          href: "/security",
        },
      ]}
    >
      <Section>
        <div className="mx-auto w-full max-w-3xl">
          <ul className="space-y-8">
            {DOCS.map((doc) => (
              <li key={doc.slug}>
                <Link
                  prefetch={false}
                  href={`/docs/${doc.slug}`}
                  className="text-[20px] leading-8 font-semibold text-bone underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ember"
                >
                  {doc.title}
                </Link>
                <p className="mt-2 text-[15.5px] leading-7 text-ash">{doc.description}</p>
                <p className="mt-1 font-sigil text-[11px] tracking-[0.16em] text-ash/70 uppercase">
                  {doc.file}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </Frame>
  );
}
