import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { ComparisonPage } from "@/components/seo/templates/ComparisonPage";
import { DevicePage } from "@/components/seo/templates/DevicePage";
import { FLAT_PAGES, findFlatPage, flatPageContent } from "@/lib/seo/flat";

/*
 * The flat-slug router (docs/SEO_TREE.md URL policy): every landing page is
 * one slug off the root, rendered from the flat catalogue by its template.
 * Next prefers static routes, so app surfaces always win the segment;
 * lib/seo/flat.test.ts fails the build side of that race — a flat slug that
 * would be shadowed never ships. Static params only: an unknown slug 404s.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return FLAT_PAGES.map((page) => ({ slug: page.slug }));
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
  const page = findFlatPage(slug);
  if (!page) return {};
  const content = flatPageContent(page);
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

export default async function FlatSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findFlatPage(slug);
  if (!page) notFound();
  switch (page.template) {
    case "comparison":
      return <ComparisonPage entry={page.comparison} />;
    case "device":
      return <DevicePage entry={page.device} />;
  }
}
