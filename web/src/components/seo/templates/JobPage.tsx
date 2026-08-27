import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Colophon, Masthead } from "@/components/brand/press";
import { InstallOneLiner } from "@/components/seo/InstallOneLiner";
import { HeroInkVideo } from "@/components/seo/templates/HeroInkVideo";
import { cn } from "@/lib/utils";

/*
 * The job template — the editorial recipe every landing page reuses.
 *
 * Discipline over decoration: sentence case everywhere, whitespace instead of
 * borders, one media jewel per section, hellfire held back to the H1 accent
 * and the links. The hero is a dimmed full-bleed ink print under a date line,
 * the H1, and one subheading sentence; the body flows in a centered ~68ch
 * article column, with figures allowed to break wider. No section markers,
 * no eyebrows, no rules between sections — vertical air does the separating.
 */

const SITE = "https://spawnd.dev";

export interface JobCrumb {
  name: string;
  href: string;
}

export interface JobFaqItem {
  q: string;
  a: string;
}

export interface JobRelatedLink {
  title: string;
  blurb: string;
  href: string;
}

export interface JobHeading {
  plain: string;
  accent?: string;
}

export interface JobHeroInk {
  video: string;
  poster: string;
}

/** The heading voice of the page: the grimoire sans carrying weight, not caps. */
const H2_CLASS =
  "max-w-[26ch] text-[clamp(24px,3vw,32px)] leading-[1.15] font-semibold tracking-[-0.015em] text-bone [text-wrap:balance]";

/** An inline link: ember (the AA-safe hellfire) with a quiet underline. */
export const JOB_LINK =
  "text-ember underline decoration-ember/40 underline-offset-4 transition-colors hover:text-hellfire hover:decoration-hellfire";

/** BreadcrumbList + FAQPage, serialized and escaped at build time. */
function StructuredData({
  crumbs,
  pageName,
  canonicalPath,
  faq,
}: {
  crumbs: JobCrumb[];
  pageName: string;
  canonicalPath: string;
  faq: JobFaqItem[];
}) {
  const data: object[] = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "spawnd", item: `${SITE}/` },
        ...crumbs.map((crumb, index) => ({
          "@type": "ListItem",
          position: index + 2,
          name: crumb.name,
          item: `${SITE}${crumb.href}`,
        })),
        {
          "@type": "ListItem",
          position: crumbs.length + 2,
          name: pageName,
          item: `${SITE}${canonicalPath}`,
        },
      ],
    },
  ];
  if (faq.length > 0) {
    data.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
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
 * One body section: horizontal padding and generous vertical air, nothing
 * else. No borders, no markers — the whitespace is the separator.
 */
export function JobSection({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("px-5 py-14 sm:px-8 sm:py-24", className)}>{children}</section>;
}

/**
 * The article column: ~68ch, centered. Sets the prose voice so bare
 * paragraphs inside it need no classes of their own.
 */
export function JobProse({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[68ch] text-[16px] leading-8 text-ash", className)}>
      {children}
    </div>
  );
}

/** A section heading: sentence case, sized by hierarchy, no ceremony. */
export function JobH2({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn(H2_CLASS, className)}>{children}</h2>;
}

/**
 * Compact sub-blocks in the column — a short bone lead, a claim under it.
 * No cards, no rules; space alone groups them.
 */
export function JobPoints({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <div className="space-y-9">
      {items.map((item) => (
        <div key={item.title}>
          <h3 className="mb-1.5 text-[16px] leading-7 font-semibold text-bone">{item.title}</h3>
          <p>{item.body}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * A code figure: rounded, char ground, clean mono. No title bar, no chrome —
 * one quiet caption under it if the commands need naming.
 */
export function JobCodeFigure({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <figure className="min-w-0">
      <div className="overflow-x-auto rounded-xl bg-char px-6 py-5 font-sigil text-[13px] leading-7 text-bone">
        {children}
      </div>
      {caption ? (
        <figcaption className="mt-3 text-[13px] leading-6 text-ash">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * The page's single CTA moment, kept calm: a soft panel, the install
 * one-liner, one small primary pill and one quiet door.
 */
export function JobStart({ heading }: { heading: string }) {
  return (
    <JobSection>
      <div className="mx-auto w-full max-w-3xl rounded-2xl bg-char px-7 py-10 sm:px-12 sm:py-12">
        <h2 className={H2_CLASS}>{heading}</h2>
        <InstallOneLiner className="mt-8 rounded-lg border-line-strong" />
        <div className="mt-8 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-7">
          <Link
            href="/signup"
            className="inline-flex items-center justify-center rounded-full bg-bone px-6 py-2.5 text-[14px] leading-6 font-medium text-void transition-colors hover:bg-white"
          >
            Sign up free
          </Link>
          <Link
            href="/download"
            className="text-[14px] leading-6 text-ash underline decoration-line-strong underline-offset-4 transition-colors hover:text-bone hover:decoration-bone"
          >
            Install the daemon
          </Link>
        </div>
      </div>
    </JobSection>
  );
}

/** The FAQ, visually quiet in the column: small sentence-case questions. */
function FaqQuiet({ faq }: { faq: JobFaqItem[] }) {
  if (faq.length === 0) return null;
  return (
    <JobSection>
      <JobProse>
        <h2 className={H2_CLASS}>Questions</h2>
        <dl className="mt-10 space-y-9">
          {faq.map((item) => (
            <div key={item.q}>
              <dt className="mb-1.5 text-[16px] leading-7 font-semibold text-bone">{item.q}</dt>
              <dd className="text-[15px] leading-7">{item.a}</dd>
            </div>
          ))}
        </dl>
      </JobProse>
    </JobSection>
  );
}

/** Related pages as plain text links: a title, a dash, one line of blurb. */
function RelatedQuiet({ related }: { related: JobRelatedLink[] }) {
  if (related.length === 0) return null;
  return (
    <JobSection className="pb-24 sm:pb-32">
      <JobProse>
        <h2 className={H2_CLASS}>Related</h2>
        <ul className="mt-8 space-y-4">
          {related.map((entry) => (
            <li key={entry.href} className="text-[15px] leading-7">
              <Link
                href={entry.href}
                className="font-medium text-bone underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ember"
              >
                {entry.title}
              </Link>{" "}
              <span>— {entry.blurb}</span>
            </li>
          ))}
        </ul>
      </JobProse>
    </JobSection>
  );
}

/**
 * The hero: the full-bleed ink print dimmed hard enough to read over, under
 * three text elements only — a small grey date line, the sentence-case H1,
 * and one subheading sentence. No breadcrumb UI, no CTAs.
 */
function HeroInk({
  title,
  sub,
  date,
  ink,
}: {
  title: JobHeading;
  sub: string;
  date: string;
  ink: JobHeroInk;
}) {
  return (
    <header className="relative isolate overflow-hidden">
      <div aria-hidden className="absolute inset-0">
        <HeroInkVideo video={ink.video} poster={ink.poster} />
        <Image
          src={ink.poster}
          alt=""
          aria-hidden
          fill
          priority
          sizes="100vw"
          className="pointer-events-none hidden object-cover motion-reduce:block"
        />
        {/* The dim: darkest through the middle band where the type sits, so
         * the print breathes at the edges without competing with it. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.86) 34%, rgba(0,0,0,.86) 66%, rgba(0,0,0,.8) 84%, rgba(0,0,0,.92) 100%)",
          }}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-[72svh] w-full max-w-5xl flex-col items-center justify-center px-5 py-24 text-center sm:px-8 sm:py-28">
        <p className="text-[13px] leading-6 tracking-[0.01em] text-ash">{date}</p>
        <h1 className="mt-5 max-w-[30ch] text-[clamp(34px,4.8vw,60px)] leading-[1.08] font-semibold tracking-[-0.02em] text-bone [text-wrap:balance]">
          {title.plain}
          {title.accent ? (
            <>
              {" "}
              <em className="text-hellfire not-italic">{title.accent}</em>
            </>
          ) : null}
        </h1>
        <p className="mt-6 max-w-[54ch] text-[clamp(16px,1.6vw,18px)] leading-8 text-ash [text-wrap:balance]">
          {sub}
        </p>
      </div>
    </header>
  );
}

export function JobPage({
  crumbs,
  pageName,
  canonicalPath,
  hero,
  children,
  faq,
  related,
}: {
  crumbs: JobCrumb[];
  pageName: string;
  canonicalPath: string;
  hero: { title: JobHeading; sub: string; date: string; ink: JobHeroInk };
  children: ReactNode;
  faq: JobFaqItem[];
  related: JobRelatedLink[];
}) {
  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <StructuredData crumbs={crumbs} pageName={pageName} canonicalPath={canonicalPath} faq={faq} />
      <Masthead />
      <HeroInk title={hero.title} sub={hero.sub} date={hero.date} ink={hero.ink} />
      {children}
      <FaqQuiet faq={faq} />
      <RelatedQuiet related={related} />
      <Colophon />
    </main>
  );
}
