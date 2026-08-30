import type { Metadata } from "next";
import { SeoFamilyIndex } from "@/components/seo/SeoFamilyIndex";
import { seoFamilyMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = seoFamilyMetadata("use");

export default function UseIndexPage() {
  return (
    <SeoFamilyIndex
      family="use"
      featured={[
        {
          title: "Run multiple Claude Code sessions in parallel",
          blurb:
            "The worktree-and-panes setup, where it honestly runs out, and how to manage the whole fleet from one place.",
          href: "/run-agents-in-parallel",
        },
      ]}
    />
  );
}
