import { FleetCapture } from "@/components/seo/templates/FleetCapture";
import { JobH2, JobPage, JobProse, JobSection, JobStart } from "@/components/seo/templates/JobPage";
import type { ComparisonEntry } from "@/lib/seo/flat-types";

/*
 * The comparison template (docs/SEO_TREE.md): the job page's editorial frame
 * carrying the family's signature — a checkable ledger and the honest
 * verdict. Entries are pure data (lib/seo/comparisons.ts); this file is the
 * ink. The arc is fixed: respect the incumbent first, name where the jobs
 * diverge, measure row by row, show the product once, then say plainly when
 * the other tool is the right choice.
 */

/** The ledger: quiet hairlines, the incumbent's column honestly its own. */
function Ledger({ entry }: { entry: ComparisonEntry }) {
  return (
    <JobSection refId="ledger">
      <div className="mx-auto w-full max-w-4xl">
        <JobH2 className="mx-auto text-center">{entry.ledger.heading}</JobH2>
        <div className="mt-12 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-[14.5px] leading-6">
            <thead>
              <tr className="border-b border-line-strong">
                <th className="w-[26%] py-3 pr-4 font-sigil text-[10px] font-normal tracking-[0.18em] text-ash uppercase" />
                <th className="w-[37%] py-3 pr-4 font-sigil text-[10px] font-normal tracking-[0.18em] text-ember uppercase">
                  spawnd
                </th>
                <th className="w-[37%] py-3 font-sigil text-[10px] font-normal tracking-[0.18em] text-ash uppercase">
                  {entry.name}
                </th>
              </tr>
            </thead>
            <tbody>
              {entry.ledger.rows.map((row) => (
                <tr key={row.label} className="border-b border-line-g align-top">
                  <th className="py-4 pr-4 text-[13.5px] leading-6 font-medium text-ash">
                    {row.label}
                  </th>
                  <td className="py-4 pr-4 text-bone">{row.spawnd}</td>
                  <td className="py-4 text-ash">{row.other}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </JobSection>
  );
}

/** The verdict: argued in prose, then the two honest lists. */
function Verdict({ entry }: { entry: ComparisonEntry }) {
  return (
    <JobSection refId="verdict">
      <JobProse>
        <JobH2>{entry.verdict.heading}</JobH2>
        <div className="mt-8 space-y-5">
          {entry.verdict.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 40)}>{paragraph}</p>
          ))}
        </div>
      </JobProse>
      <div className="mx-auto mt-14 grid w-full max-w-[68ch] gap-10 sm:grid-cols-2">
        <div>
          <h3 className="mb-4 text-[16px] leading-7 font-semibold text-bone">Choose spawnd when</h3>
          <ul className="m-0 list-none space-y-3 p-0 text-[15px] leading-7 text-ash">
            {entry.verdict.choose.spawnd.map((item) => (
              <li key={item} className="relative pl-5">
                <span
                  aria-hidden
                  className="absolute top-[13px] left-0 h-[2px] w-[9px] bg-hellfire"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-4 text-[16px] leading-7 font-semibold text-bone">
            {entry.verdict.choose.other.title}
          </h3>
          <ul className="m-0 list-none space-y-3 p-0 text-[15px] leading-7 text-ash">
            {entry.verdict.choose.other.items.map((item) => (
              <li key={item} className="relative pl-5">
                <span
                  aria-hidden
                  className="absolute top-[13px] left-0 h-[2px] w-[9px] bg-line-strong"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </JobSection>
  );
}

export function ComparisonPage({ entry }: { entry: ComparisonEntry }) {
  return (
    <JobPage
      crumbs={[{ name: "Compared", href: "/vs" }]}
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
        <JobProse>
          <JobH2>{entry.intro.heading}</JobH2>
          <div className="mt-8 space-y-5">
            {entry.intro.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 40)}>{paragraph}</p>
            ))}
          </div>
        </JobProse>
      </JobSection>

      <JobSection refId="s2">
        <JobProse>
          <JobH2>{entry.framing.heading}</JobH2>
          <div className="mt-8 space-y-5">
            {entry.framing.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 40)}>{paragraph}</p>
            ))}
          </div>
        </JobProse>
      </JobSection>

      <Ledger entry={entry} />

      <JobSection refId="a1">
        <div className="mx-auto w-full max-w-5xl">
          <FleetCapture caption={entry.capture.caption} />
        </div>
      </JobSection>

      <Verdict entry={entry} />

      <JobStart heading="One line on any host you own." />
    </JobPage>
  );
}
