import type { Metadata } from "next";
import { SeoFamilyIndex } from "@/components/seo/SeoFamilyIndex";
import { seoFamilyMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = seoFamilyMetadata("use");

export default function UseIndexPage() {
  return <SeoFamilyIndex family="use" />;
}
