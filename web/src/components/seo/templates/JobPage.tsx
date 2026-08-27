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
import { cn } from "@/lib/utils";

/*
 * The job template: the page family for "the thing you are trying to do"
 * (/run-agents-in-parallel, /keep-agents-running, …), aimed at the agent
 * power user. It shares the pressroom's ink with every other public surface
 * but keeps its own structure: a left-set hero that runs straight into the
 * workspace-grid vignette, numbered plates with a heading rail beside the
 * evidence, and a bone closing sheet. Server component throughout — the only
 * client islands are the masthead and the install chip.
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

interface JobHeading {
  plain: string;
  accent?: string;
}

function PosterHeading({
  as: Tag,
  text,
  className,
}: {
  as: "h1" | "h2";
  text: JobHeading;
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
 * A numbered chapter: the heading rail on the left, the evidence beside it.
 * With no `aside` the prose takes the full measure.
 */
export function JobSection({
  index,
  eyebrow,
  heading,
  children,
  aside,
}: {
  index: string;
  eyebrow: string;
  heading: JobHeading;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="border-line-g border-b px-5 py-20 sm:px-8 sm:py-24">
      <div
        className={cn(
          "mx-auto grid w-full max-w-6xl min-w-0 gap-12",
          aside ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16" : "",
        )}
      >
        <div className={aside ? undefined : "max-w-3xl"}>
          <Eyebrow className="mb-5">
            {index} · {eyebrow}
          </Eyebrow>
          <PosterHeading
            as="h2"
            text={heading}
            className="mb-7 max-w-[18ch] text-[clamp(27px,3.8vw,44px)] leading-[1.05] text-bone"
          />
          <div className="space-y-5 text-[16px] leading-8 text-ash">{children}</div>
        </div>
        {aside ? <div className="min-w-0 lg:pt-14">{aside}</div> : null}
      </div>
    </section>
  );
}

/** The red plate: one per page, carrying the mechanics in numbered strokes. */
export function JobPlate({
  index,
  eyebrow,
  heading,
  lede,
  items,
}: {
  index: string;
  eyebrow: string;
  heading: JobHeading;
  lede?: string;
  items: { title: string; body: string }[];
}) {
  return (
    <section className="relative overflow-hidden bg-plate text-void">
      <div className="relative mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <p className="mb-5 font-sigil text-[12px] font-medium tracking-[0.3em] uppercase">
          {index} · {eyebrow}
        </p>
        <h2
          className={cn(
            poster.className,
            "mb-5 max-w-[20ch] text-[clamp(28px,4.6vw,50px)] leading-[1.02] font-light uppercase",
          )}
        >
          {heading.plain}
          {heading.accent ? ` ${heading.accent}` : ""}
        </h2>
        {lede ? (
          <p className="mb-14 max-w-[58ch] text-[16px] leading-7 text-void/80">{lede}</p>
        ) : (
          <div className="mb-14" />
        )}
        <div className="grid min-w-0 gap-y-12 sm:grid-cols-2 sm:gap-x-12 lg:gap-x-16">
          {items.map((item, itemIndex) => (
            <div key={item.title} className="border-t-2 border-void pt-5">
              <h3 className="mb-3 flex items-baseline gap-3 font-sigil text-[12px] font-medium tracking-[0.22em] uppercase">
                <span aria-hidden className="opacity-60">
                  {String(itemIndex + 1).padStart(2, "0")}
                </span>
                {item.title}
              </h3>
              <p className="max-w-[46ch] text-[15px] leading-7">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** A shell figure on the char plate — commands and output the page vouches for. */
export function JobShellFigure({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("min-w-0 border border-line-strong bg-char", className)}>
      <figcaption className="flex items-center justify-between gap-4 border-line-g border-b px-5 py-3.5 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
        <span>{title}</span>
      </figcaption>
      <div className="min-w-0 overflow-x-auto px-5 py-5 font-sigil text-[12px] leading-7 text-bone sm:px-6 sm:text-[13px]">
        {children}
      </div>
    </figure>
  );
}

function FaqSection({
  index,
  heading,
  faq,
}: {
  index: string;
  heading: JobHeading;
  faq: JobFaqItem[];
}) {
  if (faq.length === 0) return null;
  return (
    <section className="border-line-g border-b px-5 py-20 sm:px-8 sm:py-24">
      <div className="mx-auto w-full max-w-6xl">
        <Eyebrow className="mb-5">{index} · FAQ</Eyebrow>
        <PosterHeading
          as="h2"
          text={heading}
          className="mb-12 max-w-[20ch] text-[clamp(27px,3.8vw,44px)] leading-[1.05] text-bone"
        />
        <dl className="grid gap-x-16 gap-y-10 lg:grid-cols-2">
          {faq.map((item) => (
            <div key={item.q} className="border-line-g border-t pt-6">
              <dt className="mb-3 text-[17px] font-medium text-bone">{item.q}</dt>
              <dd className="text-[15px] leading-7 text-ash">{item.a}</dd>
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
      <div className="mx-auto w-full max-w-6xl">
        <Eyebrow className="mb-8">Adjacent pages</Eyebrow>
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
                <span className="font-medium text-[16px] text-bone">{entry.title}</span>{" "}
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

function ClosingSheet({ heading, body }: { heading: JobHeading; body: string }) {
  return (
    <section className="border-t-2 border-hellfire bg-bone text-void">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-5 py-24 text-center sm:px-8">
        <PosterHeading
          as="h2"
          text={heading}
          className="mb-6 text-[clamp(30px,5.4vw,56px)] leading-[1.0]"
        />
        <p className="mb-10 max-w-[56ch] text-[16px] leading-7 text-void/75">{body}</p>
        <InstallOneLiner className="mb-9" />
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-9">
          <Link
            href="/signup"
            className="group inline-flex items-center justify-center gap-2 rounded-sm bg-void px-7 py-[15px] font-sigil text-[13px] font-medium tracking-[0.14em] text-bone uppercase transition-colors hover:bg-char"
          >
            Sign up free
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            href="/security"
            className="inline-flex items-center justify-center gap-2 font-sigil text-[12px] tracking-[0.18em] text-void uppercase underline decoration-hellfire/70 underline-offset-8 transition-colors hover:text-hellfire"
          >
            Read the threat model
          </Link>
        </div>
      </div>
    </section>
  );
}

export function JobPage({
  crumbs,
  pageName,
  canonicalPath,
  heading,
  lede,
  vignette,
  children,
  faq,
  faqHeading = { plain: "The questions a fleet raises." },
  faqIndex = "04",
  related,
  closing,
}: {
  crumbs: JobCrumb[];
  pageName: string;
  canonicalPath: string;
  heading: JobHeading;
  lede: ReactNode;
  vignette: ReactNode;
  children: ReactNode;
  faq: JobFaqItem[];
  faqHeading?: JobHeading;
  faqIndex?: string;
  related: JobRelatedLink[];
  closing: { heading: JobHeading; body: string };
}) {
  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <StructuredData crumbs={crumbs} pageName={pageName} canonicalPath={canonicalPath} faq={faq} />
      <Masthead />

      <header className="relative isolate overflow-hidden border-line-g border-b px-5 pt-14 pb-16 sm:px-8 sm:pt-20 sm:pb-20">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 55% 60% at 18% 0%, rgba(225,30,21,.14), transparent 62%)",
          }}
        />
        <RegistrationMarks />
        <div className="relative z-10 mx-auto w-full max-w-6xl">
          <nav aria-label="Breadcrumb" className="mb-8">
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
          <PosterHeading
            as="h1"
            text={heading}
            className="mb-7 max-w-[24ch] text-[clamp(33px,5.3vw,58px)] leading-[1.04] text-bone"
          />
          <div className="max-w-[60ch] space-y-5 text-[17px] leading-8 text-ash">{lede}</div>
          <div className="mt-10 flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:gap-9">
            <Link href="/signup" className={CTA_SLAB}>
              Sign up free
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link href="/download" className={CTA_QUIET}>
              Install the daemon
            </Link>
          </div>
          <div className="mt-16">{vignette}</div>
        </div>
      </header>

      {children}

      <FaqSection index={faqIndex} heading={faqHeading} faq={faq} />
      <RelatedRack related={related} />
      <ClosingSheet heading={closing.heading} body={closing.body} />
      <Colophon />
    </main>
  );
}
