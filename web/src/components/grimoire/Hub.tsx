import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Frame, H2, Paragraphs, Prose, Section, Start } from "@/components/grimoire/frame";
import type { HubEntry } from "@/lib/grimoire/types";

/*
 * The hub template: real content for the category head term — an essay
 * that teaches the landscape — then the rack of spokes, on the same cards
 * the security page's ledger uses.
 */

export function HubPage({ entry }: { entry: HubEntry }) {
  return (
    <Frame
      pageName={entry.cardTitle}
      canonicalPath={`/${entry.slug}`}
      hero={{ title: { plain: entry.hero.plain, accent: entry.hero.accent }, sub: entry.hero.sub }}
      date={entry.datePublished}
      faq={entry.faq}
      related={entry.related}
      article={{
        headline: entry.title,
        description: entry.description,
        image: `/og/${entry.slug}.jpg`,
        datePublished: entry.datePublished,
        dateModified: entry.dateModified,
      }}
    >
      {entry.essay.map((section) => (
        <Section key={section.heading}>
          <Prose>
            <H2>{section.heading}</H2>
            <Paragraphs className="mt-8" paragraphs={section.paragraphs} />
          </Prose>
        </Section>
      ))}

      <Section id="rack">
        <div className="mx-auto w-full max-w-5xl">
          <H2 className="mx-auto text-center">
            {entry.rackHeading ?? "The pages, one per question."}
          </H2>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {entry.spokes.map((spoke) => (
              <Link
                key={spoke.href}
                prefetch={false}
                href={spoke.href}
                className="group flex flex-col rounded-sm border border-line-strong bg-char p-6 transition-colors hover:border-bone/40"
              >
                <h3 className="mb-2 text-[16px] leading-6 font-semibold text-bone">
                  {spoke.title}
                </h3>
                <p className="mb-5 flex-1 text-[14px] leading-6 text-ash">{spoke.blurb}</p>
                <span className="inline-flex items-center gap-1.5 font-sigil text-[11px] tracking-[0.18em] text-ember uppercase">
                  Read
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </Section>

      <Start heading="One line on any host you own." />
    </Frame>
  );
}
