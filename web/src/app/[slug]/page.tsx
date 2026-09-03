import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { ArticlePage } from "@/components/grimoire/Article";
import { ComparisonPage } from "@/components/grimoire/Comparison";
import { HubPage } from "@/components/grimoire/Hub";
import { findPage, PAGES, pageContent } from "@/lib/grimoire/catalogue";

/*
 * The slug router: every grimoire page is one slug off the root, rendered
 * from the catalogue by its template. Next prefers static routes, so app
 * surfaces always win the segment; lib/grimoire/catalogue.test.ts fails the
 * build side of that race. Static params only: an unknown slug 404s.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return PAGES.map((page) => ({ slug: page.slug }));
}

// Marketing pages let readers zoom; the app's locked viewport stays app-side.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#000000",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = findPage(slug);
  if (!page) return {};
  const content = pageContent(page);
  const path = `/${page.slug}`;
  const ogImage = `/og/${page.slug}.jpg`;
  return {
    title: content.title,
    description: content.description,
    alternates: { canonical: path },
    openGraph: {
      title: content.title,
      description: content.description,
      url: path,
      siteName: "spawnd",
      type: "article",
      publishedTime: content.datePublished,
      modifiedTime: content.dateModified,
      images: [{ url: ogImage, width: 2400, height: 1260, alt: content.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: content.title,
      description: content.description,
      images: [ogImage],
    },
  };
}

export default async function GrimoireSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findPage(slug);
  if (!page) notFound();
  switch (page.template) {
    case "article":
      return <ArticlePage entry={page.article} />;
    case "hub":
      return <HubPage entry={page.hub} />;
    case "comparison":
      return <ComparisonPage entry={page.comparison} />;
  }
}
