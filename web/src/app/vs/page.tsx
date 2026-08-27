import type { Metadata } from "next";
import { SeoFamilyIndex } from "@/components/seo/SeoFamilyIndex";
import { seoFamilyMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = seoFamilyMetadata("vs");

export default function ComparisonsIndexPage() {
  return <SeoFamilyIndex family="vs" />;
}
