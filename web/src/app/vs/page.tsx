import type { Metadata } from "next";
import { SeoFamilyIndex } from "@/components/seo/SeoFamilyIndex";
import { FLAT_PAGES, flatPageCard } from "@/lib/seo/flat";
import { seoFamilyMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = seoFamilyMetadata("vs");

/*
 * The comparisons hub. Its spokes live on flat slugs now (lib/seo/flat.ts,
 * docs/SEO_TREE.md) — the hub racks their cards; the registry family is
 * intentionally empty.
 */
export default function VsIndexPage() {
  return (
    <SeoFamilyIndex
      family="vs"
      featured={FLAT_PAGES.filter((page) => page.template === "comparison").map(flatPageCard)}
    />
  );
}
