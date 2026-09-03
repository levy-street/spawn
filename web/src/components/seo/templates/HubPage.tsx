import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { SiteStructuredData } from "@/components/seo/SiteStructuredData";
import { dateLine } from "@/components/seo/templates/ArticlePage";
import { Inline } from "@/components/seo/templates/Inline";
import { JobH2, JobPage, JobProse, JobSection, JobStart } from "@/components/seo/templates/JobPage";
import type { HubEntry } from "@/lib/seo/flat-types";

/*
 * The hub template (docs/SEO_TREE.md): real content for the category head
 * term — an essay that teaches the landscape — then the rack of spokes.
 * Hubs carry the site-level JSON-LD (Organization + SoftwareApplication)
 * on top of the frame's Breadcrumb/FAQ/Article.
 */

export function HubPage({ entry }: { entry: HubEntry }) {
  return (
    <>
      <SiteStructuredData />
      <JobPage
        crumbs={[]}
        pageName={entry.cardTitle}
        canonicalPath={`/${entry.slug}`}
        hero={{
          title: { plain: entry.hero.plain, accent: entry.hero.accent },
          sub: entry.hero.sub,
          date: dateLine(entry.datePublished),
          ink: { video: "/brand/ink/grid-ink.mp4", still: "/brand/ink/grid-ink-still.webp" },
        }}
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
        {entry.essay.map((section, index) => (
          <JobSection
            key={section.heading}
            refId={`s${index + 1}`}
            className={index === 0 ? "pt-20 sm:pt-28" : undefined}
          >
            <JobProse>
              <JobH2>{section.heading}</JobH2>
              <div className="mt-8 space-y-5">
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph.slice(0, 40)}>
                    <Inline text={paragraph} />
                  </p>
                ))}
              </div>
            </JobProse>
          </JobSection>
        ))}

        <JobSection refId="rack">
          <div className="mx-auto w-full max-w-4xl">
            <JobH2 className="mx-auto text-center">
              {entry.rackHeading ?? "The pages, per device and agent."}
            </JobH2>
            <div className="mt-12 grid gap-6 sm:grid-cols-2">
              {entry.spokes.map((spoke) => (
                <Link
                  key={spoke.href}
                  prefetch={false}
                  href={spoke.href}
                  className="group flex flex-col rounded-xl bg-char p-7 ring-1 ring-line-g transition-colors hover:ring-bone/30"
                >
                  <h3 className="mb-2 text-[17px] leading-7 font-semibold text-bone">
                    {spoke.title}
                  </h3>
                  <p className="mb-5 flex-1 text-[14.5px] leading-7 text-ash">{spoke.blurb}</p>
                  <span className="inline-flex items-center gap-1.5 text-[13px] text-ember">
                    Read
                    <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </JobSection>

        <JobStart heading="One line on any host you own." />
      </JobPage>
    </>
  );
}
