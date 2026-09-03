import { FleetCapture } from "@/components/seo/templates/FleetCapture";
import { Inline } from "@/components/seo/templates/Inline";
import {
  JobCodeFigure,
  JobH2,
  JobPage,
  JobProse,
  JobSection,
  JobStart,
} from "@/components/seo/templates/JobPage";
import type { ArticleBlock, ArticleCode, ArticleEntry } from "@/lib/seo/flat-types";
import { stripInline } from "@/lib/seo/inline";

/*
 * The article template (docs/SEO_TREE.md): the job page's editorial frame
 * around a sequence of blocks — prose, numbered steps, a reference table,
 * short points, and at most one product capture placed where the product
 * enters. It serves the pages whose signature is the writing: guides, fix
 * pages, explainers, references, roundups, and definitions. Entries are
 * pure data (lib/seo/articles/); this file is the ink. Guides emit HowTo
 * from their steps on top of the frame's Breadcrumb/FAQ/Article.
 */

const SITE = "https://spawnd.dev";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "spawnd · September 2026" from an ISO date, so the line never drifts from the schema. */
export function dateLine(iso: string): string {
  const [year, month] = iso.split("-");
  return `spawnd · ${MONTHS[Number(month) - 1]} ${year}`;
}

function Code({ code }: { code: ArticleCode }) {
  return (
    <JobCodeFigure caption={code.caption}>
      <div className="whitespace-pre">{code.lines.join("\n")}</div>
    </JobCodeFigure>
  );
}

function Paragraphs({ paragraphs }: { paragraphs: string[] }) {
  return (
    <div className="mt-8 space-y-5">
      {paragraphs.map((paragraph) => (
        <p key={paragraph.slice(0, 40)}>
          <Inline text={paragraph} />
        </p>
      ))}
    </div>
  );
}

function Block({ block, first }: { block: ArticleBlock; first: boolean }) {
  const className = first ? "pt-20 sm:pt-28" : undefined;
  switch (block.kind) {
    case "prose":
      return (
        <JobSection className={className}>
          <JobProse>
            <JobH2>{block.heading}</JobH2>
            <Paragraphs paragraphs={block.paragraphs} />
            {block.code ? (
              <div className="mt-8">
                <Code code={block.code} />
              </div>
            ) : null}
          </JobProse>
        </JobSection>
      );
    case "steps":
      return (
        <JobSection className={className}>
          <JobProse>
            <JobH2>{block.heading}</JobH2>
            {block.lead ? (
              <p className="mt-8">
                <Inline text={block.lead} />
              </p>
            ) : null}
            <ol className="mt-10 list-none space-y-10 p-0">
              {block.steps.map((step, index) => (
                <li key={step.title}>
                  <h3 className="mb-2 text-[16px] leading-7 font-semibold text-bone">
                    <span className="mr-3 font-sigil text-[12px] tracking-[0.12em] text-ash">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {step.title}
                  </h3>
                  <p>
                    <Inline text={step.body} />
                  </p>
                  {step.code ? (
                    <div className="mt-5">
                      <Code code={step.code} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </JobProse>
        </JobSection>
      );
    case "table":
      return (
        <JobSection className={className}>
          <div className="mx-auto w-full max-w-4xl">
            <JobProse>
              <JobH2>{block.heading}</JobH2>
              {block.lead ? (
                <p className="mt-8">
                  <Inline text={block.lead} />
                </p>
              ) : null}
            </JobProse>
            <div className="mt-10 overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left text-[14.5px] leading-6">
                <thead>
                  <tr className="border-b border-line-strong">
                    {block.columns.map((column) => (
                      <th
                        key={column}
                        className="py-3 pr-4 font-sigil text-[10px] font-normal tracking-[0.18em] text-ash uppercase"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row) => (
                    <tr key={row[0]} className="border-b border-line-g align-top">
                      {row.map((cell, index) =>
                        index === 0 ? (
                          <th
                            key={`${row[0]}-h`}
                            className="py-4 pr-4 text-[13.5px] leading-6 font-medium text-bone"
                          >
                            <Inline text={cell} />
                          </th>
                        ) : (
                          <td
                            key={`${row[0]}-${block.columns[index]}`}
                            className="py-4 pr-4 text-ash"
                          >
                            <Inline text={cell} />
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {block.note ? (
              <JobProse>
                <p className="mt-6 text-[13px] leading-6">
                  <Inline text={block.note} />
                </p>
              </JobProse>
            ) : null}
          </div>
        </JobSection>
      );
    case "points":
      return (
        <JobSection className={className}>
          <JobProse>
            <JobH2>{block.heading}</JobH2>
            {block.lead ? (
              <p className="mt-8">
                <Inline text={block.lead} />
              </p>
            ) : null}
            <div className="mt-10 space-y-9">
              {block.items.map((item) => (
                <div key={item.title}>
                  <h3 className="mb-1.5 text-[16px] leading-7 font-semibold text-bone">
                    {item.title}
                  </h3>
                  <p>
                    <Inline text={item.body} />
                  </p>
                </div>
              ))}
            </div>
          </JobProse>
        </JobSection>
      );
    case "capture":
      return (
        <JobSection className={className}>
          <div className="mx-auto w-full max-w-5xl">
            <FleetCapture caption={block.caption} />
          </div>
        </JobSection>
      );
  }
}

/** HowTo, built from a guide's first steps block. Text is the markup-stripped body. */
function HowToData({ entry }: { entry: ArticleEntry }) {
  const steps = entry.body.find((block) => block.kind === "steps");
  if (entry.kind !== "guide" || !steps || steps.kind !== "steps") return null;
  const data = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: entry.title,
    description: entry.description,
    step: steps.steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.title,
      text: stripInline(step.body),
      url: `${SITE}/${entry.slug}#step-${index + 1}`,
    })),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: static page data, serialized and escaped at build time
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
  );
}

export function ArticlePage({ entry }: { entry: ArticleEntry }) {
  return (
    <>
      <HowToData entry={entry} />
      <JobPage
        crumbs={[entry.hub]}
        pageName={entry.cardTitle}
        canonicalPath={`/${entry.slug}`}
        hero={{
          title: { plain: entry.hero.plain, accent: entry.hero.accent },
          sub: entry.hero.sub,
          date: dateLine(entry.datePublished),
          ink: { video: "/brand/ink/hero-ink.mp4", still: "/brand/ink/hero-ink-still.webp" },
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
        {entry.body.map((block, index) => (
          <Block
            key={block.kind === "capture" ? "capture" : `${block.kind}-${block.heading}`}
            block={block}
            first={index === 0}
          />
        ))}
        <JobStart heading={entry.start ?? "One line on any host you own."} />
      </JobPage>
    </>
  );
}
