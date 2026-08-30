import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { preload } from "react-dom";
import { Colophon, GITHUB_URL } from "@/components/brand/press";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
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

/**
 * Review reference chips: visible only on the dev server, so a reviewer can
 * name any section or image unambiguously ("S5", "A4"). Production builds
 * render just the invisible anchor id.
 */
const SHOW_REFS = process.env.NODE_ENV !== "production";

export function RefTag({ id }: { id: string }) {
  if (!SHOW_REFS) return null;
  return (
    <span className="pointer-events-none absolute top-2 right-3 z-20 rounded bg-hellfire/80 px-1.5 py-0.5 font-sigil text-[10px] tracking-[0.1em] text-bone uppercase select-none">
      {id}
    </span>
  );
}

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
export function JobSection({
  children,
  className,
  refId,
}: {
  children: ReactNode;
  className?: string;
  refId?: string;
}) {
  return (
    <section
      id={refId}
      className={cn("relative scroll-mt-24 px-5 py-14 sm:px-8 sm:py-24", className)}
    >
      {refId ? <RefTag id={refId} /> : null}
      {children}
    </section>
  );
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

/** A product shot in the editorial frame: rounded, ringed, quietly captioned. */
export function JobShot({
  src,
  width,
  height,
  alt,
  caption,
  className,
  refId,
}: {
  src: string;
  width: number;
  height: number;
  alt: string;
  caption?: string;
  className?: string;
  refId?: string;
}) {
  return (
    <figure id={refId} className={cn("relative min-w-0 scroll-mt-24", className)}>
      {refId ? <RefTag id={refId} /> : null}
      <div className="overflow-hidden rounded-xl bg-void ring-1 ring-line-g">
        <Image
          src={src}
          width={width}
          height={height}
          alt={alt}
          sizes="(min-width: 1024px) 32rem, 100vw"
          className="block h-auto w-full"
        />
      </div>
      {caption ? (
        <figcaption className="mt-3 text-[13px] leading-6 text-ash">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * A feature section: prose beside one media column, on the wide rail. The
 * media keeps its natural aspect; `flip` puts it on the left.
 */
export function JobSplit({
  children,
  media,
  flip = false,
  mediaClassName,
}: {
  children: ReactNode;
  media: ReactNode;
  flip?: boolean;
  mediaClassName?: string;
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl items-center gap-12 lg:grid-cols-2 lg:gap-16">
      <div
        className={cn(
          "min-w-0 max-w-[58ch] text-[16px] leading-8 text-ash",
          flip ? "lg:order-2" : "",
        )}
      >
        {children}
      </div>
      <div className={cn("min-w-0", flip ? "lg:order-1" : "", mediaClassName)}>{media}</div>
    </div>
  );
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
export function JobCodeFigure({
  caption,
  children,
  refId,
}: {
  caption?: string;
  children: ReactNode;
  refId?: string;
}) {
  return (
    <figure id={refId} className="relative min-w-0 scroll-mt-24">
      {refId ? <RefTag id={refId} /> : null}
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
    <JobSection refId="start">
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
    <JobSection refId="faq">
      <JobProse>
        <h2 className={H2_CLASS}>Questions</h2>
        <dl className="mt-10 space-y-9">
          {faq.map((item, index) => (
            <div key={item.q}>
              <dt className="mb-1.5 text-[16px] leading-7 font-semibold text-bone">
                {SHOW_REFS ? (
                  <span className="mr-2 font-sigil text-[11px] text-hellfire">Q{index + 1}</span>
                ) : null}
                {item.q}
              </dt>
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
    <JobSection refId="related" className="pb-24 sm:pb-32">
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
/**
 * The masthead for SEO pages: same chrome as the pressroom's, minus the
 * session probe — a marketing page greets strangers, and a 401 in the
 * console is a poor greeting. Server-rendered, zero client JS.
 */
function MastheadStatic() {
  return (
    <header className="sticky top-0 z-40 border-line-g border-b bg-void/85 backdrop-blur-md">
      <nav className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-4 px-5 py-4 font-sigil text-[11px] tracking-[0.22em] uppercase sm:grid sm:grid-cols-[1fr_auto_1fr] sm:px-8 sm:text-[12px]">
        <div className="hidden items-center gap-7 sm:flex sm:gap-10">
          <Link href="/security" className="text-ash transition-colors hover:text-bone">
            Security
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-ash transition-colors hover:text-bone"
          >
            Open&nbsp;source
          </a>
        </div>
        <Link href="/" aria-label="spawnd home" className="flex items-center gap-2 text-hellfire">
          <span className="block size-7">
            <Trident className="size-full" />
          </span>
          <span className="hidden sm:block">
            <Wordmark aria-hidden className="h-4" />
          </span>
        </Link>
        <div className="flex items-center justify-end gap-7 sm:gap-10">
          <Link
            href="/login"
            className="hidden text-ash transition-colors hover:text-bone sm:inline"
          >
            Log&nbsp;in
          </Link>
          <Link href="/signup" className="text-ember transition-colors hover:text-hellfire">
            Sign&nbsp;up&nbsp;→
          </Link>
        </div>
      </nav>
    </header>
  );
}

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
  preload(ink.poster, { as: "image", fetchPriority: "high" });
  return (
    <header id="hero" className="relative isolate scroll-mt-24 overflow-hidden">
      <RefTag id="hero" />
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
      <MastheadStatic />
      <HeroInk title={hero.title} sub={hero.sub} date={hero.date} ink={hero.ink} />
      {children}
      <FaqQuiet faq={faq} />
      <RelatedQuiet related={related} />
      <Colophon />
    </main>
  );
}
