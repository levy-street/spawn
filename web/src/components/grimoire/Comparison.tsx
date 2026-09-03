import { Frame, H2, Paragraphs, Prose, Section, Start } from "@/components/grimoire/frame";
import type { ComparisonEntry } from "@/lib/grimoire/types";

/*
 * The comparison template: respect the incumbent first, name where the
 * jobs diverge, measure row by row in a checkable ledger, then say plainly
 * when the other tool is the right choice.
 */

function Ledger({ entry }: { entry: ComparisonEntry }) {
  return (
    <Section>
      <div className="mx-auto w-full max-w-4xl">
        <H2 className="mx-auto text-center">{entry.ledger.heading}</H2>
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
    </Section>
  );
}

function ChooseList({ title, items, ember }: { title: string; items: string[]; ember: boolean }) {
  return (
    <div>
      <h3 className="mb-4 text-[16px] leading-7 font-semibold text-bone">{title}</h3>
      <ul className="m-0 list-none space-y-3 p-0 text-[15px] leading-7 text-ash">
        {items.map((item) => (
          <li key={item} className="relative pl-5">
            <span
              aria-hidden
              className={`absolute top-[13px] left-0 h-[2px] w-[9px] ${ember ? "bg-hellfire" : "bg-line-strong"}`}
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ComparisonPage({ entry }: { entry: ComparisonEntry }) {
  return (
    <Frame
      crumb={{ name: "Compared", href: "/guides" }}
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
      {[entry.intro, entry.framing].map((section) => (
        <Section key={section.heading}>
          <Prose>
            <H2>{section.heading}</H2>
            <Paragraphs className="mt-8" paragraphs={section.paragraphs} />
          </Prose>
        </Section>
      ))}
      <Ledger entry={entry} />
      <Section>
        <Prose>
          <H2>{entry.verdict.heading}</H2>
          <Paragraphs className="mt-8" paragraphs={entry.verdict.paragraphs} />
        </Prose>
        <div className="mx-auto mt-14 grid w-full max-w-[68ch] gap-10 sm:grid-cols-2">
          <ChooseList title="Choose spawnd when" items={entry.verdict.choose.spawnd} ember />
          <ChooseList
            title={entry.verdict.choose.other.title}
            items={entry.verdict.choose.other.items}
            ember={false}
          />
        </div>
      </Section>
      <Start heading="One line on any host you own." />
    </Frame>
  );
}
