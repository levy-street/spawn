import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SeoLandingPage } from "@/components/seo/SeoLandingPage";
import { seoPageMetadata } from "@/lib/seo/metadata";
import { findSeoPage, seoPagesByFamily } from "@/lib/seo/registry";

export const dynamicParams = false;

export function generateStaticParams() {
  return seoPagesByFamily("vs").map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = findSeoPage("vs", slug);
  return page ? seoPageMetadata(page) : {};
}

export default async function ComparisonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findSeoPage("vs", slug);
  if (!page) notFound();
  return <SeoLandingPage page={page} />;
}
