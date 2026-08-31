import Image from "next/image";
import {
  JobH2,
  JobPage,
  JobProse,
  JobSection,
  JobSplit,
  JobStart,
} from "@/components/seo/templates/JobPage";
import type { DeviceEntry, DeviceVignette } from "@/lib/seo/flat-types";

/*
 * The device template (docs/SEO_TREE.md): the job page's editorial frame
 * carrying the family's signature — real agent moments in phone frames.
 * Entries are pure data (lib/seo/devices.ts); this file is the ink. The
 * arc: the honest routes first, then what spawnd makes of the device, the
 * whole app on the glass, the loop as captured moments, and the
 * away-from-desk close.
 */

/** A real capture in a quiet device frame: bezel ring, no skeuomorphism.
 * Portrait captures get the phone's tight radius; landscape gets a screen's. */
function DeviceFrame({
  vignette,
  sizes,
  refId,
}: {
  vignette: DeviceVignette;
  sizes: string;
  refId?: string;
}) {
  const portrait = vignette.height > vignette.width;
  return (
    <figure id={refId} className="relative min-w-0 scroll-mt-24">
      <div
        className={
          portrait
            ? "overflow-hidden rounded-[2rem] bg-void ring-1 ring-line-strong"
            : "overflow-hidden rounded-xl bg-void ring-1 ring-line-strong"
        }
      >
        <Image
          src={vignette.src}
          width={vignette.width}
          height={vignette.height}
          alt={vignette.alt}
          sizes={sizes}
          className="block h-auto w-full"
        />
      </div>
      <figcaption className="mt-3 text-[13px] leading-6 text-ash">{vignette.caption}</figcaption>
    </figure>
  );
}

function Prose({ heading, paragraphs }: { heading: string; paragraphs: string[] }) {
  return (
    <JobProse>
      <JobH2>{heading}</JobH2>
      <div className="mt-8 space-y-5">
        {paragraphs.map((paragraph) => (
          <p key={paragraph.slice(0, 40)}>{paragraph}</p>
        ))}
      </div>
    </JobProse>
  );
}

export function DevicePage({ entry }: { entry: DeviceEntry }) {
  return (
    <JobPage
      crumbs={[{ name: "On your phone", href: "/coding-agents-on-your-phone" }]}
      pageName={entry.cardTitle}
      canonicalPath={`/${entry.slug}`}
      hero={{
        title: { plain: entry.hero.plain, accent: entry.hero.accent },
        sub: entry.hero.sub,
        date: "spawnd · August 2026",
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
      <JobSection refId="s1" className="pt-20 sm:pt-28">
        <Prose heading={entry.intro.heading} paragraphs={entry.intro.paragraphs} />
      </JobSection>

      <JobSection refId="s2">
        <JobSplit
          media={
            entry.grid.height > entry.grid.width ? (
              <div className="mx-auto w-full max-w-[19rem]">
                <DeviceFrame vignette={entry.grid} sizes="19rem" />
              </div>
            ) : (
              <DeviceFrame vignette={entry.grid} sizes="(min-width: 1024px) 32rem, 100vw" />
            )
          }
        >
          <JobH2>{entry.shape.heading}</JobH2>
          <div className="mt-8 space-y-5">
            {entry.shape.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 40)}>{paragraph}</p>
            ))}
          </div>
        </JobSplit>
      </JobSection>

      <JobSection refId="a1">
        <div className="mx-auto w-full max-w-4xl">
          <div className="mx-auto max-w-[58ch] text-center">
            <JobH2 className="mx-auto">{entry.moments.heading}</JobH2>
            <p className="mt-6 text-[16px] leading-8 text-ash">{entry.moments.lead}</p>
          </div>
          {entry.moments.vignettes.every((v) => v.height > v.width) ? (
            <div className="mx-auto mt-14 grid max-w-[42rem] gap-10 sm:grid-cols-2">
              {entry.moments.vignettes.map((vignette) => (
                <DeviceFrame
                  key={vignette.src}
                  vignette={vignette}
                  sizes="(min-width: 640px) 20rem, 80vw"
                />
              ))}
            </div>
          ) : (
            <div className="mx-auto mt-14 max-w-4xl space-y-14">
              {entry.moments.vignettes.map((vignette) => (
                <DeviceFrame
                  key={vignette.src}
                  vignette={vignette}
                  sizes="(min-width: 1024px) 56rem, 100vw"
                />
              ))}
            </div>
          )}
        </div>
      </JobSection>

      <JobSection refId="s3">
        <Prose heading={entry.away.heading} paragraphs={entry.away.paragraphs} />
      </JobSection>

      <JobStart heading="One line on the machine it should run on." />
    </JobPage>
  );
}
