import { ArrowRight } from "lucide-react";
import Link from "next/link";
import {
  Colophon,
  CTA_QUIET,
  Eyebrow,
  Masthead,
  RegistrationMarks,
} from "@/components/brand/press";
import { SiteStructuredData } from "@/components/seo/SiteStructuredData";
import { poster } from "@/lib/fonts";
import { SEO_FAMILIES, seoPageHref, seoPagesByFamily } from "@/lib/seo/registry";
import type { SeoFamily } from "@/lib/seo/types";
import { cn } from "@/lib/utils";

/** A flat-slug page surfaced on a family index ahead of the registry rack. */
export interface SeoFeaturedCard {
  title: string;
  blurb: string;
  href: string;
}

/** The index plate for one landing-page family: a titled rack of cards. */
export function SeoFamilyIndex({
  family,
  featured = [],
}: {
  family: SeoFamily;
  featured?: SeoFeaturedCard[];
}) {
  const meta = SEO_FAMILIES[family];
  const pages = seoPagesByFamily(family);
  const cards = [
    ...featured,
    ...pages.map((page) => ({
      title: page.cardTitle,
      blurb: page.cardBlurb,
      href: seoPageHref(page),
    })),
  ];
  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <SiteStructuredData />
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
          <Eyebrow className="mb-5">{meta.title}</Eyebrow>
          <h1
            className={cn(
              poster.className,
              "mb-6 text-[clamp(32px,6vw,58px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            {meta.indexTitle}
          </h1>
          <p className="mx-auto max-w-[58ch] text-[17px] leading-8 text-ash">
            {meta.indexDescription}
          </p>
        </div>
      </header>

      <section className="px-5 py-20 sm:px-8 sm:py-24">
        <div className="mx-auto grid w-full max-w-6xl min-w-0 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="group flex flex-col rounded-sm border border-line-strong bg-char p-7 transition-colors hover:border-bone/40"
            >
              <h2 className="mb-3 text-[18px] font-medium text-bone">{card.title}</h2>
              <p className="mb-6 flex-1 text-[15px] leading-7 text-ash">{card.blurb}</p>
              <span className={cn(CTA_QUIET, "self-start text-[11px]")}>
                Read{" "}
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <Colophon />
    </main>
  );
}
