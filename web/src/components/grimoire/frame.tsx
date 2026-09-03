import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  Colophon,
  CTA_QUIET,
  CTA_SLAB,
  Eyebrow,
  InstallCommand,
  Masthead,
  RegistrationMarks,
} from "@/components/brand/press";
import { Inline } from "@/components/grimoire/Inline";
import { INSTALL_COMMAND } from "@/components/grimoire/link";
import { poster } from "@/lib/fonts";
import { stripInline } from "@/lib/grimoire/inline";
import type { Faq, RelatedLink } from "@/lib/grimoire/types";
import { cn } from "@/lib/utils";

/*
 * The grimoire frame: the pressroom's chrome around a landing page. Small red
 * type — eyebrows, step numerals — is set in ember, the AA-safe hellfire
 * (6.2:1 on the void; hellfire itself is 4.4:1, fine for the large H1 accent,
 * short of the 4.5:1 small text needs). The
 * same parts the landing, /security, and /download print with — masthead,
 * a hero struck on the press bed with registration marks, poster headings
 * in caps, hairline-bordered sections, the bone slab, the install chip, the
 * colophon — so a page a searcher lands on reads as the same site as the
 * page a visitor starts on. Structured data (Breadcrumb, FAQ, Article, and
 * HowTo when a guide supplies steps) is serialized at build time.
 */

export { LINK } from "@/components/grimoire/link";

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

/** "September 2026" from an ISO date, so the eyebrow never drifts from the schema. */
export function monthLine(iso: string): string {
  const [year, month] = iso.split("-");
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

export interface Crumb {
  name: string;
  href: string;
}

export interface ArticleInfo {
  headline: string;
  description: string;
  /** Site-relative path to the page's OG image. */
  image?: string;
  datePublished: string;
  dateModified: string;
}

export interface HowToInfo {
  name: string;
  description: string;
  steps: { name: string; text: string }[];
  canonicalPath: string;
}

/** Section heading: the poster face in caps, light, sized by hierarchy. */
const H2_CLASS =
  "max-w-[24ch] text-[clamp(26px,3.6vw,40px)] leading-[1.05] font-light text-bone uppercase [text-wrap:balance]";

export function H2({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn(poster.className, H2_CLASS, className)}>{children}</h2>;
}

/** One body section: a hairline below, generous vertical air. */
export function Section({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn("scroll-mt-24 border-line-g border-b px-5 py-16 sm:px-8 sm:py-20", className)}
    >
      {children}
    </section>
  );
}

/** The article column: ~68ch, centered, the prose voice set once. */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[68ch] text-[16.5px] leading-8 text-ash", className)}>
      {children}
    </div>
  );
}

/** Paragraphs from page strings, with their inline markup rendered. */
export function Paragraphs({
  paragraphs,
  className,
}: {
  paragraphs: string[];
  className?: string;
}) {
  return (
    <div className={cn("space-y-5", className)}>
      {paragraphs.map((paragraph) => (
        <p key={paragraph.slice(0, 48)}>
          <Inline text={paragraph} />
        </p>
      ))}
    </div>
  );
}

/** Short sub-blocks in the column: a bone lead, a claim under it. */
export function Points({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <div className="space-y-9">
      {items.map((item) => (
        <div key={item.title}>
          <h3 className="mb-1.5 text-[16px] leading-7 font-semibold text-bone">{item.title}</h3>
          <p>{typeof item.body === "string" ? <Inline text={item.body} /> : item.body}</p>
        </div>
      ))}
    </div>
  );
}

/** A code figure: char ground, hairline, the sigil mono, one quiet caption. */
export function CodeFigure({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <figure className="min-w-0">
      <div className="overflow-x-auto rounded-sm border border-line-strong bg-char px-6 py-5 font-sigil text-[13px] leading-7 text-bone">
        {children}
      </div>
      {caption ? (
        <figcaption className="mt-3 text-[13px] leading-6 text-ash">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

/** The page's single call: the install chip, the bone slab, the quiet door. */
export function Start({ heading }: { heading: string }) {
  return (
    <Section id="start">
      <div className="mx-auto w-full max-w-3xl">
        <Eyebrow className="mb-5 text-ember">Start</Eyebrow>
        <H2>{heading}</H2>
        <div className="mt-9 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center">
          <InstallCommand command={INSTALL_COMMAND} />
          <Link prefetch={false} href="/signup" className={CTA_SLAB}>
            Sign up free
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
        <Link prefetch={false} href="/download" className={cn(CTA_QUIET, "mt-8")}>
          Install the daemon
        </Link>
      </div>
    </Section>
  );
}

/** BreadcrumbList + FAQPage + Article (+ HowTo), serialized and escaped at build time. */
function StructuredData({
  crumb,
  pageName,
  canonicalPath,
  faq,
  article,
  howTo,
}: {
  crumb?: Crumb;
  pageName: string;
  canonicalPath: string;
  faq: Faq[];
  article?: ArticleInfo;
  howTo?: HowToInfo;
}) {
  const trail = [
    { "@type": "ListItem", position: 1, name: "spawnd", item: `${SITE}/` },
    ...(crumb
      ? [{ "@type": "ListItem", position: 2, name: crumb.name, item: `${SITE}${crumb.href}` }]
      : []),
    {
      "@type": "ListItem",
      position: crumb ? 3 : 2,
      name: pageName,
      item: `${SITE}${canonicalPath}`,
    },
  ];
  const data: object[] = [
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: trail },
  ];
  if (faq.length > 0) {
    data.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: stripInline(item.q),
        acceptedAnswer: { "@type": "Answer", text: stripInline(item.a) },
      })),
    });
  }
  if (article) {
    data.push({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: article.headline,
      description: article.description,
      ...(article.image ? { image: [`${SITE}${article.image}`] } : {}),
      datePublished: article.datePublished,
      dateModified: article.dateModified,
      author: [{ "@type": "Organization", name: "SPAWN D", url: SITE }],
      publisher: {
        "@type": "Organization",
        name: "SPAWN D",
        url: SITE,
        logo: { "@type": "ImageObject", url: `${SITE}/icon-512.png` },
      },
      mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE}${canonicalPath}` },
    });
  }
  if (howTo) {
    data.push({
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: howTo.name,
      description: howTo.description,
      step: howTo.steps.map((step, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        name: step.name,
        text: stripInline(step.text),
        url: `${SITE}${howTo.canonicalPath}#step-${index + 1}`,
      })),
    });
  }
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: static page data, serialized and escaped at build time
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
  );
}

/**
 * The hero, struck on the press bed: the hellfire glow, the registration
 * marks, an eyebrow naming the plate and the month, the poster H1 with its
 * one accent, and a single lead sentence.
 */
function Hero({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: { plain: string; accent?: string };
  sub: string;
}) {
  return (
    <header
      id="hero"
      className="relative isolate overflow-hidden border-line-g border-b px-5 py-20 sm:px-8 sm:py-24"
    >
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
        <Eyebrow className="mb-5 text-ember">{eyebrow}</Eyebrow>
        <h1
          className={cn(
            poster.className,
            "mb-6 text-[clamp(32px,5.6vw,58px)] leading-[1.04] font-light text-bone uppercase [text-wrap:balance]",
          )}
        >
          {title.plain}
          {title.accent ? (
            <>
              {" "}
              <em className="text-hellfire not-italic">{title.accent}</em>
            </>
          ) : null}
        </h1>
        <p className="mx-auto max-w-[58ch] text-[17px] leading-8 text-ash [text-wrap:balance]">
          {sub}
        </p>
      </div>
    </header>
  );
}

function FaqSection({ faq }: { faq: Faq[] }) {
  if (faq.length === 0) return null;
  return (
    <Section id="faq">
      <Prose>
        <Eyebrow className="mb-5 text-ember">Questions</Eyebrow>
        <dl className="space-y-9">
          {faq.map((item) => (
            <div key={item.q}>
              <dt className="mb-1.5 text-[16px] leading-7 font-semibold text-bone">
                <Inline text={item.q} />
              </dt>
              <dd className="text-[15.5px] leading-7">
                <Inline text={item.a} />
              </dd>
            </div>
          ))}
        </dl>
      </Prose>
    </Section>
  );
}

function RelatedSection({ related }: { related: RelatedLink[] }) {
  if (related.length === 0) return null;
  return (
    <Section id="related" className="border-b-0">
      <Prose>
        <Eyebrow className="mb-5 text-ember">Related</Eyebrow>
        <ul className="space-y-4">
          {related.map((entry) => (
            <li key={entry.href} className="text-[15.5px] leading-7">
              <Link
                prefetch={false}
                href={entry.href}
                className="font-medium text-bone underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ember"
              >
                {entry.title}
              </Link>{" "}
              <span>— {entry.blurb}</span>
            </li>
          ))}
        </ul>
      </Prose>
    </Section>
  );
}

export function Frame({
  crumb,
  pageName,
  canonicalPath,
  hero,
  date,
  children,
  faq,
  related,
  article,
  howTo,
}: {
  crumb?: Crumb;
  pageName: string;
  canonicalPath: string;
  hero: { title: { plain: string; accent?: string }; sub: string };
  /** ISO date the eyebrow prints as a month. */
  date: string;
  children: ReactNode;
  faq: Faq[];
  related: RelatedLink[];
  article?: ArticleInfo;
  howTo?: HowToInfo;
}) {
  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <StructuredData
        crumb={crumb}
        pageName={pageName}
        canonicalPath={canonicalPath}
        faq={faq}
        article={article}
        howTo={howTo}
      />
      <Masthead />
      <Hero
        eyebrow={`${crumb?.name ?? "spawnd"} · ${monthLine(date)}`}
        title={hero.title}
        sub={hero.sub}
      />
      {children}
      <FaqSection faq={faq} />
      <RelatedSection related={related} />
      <Colophon />
    </main>
  );
}
