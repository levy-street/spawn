import type { Metadata } from "next";
import { SeoFamilyIndex } from "@/components/seo/SeoFamilyIndex";
import { seoFamilyMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = seoFamilyMetadata("for");

export default function AgentsIndexPage() {
  return <SeoFamilyIndex family="for" />;
}
