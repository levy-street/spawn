import {
  CodeFigure,
  Frame,
  H2,
  Paragraphs,
  Points,
  Prose,
  Section,
  Start,
} from "@/components/grimoire/frame";
import { Inline } from "@/components/grimoire/Inline";
import type { ArticleBlock, ArticleCode, ArticleEntry } from "@/lib/grimoire/types";

/*
 * The article template: the frame around a sequence of blocks — prose,
 * numbered steps, a reference table, short points. It serves the pages
 * whose signature is the writing: guides, fix pages, explainers,
 * references, roundups, definitions. Entries are pure data; this is the ink.
 */

function Code({ code }: { code: ArticleCode }) {
  return (
    <CodeFigure caption={code.caption}>
      <div className="whitespace-pre">{code.lines.join("\n")}</div>
    </CodeFigure>
  );
}

function Block({ block }: { block: ArticleBlock }) {
  switch (block.kind) {
    case "prose":
      return (
        <Section>
          <Prose>
            <H2>{block.heading}</H2>
            <Paragraphs className="mt-8" paragraphs={block.paragraphs} />
            {block.code ? (
              <div className="mt-8">
                <Code code={block.code} />
              </div>
            ) : null}
          </Prose>
        </Section>
      );
    case "steps":
      return (
        <Section>
          <Prose>
            <H2>{block.heading}</H2>
            {block.lead ? (
              <p className="mt-8">
                <Inline text={block.lead} />
              </p>
            ) : null}
            <ol className="mt-10 list-none space-y-10 p-0">
              {block.steps.map((step, index) => (
                <li key={step.title} id={`step-${index + 1}`} className="scroll-mt-24">
                  <h3 className="mb-2 text-[16px] leading-7 font-semibold text-bone">
                    <span className="mr-3 font-sigil text-[12px] tracking-[0.12em] text-ember">
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
          </Prose>
        </Section>
      );
    case "table":
      return (
        <Section>
          <div className="mx-auto w-full max-w-4xl">
            <Prose>
              <H2>{block.heading}</H2>
              {block.lead ? (
                <p className="mt-8">
                  <Inline text={block.lead} />
                </p>
              ) : null}
            </Prose>
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
              <Prose>
                <p className="mt-6 text-[13px] leading-6">
                  <Inline text={block.note} />
                </p>
              </Prose>
            ) : null}
          </div>
        </Section>
      );
    case "points":
      return (
        <Section>
          <Prose>
            <H2>{block.heading}</H2>
            {block.lead ? (
              <p className="mt-8">
                <Inline text={block.lead} />
              </p>
            ) : null}
            <div className="mt-10">
              <Points items={block.items} />
            </div>
          </Prose>
        </Section>
      );
  }
}

export function ArticlePage({ entry }: { entry: ArticleEntry }) {
  const steps = entry.kind === "guide" ? entry.body.find((b) => b.kind === "steps") : undefined;
  return (
    <Frame
      crumb={{ name: entry.hub.name, href: entry.hub.href }}
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
      howTo={
        steps && steps.kind === "steps"
          ? {
              name: entry.title,
              description: entry.description,
              canonicalPath: `/${entry.slug}`,
              steps: steps.steps.map((step) => ({ name: step.title, text: step.body })),
            }
          : undefined
      }
    >
      {entry.body.map((block) => (
        <Block key={`${block.kind}-${block.heading}`} block={block} />
      ))}
      <Start heading={entry.start ?? "One line on any host you own."} />
    </Frame>
  );
}
