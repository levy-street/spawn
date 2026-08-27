import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  Colophon,
  CTA_QUIET,
  CTA_SLAB,
  Eyebrow,
  Masthead,
  RegistrationMarks,
} from "@/components/brand/press";
import { InstallOneLiner } from "@/components/seo/InstallOneLiner";
import { poster } from "@/lib/fonts";
import { findSeoPageByKey, SEO_FAMILIES, seoPageHref } from "@/lib/seo/registry";
import type { Accent, Panel, Section, SeoPage } from "@/lib/seo/types";
import { cn } from "@/lib/utils";

/*
 * The one template every SEO landing page is printed with, set entirely in
 * the pressroom's vocabulary (components/brand/press.tsx, /security's
 * plates). Pages are data; this file is the ink. Server component — the only
 * client islands are the masthead and the install chip.
 */

/** A heading with its accent struck in hellfire. */
function AccentHeading({
  as: Tag,
  text,
  className,
}: {
  as: "h1" | "h2";
  text: Accent;
  className?: string;
}) {
  return (
    <Tag className={cn(poster.className, "font-light uppercase [text-wrap:balance]", className)}>
      {text.plain}
      {text.accent ? (
        <>
          {" "}
          <em className="text-hellfire not-italic">{text.accent}</em>
        </>
      ) : null}
    </Tag>
  );
}

/** Two-digit sigil numeral that names a step or a claim. */
function SigilIndex({ index }: { index: number }) {
  return (
    <span aria-hidden className="font-sigil text-[12px] tracking-[0.22em] text-hellfire">
      {String(index + 1).padStart(2, "0")}
    </span>
  );
}

function SectionShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("border-line-g border-b px-5 py-20 sm:px-8 sm:py-24", className)}>
      {children}
    </section>
  );
}

function StepsSection({ section }: { section: Extract<Section, { kind: "steps" }> }) {
  return (
    <SectionShell>
      <div className="mx-auto w-full max-w-6xl">
        <Eyebrow className="mb-5">{section.eyebrow}</Eyebrow>
        <AccentHeading
          as="h2"
          text={section.heading}
          className="mb-5 max-w-[22ch] text-[clamp(28px,4.5vw,48px)] leading-[1.04] text-bone"
        />
        {section.lede ? (
          <p className="mb-12 max-w-[62ch] text-[17px] leading-8 text-ash">{section.lede}</p>
        ) : (
          <div className="mb-12" />
        )}
        <ol className="grid min-w-0 gap-10 sm:grid-cols-3 sm:gap-8">
          {section.items.map((item, index) => (
            <li key={item.title} className="border-line-g border-t pt-5">
              <SigilIndex index={index} />
              <h3 className="mt-3 mb-3 text-[17px] font-medium text-bone">{item.title}</h3>
              <p className="text-[15px] leading-7 text-ash">{item.body}</p>
            </li>
          ))}
        </ol>
        {section.installCommand ? <InstallOneLiner className="mt-12" /> : null}
      </div>
    </SectionShell>
  );
}

/** The red plate, black ink — one strong moment per page, like /security's. */
function GridSection({
  section,
  plate,
}: {
  section: Extract<Section, { kind: "grid" }>;
  plate: boolean;
}) {
  if (plate) {
    return (
      <section className="relative overflow-hidden bg-plate text-void">
        <div className="relative mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <p className="mb-5 font-sigil text-[12px] font-medium tracking-[0.3em] uppercase">
            {section.eyebrow}
          </p>
          <AccentHeading
            as="h2"
            text={{
              plain: `${section.heading.plain}${section.heading.accent ? ` ${section.heading.accent}` : ""}`,
            }}
            className="mb-5 max-w-[22ch] text-[clamp(28px,4.8vw,52px)] leading-[1.02]"
          />
          {section.lede ? (
            <p className="mb-14 max-w-[62ch] text-[16px] leading-7 text-void/80">{section.lede}</p>
          ) : (
            <div className="mb-14" />
          )}
          <div className="grid min-w-0 gap-y-12 sm:grid-cols-2 sm:gap-x-12 lg:gap-x-16">
            {section.items.map((item) => (
              <div key={item.title}>
                <h3 className="mb-3 border-void/30 border-b pb-3 font-sigil text-[12px] font-medium tracking-[0.22em] uppercase">
                  {item.title}
                </h3>
                <p className="text-[15px] leading-7 text-void/85">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }
  return (
    <SectionShell>
      <div className="mx-auto w-full max-w-6xl">
        <Eyebrow className="mb-5">{section.eyebrow}</Eyebrow>
        <AccentHeading
          as="h2"
          text={section.heading}
          className="mb-5 max-w-[22ch] text-[clamp(28px,4.5vw,48px)] leading-[1.04] text-bone"
        />
        {section.lede ? (
          <p className="mb-14 max-w-[62ch] text-[17px] leading-8 text-ash">{section.lede}</p>
        ) : (
          <div className="mb-14" />
        )}
        <div className="grid min-w-0 gap-y-12 sm:grid-cols-2 sm:gap-x-12 lg:gap-x-16">
          {section.items.map((item) => (
            <div key={item.title}>
              <h3 className="mb-3 border-line-g border-b pb-3 font-sigil text-[12px] font-medium tracking-[0.22em] text-ember uppercase">
                {item.title}
              </h3>
              <p className="text-[15px] leading-7 text-ash">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}

function PanelCard({ panel }: { panel: Panel }) {
  const strong = panel.tone === "bone";
  return (
    <div className="rounded-sm border border-line-strong bg-char p-7 sm:p-8">
      <div className="mb-6 border-line-g border-b pb-4">
        <h3
          className={cn(
            "font-sigil text-[11px] tracking-[0.22em] uppercase",
            strong ? "text-ember" : "text-ash",
          )}
        >
          {panel.title}
        </h3>
      </div>
      <ul className={cn("space-y-3.5 text-[15px] leading-7", strong ? "text-bone" : "text-ash")}>
        {panel.items.map((item) => (
          <li key={item} className="flex gap-3">
            <span
              aria-hidden
              className={cn(
                "mt-[11px] size-1.5 shrink-0 rounded-full",
                strong ? "bg-hellfire" : "bg-ash/50",
              )}
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SplitSection({ section }: { section: Extract<Section, { kind: "split" }> }) {
  return (
    <SectionShell>
      <div className="mx-auto w-full max-w-6xl">
        <Eyebrow className="mb-5">{section.eyebrow}</Eyebrow>
        <AccentHeading
          as="h2"
          text={section.heading}
          className="mb-5 max-w-[22ch] text-[clamp(28px,4.5vw,48px)] leading-[1.04] text-bone"
        />
        {section.lede ? (
          <p className="mb-14 max-w-[62ch] text-[17px] leading-8 text-ash">{section.lede}</p>
        ) : (
          <div className="mb-14" />
        )}
        <div className="grid min-w-0 gap-6 md:grid-cols-2">
          <PanelCard panel={section.left} />
          <PanelCard panel={section.right} />
        </div>
      </div>
    </SectionShell>
  );
}

function TableSection({ section }: { section: Extract<Section, { kind: "table" }> }) {
  return (
    <SectionShell>
      <div className="mx-auto w-full max-w-6xl">
        <Eyebrow className="mb-5">{section.eyebrow}</Eyebrow>
        <AccentHeading
          as="h2"
          text={section.heading}
          className="mb-5 max-w-[22ch] text-[clamp(28px,4.5vw,48px)] leading-[1.04] text-bone"
        />
        {section.lede ? (
          <p className="mb-12 max-w-[62ch] text-[17px] leading-8 text-ash">{section.lede}</p>
        ) : (
          <div className="mb-12" />
        )}
        {/* Wide content scrolls inside its own container; the page never does. */}
        <div className="overflow-x-auto rounded-sm border border-line-strong bg-char">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-line-g border-b">
                <th className="w-[24%] px-5 py-4 font-sigil text-[11px] font-medium tracking-[0.22em] text-ash uppercase sm:px-6" />
                <th className="w-[38%] px-5 py-4 font-sigil text-[11px] font-medium tracking-[0.22em] text-ember uppercase sm:px-6">
                  {section.columns[0]}
                </th>
                <th className="w-[38%] px-5 py-4 font-sigil text-[11px] font-medium tracking-[0.22em] text-ash uppercase sm:px-6">
                  {section.columns[1]}
                </th>
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.label} className="border-line-g border-b last:border-b-0">
                  <th
                    scope="row"
                    className="px-5 py-4 align-top font-sigil text-[11px] font-medium tracking-[0.18em] text-ash uppercase sm:px-6"
                  >
                    {row.label}
                  </th>
                  <td className="px-5 py-4 align-top text-[15px] leading-7 text-bone sm:px-6">
                    {row.a}
                  </td>
                  <td className="px-5 py-4 align-top text-[15px] leading-7 text-ash sm:px-6">
                    {row.b}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </SectionShell>
  );
}

function ProseSection({ section }: { section: Extract<Section, { kind: "prose" }> }) {
  return (
    <SectionShell>
      <div className="mx-auto w-full max-w-3xl">
        <Eyebrow className="mb-5">{section.eyebrow}</Eyebrow>
        <AccentHeading
          as="h2"
          text={section.heading}
          className="mb-7 max-w-[24ch] text-[clamp(26px,4vw,42px)] leading-[1.06] text-bone"
        />
        <div className="space-y-6">
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 48)} className="text-[17px] leading-8 text-ash">
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}

function FaqSection({ page }: { page: SeoPage }) {
  if (page.faq.length === 0) return null;
  return (
    <SectionShell>
      <div className="mx-auto w-full max-w-3xl">
        <Eyebrow className="mb-5">Questions</Eyebrow>
        <h2
          className={cn(
            poster.className,
            "mb-12 text-[clamp(26px,4vw,42px)] leading-[1.06] font-light text-bone uppercase",
          )}
        >
          Asked, answered.
        </h2>
        <dl className="space-y-10">
          {page.faq.map((item) => (
            <div key={item.q} className="border-line-g border-t pt-6">
              <dt className="mb-3 text-[17px] font-medium text-bone">{item.q}</dt>
              <dd className="text-[15px] leading-7 text-ash">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </SectionShell>
  );
}

function RelatedSection({ page }: { page: SeoPage }) {
  const related = page.related
    .map((key) => findSeoPageByKey(key))
    .filter((entry): entry is SeoPage => entry !== undefined);
  if (related.length === 0) return null;
  return (
    <SectionShell>
      <div className="mx-auto w-full max-w-6xl">
        <Eyebrow className="mb-10">Keep reading</Eyebrow>
        <div className="grid min-w-0 gap-6 sm:grid-cols-3">
          {related.map((entry) => (
            <Link
              key={seoPageHref(entry)}
              href={seoPageHref(entry)}
              className="group rounded-sm border border-line-strong bg-char p-6 transition-colors hover:border-bone/40"
            >
              <p className="mb-2 font-sigil text-[10px] tracking-[0.22em] text-hellfire uppercase">
                {SEO_FAMILIES[entry.family].title}
              </p>
              <h3 className="mb-2 text-[16px] font-medium text-bone">{entry.cardTitle}</h3>
              <p className="mb-4 text-[14px] leading-6 text-ash">{entry.cardBlurb}</p>
              <span className={cn(CTA_QUIET, "text-[11px]")}>
                Read{" "}
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}

function ClosingCta() {
  return (
    <section className="relative isolate overflow-hidden px-5 py-24 text-center sm:px-8">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 55% at 50% 100%, rgba(225,30,21,.12), transparent 60%)",
        }}
      />
      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center">
        <h2
          className={cn(
            poster.className,
            "mb-8 text-[clamp(28px,5vw,52px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
          )}
        >
          Possess your first machine <em className="text-hellfire not-italic">in a minute.</em>
        </h2>
        <InstallOneLiner className="mb-9" />
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-9">
          <Link href="/signup" className={CTA_SLAB}>
            Sign up free
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link href="/security" className={CTA_QUIET}>
            Read the threat model
          </Link>
        </div>
      </div>
    </section>
  );
}

function renderSection(section: Section, plate: boolean) {
  switch (section.kind) {
    case "steps":
      return <StepsSection section={section} />;
    case "grid":
      return <GridSection section={section} plate={plate} />;
    case "split":
      return <SplitSection section={section} />;
    case "table":
      return <TableSection section={section} />;
    case "prose":
      return <ProseSection section={section} />;
  }
}

/** FAQPage + BreadcrumbList, the two structured-data types these pages earn. */
function StructuredData({ page }: { page: SeoPage }) {
  const family = SEO_FAMILIES[page.family];
  const data: object[] = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "spawnd", item: "https://spawnd.dev/" },
        {
          "@type": "ListItem",
          position: 2,
          name: family.title,
          item: `https://spawnd.dev/${page.family}`,
        },
        {
          "@type": "ListItem",
          position: 3,
          name: page.cardTitle,
          item: `https://spawnd.dev${seoPageHref(page)}`,
        },
      ],
    },
  ];
  if (page.faq.length > 0) {
    data.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faq.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    });
  }
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static registry data, serialized and escaped at build time */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
    </>
  );
}

export function SeoLandingPage({ page }: { page: SeoPage }) {
  let plateUsed = false;
  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <StructuredData page={page} />
      <Masthead />

      <header className="relative isolate overflow-hidden border-line-g border-b px-5 py-24 sm:px-8">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 60% 55% at 50% 0%, rgba(225,30,21,.12), transparent 60%)",
          }}
        />
        <RegistrationMarks />
        <div className="relative z-10 mx-auto w-full max-w-3xl text-center">
          <Eyebrow className="mb-5">{page.eyebrow}</Eyebrow>
          <AccentHeading
            as="h1"
            text={page.h1}
            className="mb-6 text-[clamp(34px,6.5vw,62px)] leading-[1.02] text-bone"
          />
          <p className="mx-auto mb-10 max-w-[58ch] text-[17px] leading-8 text-ash">{page.lede}</p>
          <div className="flex flex-col items-center justify-center gap-6 sm:flex-row sm:gap-9">
            <Link href="/signup" className={CTA_SLAB}>
              Sign up free
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link href="/download" className={CTA_QUIET}>
              Install the daemon
            </Link>
          </div>
        </div>
      </header>

      {page.sections.map((section, index) => {
        const plate = section.kind === "grid" && !plateUsed;
        if (plate) plateUsed = true;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: sections are static data, never reordered at runtime
          <div key={index}>{renderSection(section, plate)}</div>
        );
      })}

      <FaqSection page={page} />
      <RelatedSection page={page} />
      <ClosingCta />
      <Colophon />
    </main>
  );
}
