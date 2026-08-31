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
        {
          title: "Claude Code on your phone",
          blurb:
            "The routes that work today, and the one where the phone becomes a console for sessions on your own machines.",
          href: "/claude-code-on-your-phone",
        },
        {
          title: "Coding agents on your phone",
          blurb:
            "The hub for the device row: every agent, every honest route, and the console pattern that ties them together.",
          href: "/coding-agents-on-your-phone",
        },
      ]}
    />
  );
}
