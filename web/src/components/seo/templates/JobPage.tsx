import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  Colophon,
  CTA_QUIET,
  CTA_SLAB,
  Masthead,
  RegistrationMarks,
} from "@/components/brand/press";
import { InstallOneLiner } from "@/components/seo/InstallOneLiner";
import { HeroInkVideo } from "@/components/seo/templates/HeroInkVideo";
import { poster } from "@/lib/fonts";
import { cn } from "@/lib/utils";

/*
 * The job template — the recipe every landing page reuses.
 *
 * Hero: heavy branding, minimal words. A dimmed full-bleed ink print under
 * exactly two text elements (the keyword H1 and one subheading sentence),
 * with the breadcrumb kept small above. No CTAs, no captures, no kickers.
 * The body earns one rich visual (the product capture), one CTA moment, and
 * a quiet FAQ; whitespace is the ornament. Every section shares the same
 * rail (max-w-5xl) and the same hairline borders.
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
  family: string;
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

function HeadingText({ text }: { text: JobHeading }) {
  return (
    <>
      {text.plain}
      {text.accent ? (
        <>
          {" "}
          <em className="text-hellfire not-italic">{text.accent}</em>
        </>
      ) : null}
    </>
  );
}

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

/** The small sigil label that opens a body section. */
function Marker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "font-sigil text-[11px] font-medium tracking-[0.3em] text-hellfire uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * One body section on the shared rail: hairline border below, generous
 * vertical air, an optional marker naming the plate.
 */
export function JobSection({
  marker,
  children,
  className,
}: {
  marker?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-line-g border-b px-5 py-20 sm:px-8 sm:py-28", className)}>
      <div className="mx-auto w-full max-w-5xl">
        {marker ? <Marker className="mb-10">{marker}</Marker> : null}
        {children}
      </div>
    </section>
  );
}

/** A section heading in the poster face. */
export function JobH2({ text, className }: { text: JobHeading; className?: string }) {
  return (
    <h2
      className={cn(
        poster.className,
        "max-w-[24ch] text-[clamp(26px,3.6vw,42px)] leading-[1.06] font-light text-bone uppercase [text-wrap:balance]",
        className,
      )}
    >
      <HeadingText text={text} />
    </h2>
  );
}

/** Three problems, three columns: a rule, a word, a claim. */
export function JobTrio({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <div className="grid gap-12 md:grid-cols-3 md:gap-8 lg:gap-12">
      {items.map((item) => (
        <div key={item.title} className="border-t border-line-strong pt-6">
          <h3
            className={cn(
              poster.className,
              "mb-4 text-[21px] leading-[1.1] font-light text-bone uppercase",
            )}
          >
            {item.title}
          </h3>
          <p className="max-w-[46ch] text-[15px] leading-7 text-ash">{item.body}</p>
        </div>
      ))}
    </div>
  );
}

/** Mechanics in one breath: a single quiet strip of fragments, one link out. */
export function JobMechanics({
  fragments,
  link,
}: {
  fragments: string[];
  link: { label: string; href: string };
}) {
  return (
    <section className="border-line-g border-b px-5 py-14 sm:px-8 sm:py-16">
      <div className="mx-auto w-full max-w-5xl">
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-2.5 font-sigil text-[12px] tracking-[0.14em] text-bone uppercase sm:text-[13px]">
          {fragments.map((fragment, index) => (
            <span key={fragment} className="flex items-baseline gap-x-4">
              {index > 0 ? (
                <span aria-hidden className="text-hellfire">
                  ·
                </span>
              ) : null}
              <span>{fragment}</span>
            </span>
          ))}
        </p>
        <Link
          href={link.href}
          className="mt-6 inline-block font-sigil text-[11px] tracking-[0.18em] text-ash uppercase underline decoration-line-strong underline-offset-8 transition-colors hover:text-bone hover:decoration-ember"
        >
          {link.label}
        </Link>
      </div>
    </section>
  );
}

/** A small shell figure — commands the page vouches for, set quietly. */
export function JobShellAside({ title, children }: { title: string; children: ReactNode }) {
  return (
    <figure className="min-w-0 border border-line-g bg-char">
      <figcaption className="border-line-g border-b px-5 py-3 font-sigil text-[10px] tracking-[0.22em] text-ash uppercase">
        {title}
      </figcaption>
      <div className="min-w-0 overflow-x-auto px-5 py-4 font-sigil text-[12px] leading-7 text-bone">
        {children}
      </div>
    </figure>
  );
}

/** The page's single CTA moment: the one-liner, the slab, the quiet door. */
export function JobStart({ heading, aside }: { heading: JobHeading; aside?: ReactNode }) {
  return (
    <JobSection marker="Start">
      <div
        className={cn(
          "grid gap-14",
          aside ? "lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center" : "",
        )}
      >
        <div>
          <JobH2 text={heading} />
          <InstallOneLiner className="mt-10" />
          <div className="mt-9 flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:gap-9">
            <Link href="/signup" className={CTA_SLAB}>
              Sign up free
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link href="/download" className={CTA_QUIET}>
              Install the daemon
            </Link>
          </div>
        </div>
        {aside ? <div className="min-w-0">{aside}</div> : null}
      </div>
    </JobSection>
  );
}

/** The FAQ, kept visually quiet: small type, generous space, no ceremony. */
function FaqQuiet({ faq }: { faq: JobFaqItem[] }) {
  if (faq.length === 0) return null;
  return (
    <section className="border-line-g border-b px-5 py-20 sm:px-8 sm:py-24">
      <div className="mx-auto w-full max-w-5xl">
        <p className="mb-12 font-sigil text-[11px] font-medium tracking-[0.3em] text-ash uppercase">
          Questions
        </p>
        <dl className="max-w-[72ch] space-y-10">
          {faq.map((item) => (
            <div key={item.q}>
              <dt className="mb-2.5 text-[15px] font-medium text-bone">{item.q}</dt>
              <dd className="text-[14px] leading-7 text-ash">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function RelatedRack({ related }: { related: JobRelatedLink[] }) {
  if (related.length === 0) return null;
  return (
    <section className="border-line-g border-b px-5 py-16 sm:px-8 sm:py-20">
      <div className="mx-auto w-full max-w-5xl">
        <p className="mb-8 font-sigil text-[11px] font-medium tracking-[0.3em] text-ash uppercase">
          Related
        </p>
        <div className="border-line-g border-t">
          {related.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="group grid gap-1 border-line-g border-b py-5 pr-1 transition-colors hover:bg-char/60 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-6"
            >
              <span className="font-sigil text-[10px] tracking-[0.22em] text-hellfire uppercase">
                {entry.family}
              </span>
              <span className="min-w-0">
                <span className="font-medium text-[15px] text-bone">{entry.title}</span>{" "}
                <span className="text-[14px] text-ash">— {entry.blurb}</span>
              </span>
              <ArrowRight
                aria-hidden
                className="hidden size-4 self-center text-ash transition-transform group-hover:translate-x-0.5 group-hover:text-bone sm:block"
              />
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The hero: a full-bleed ink print, dimmed hard, under exactly two text
 * elements. The breadcrumb stays small at the top; the type hangs at the
 * bottom of the frame so the print breathes through the middle.
 */
function HeroInk({
  crumbs,
  pageName,
  title,
  sub,
  ink,
}: {
  crumbs: JobCrumb[];
  pageName: string;
  title: JobHeading;
  sub: string;
  ink: JobHeroInk;
}) {
  return (
    <header className="relative isolate overflow-hidden border-line-g border-b">
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
        {/* The dim: hard everywhere the type lives, easing only through the
         * upper-middle band so the print shows without competing. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,.95) 0%, rgba(0,0,0,.72) 30%, rgba(0,0,0,.68) 48%, rgba(0,0,0,.9) 74%, rgba(0,0,0,.97) 100%)",
          }}
        />
        {/* The hellfire glow, rising under the headline. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 64% 58% at 16% 100%, rgba(225,30,21,.32), transparent 66%)",
          }}
        />
      </div>
      <RegistrationMarks />

      <div className="relative z-10 mx-auto flex min-h-[84svh] w-full max-w-[1440px] flex-col items-start px-5 pt-5 pb-16 sm:px-8 sm:pt-7 sm:pb-20">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-sigil text-[11px] tracking-[0.18em] text-ash uppercase">
            <li>
              <Link href="/" className="transition-colors hover:text-bone">
                spawnd
              </Link>
            </li>
            {crumbs.map((crumb) => (
              <li key={crumb.href} className="flex items-center gap-2.5">
                <span aria-hidden className="text-line-strong">
                  /
                </span>
                <Link href={crumb.href} className="transition-colors hover:text-bone">
                  {crumb.name}
                </Link>
              </li>
            ))}
            <li aria-current="page" className="flex items-center gap-2.5">
              <span aria-hidden className="text-line-strong">
                /
              </span>
              <span className="text-ember">{pageName}</span>
            </li>
          </ol>
        </nav>

        <div className="mt-auto pt-28">
          <h1
            className={cn(
              poster.className,
              "max-w-[19ch] text-[clamp(34px,5.4vw,72px)] leading-[1.06] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            {title.plain}
            {title.accent ? (
              // The accent takes its own line: the keyword lands as the punch.
              <em className="block text-hellfire not-italic">{title.accent}</em>
            ) : null}
          </h1>
          <p className="mt-6 max-w-[52ch] text-[clamp(16px,1.7vw,19px)] leading-8 text-ash">
            {sub}
          </p>
        </div>
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
  hero: { title: JobHeading; sub: string; ink: JobHeroInk };
  children: ReactNode;
  faq: JobFaqItem[];
  related: JobRelatedLink[];
}) {
  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <StructuredData crumbs={crumbs} pageName={pageName} canonicalPath={canonicalPath} faq={faq} />
      <Masthead />
      <HeroInk
        crumbs={crumbs}
        pageName={pageName}
        title={hero.title}
        sub={hero.sub}
        ink={hero.ink}
      />
      {children}
      <FaqQuiet faq={faq} />
      <RelatedRack related={related} />
      <Colophon />
    </main>
  );
}
