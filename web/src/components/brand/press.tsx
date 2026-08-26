"use client";

import { Check, Copy } from "lucide-react";
import Link from "next/link";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

/*
 * The pressroom: the chrome every public surface is printed with. The landing
 * page set this vocabulary — a centred lockup between two zones of sigil caps,
 * the bone slab CTA, the install chip on paper, the colophon — and /security
 * and /download now pull the same parts rather than each drawing their own.
 * Anything behind the account gate keeps the app's own voice; this is only for
 * the pages a stranger sees.
 */

export const GITHUB_URL = "https://github.com/levy-street/spawn";

/**
 * The primary action, everywhere: a bone slab on the void. Hellfire stays the
 * accent — a rule, a mark, a hover — and never becomes the button ground, so
 * the one red on the page always means "brand", never "click me".
 */
export const CTA_SLAB =
  "group inline-flex items-center justify-center gap-2 rounded-sm bg-bone px-7 py-[15px] font-sigil text-[13px] font-medium tracking-[0.14em] text-void uppercase transition-colors hover:bg-white";

/** The second action: sigil caps on an ember rule, never a competing slab. */
export const CTA_QUIET =
  "inline-flex items-center justify-center gap-2 font-sigil text-[12px] tracking-[0.18em] text-bone uppercase underline decoration-ember/70 underline-offset-8 transition-colors hover:text-ember hover:decoration-ember";

/** The label that sits above a poster heading and names the plate. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "font-sigil text-[12px] font-medium tracking-[0.3em] text-hellfire uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** The corners of the press bed, struck in the hero's hellfire. */
export function RegistrationMarks() {
  return (
    <span
      aria-hidden
      className="pointer-events-none z-10 font-sigil text-[15px] text-hellfire/50 select-none"
    >
      <span className="absolute top-3 left-4">+</span>
      <span className="absolute top-3 right-4">+</span>
      <span className="absolute bottom-3 left-4">+</span>
      <span className="absolute right-4 bottom-3">+</span>
    </span>
  );
}

/**
 * Collapses the masthead continuously with the scroll: every value is a pure
 * function of scrollY, written straight to the DOM, so there is no threshold to
 * flip back and forth across and no re-render per frame.
 */
function useMastheadScrub(): {
  navRef: RefObject<HTMLElement | null>;
  brandRef: RefObject<HTMLAnchorElement | null>;
  markRef: RefObject<HTMLSpanElement | null>;
  wordRef: RefObject<HTMLSpanElement | null>;
} {
  const navRef = useRef<HTMLElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const mix = (a: number, b: number, t: number) => a + (b - a) * t;
    let raf = 0;
    const update = () => {
      // 0 at the very top, 1 once 90px of scroll has passed.
      const p = Math.min(1, Math.max(0, window.scrollY / 90));
      if (navRef.current) navRef.current.style.paddingBlock = `${mix(24, 14, p)}px`;
      if (brandRef.current) brandRef.current.style.gap = `${mix(8, 0, p)}px`;
      if (markRef.current) {
        const size = mix(32, 28, p);
        markRef.current.style.width = `${size}px`;
        markRef.current.style.height = `${size}px`;
      }
      if (wordRef.current) {
        wordRef.current.style.height = `${mix(16, 0, p)}px`;
        wordRef.current.style.opacity = `${1 - p}`;
        wordRef.current.style.transform = `translateY(${mix(0, -4, p)}px)`;
      }
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(raf);
    };
  }, []);

  return { navRef, brandRef, markRef, wordRef };
}

/**
 * The masthead: three zones with the brand at the centre, pinned, collapsing as
 * you scroll. The session changes only the right-hand pair — no account, the two
 * doors in (log in, sign up); an account, the one door back (`/app`).
 *
 * `current` inks the link for the page you're already on rather than hiding it,
 * so the row never changes width between surfaces.
 */
export function Masthead({ current }: { current?: "security" | "download" }) {
  const { navRef, brandRef, markRef, wordRef } = useMastheadScrub();
  const { user } = useAuth();

  const zoneLink = (active: boolean) =>
    cn("hidden transition-colors sm:inline", active ? "text-bone" : "text-ash hover:text-bone");

  return (
    <header className="sticky top-0 z-40 border-line-g border-b bg-void/85 backdrop-blur-md">
      <nav
        ref={navRef}
        className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-4 px-5 py-6 font-sigil text-[11px] tracking-[0.22em] uppercase sm:grid sm:grid-cols-[1fr_auto_1fr] sm:px-8 sm:text-[12px]"
      >
        <div className="hidden items-center gap-7 sm:flex sm:gap-10">
          <Link
            href="/security"
            aria-current={current === "security" ? "page" : undefined}
            className={zoneLink(current === "security")}
          >
            Security
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={zoneLink(false)}>
            Open&nbsp;source
          </a>
        </div>
        <Link
          href="/"
          aria-label="spawnd home"
          ref={brandRef}
          className="flex flex-col items-center gap-2 text-hellfire"
        >
          <span ref={markRef} className="block size-8">
            <Trident className="size-full" />
          </span>
          <span ref={wordRef} aria-hidden className="block h-4 overflow-hidden">
            <Wordmark aria-hidden className="h-4" />
          </span>
        </Link>
        <div className="flex items-center justify-end gap-7 sm:gap-10">
          {user ? (
            <Link
              href="/app"
              className="text-ember transition-colors hover:text-hellfire"
              aria-label="Open spawnd"
            >
              Enter&nbsp;→
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden text-ash transition-colors hover:text-bone sm:inline"
              >
                Log&nbsp;in
              </Link>
              <Link href="/signup" className="text-ember transition-colors hover:text-hellfire">
                Sign&nbsp;up&nbsp;→
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

/** The colophon that closes every public page. */
export function Colophon() {
  return (
    <footer className="border-line-g border-t px-5 py-10 sm:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 font-sigil text-[11px] tracking-[0.14em] text-ash uppercase sm:flex-row">
        <span>consensual · auditable · revocable</span>
        <div className="flex items-center gap-5">
          <Link href="/security" className="transition-colors hover:text-bone">
            Security
          </Link>
          <Link href="/download" className="transition-colors hover:text-bone">
            Install
          </Link>
          <Link href="/login" className="transition-colors hover:text-bone">
            Log in
          </Link>
        </div>
        <span>Open source · MIT / Apache-2.0</span>
      </div>
    </footer>
  );
}

export interface StoreBadgeItem {
  id: string;
  label: string;
  /** Null while the listing is not public; the badge then reads "Coming soon". */
  href: string | null;
}

/**
 * The official App Store and Google Play badges, served from `public/brand/`
 * rather than the vendors' CDNs so the page stays self-contained.
 *
 * Both are trademarked artwork and must not be recoloured, restyled or
 * redrawn, so they are rendered as supplied. Apple asks for at least 40px of
 * badge height; Google ships ~49% of its asset as mandatory clear space, which
 * is why its box is 60px tall where Apple's is 40 — that renders the two
 * *visible* badges at the same height.
 *
 * A listing that is not live yet keeps the badge intact and adds a caption
 * beneath instead of dimming it: the artwork stays compliant, and nobody taps
 * a link that 404s.
 */
const STORE_ART: Record<string, { src: string; className: string; alt: string }> = {
  ios: {
    src: "/brand/app-store-badge.svg",
    // Explicit width and `max-w-none`: the preflight's `img { max-width:100% }`
    // fights a fixed height and squashes the artwork horizontally inside a
    // narrow flex parent. 56 x 119.66/40 = 167.5.
    className: "h-14 w-[168px] max-w-none",
    alt: "Download on the App Store",
  },
  android: {
    // Google ships ~13% of the asset's width and ~33% of its height as
    // mandatory clear space. The negative margins pull the box in to the
    // artwork so the two *visible* badges match; the panel padding restores
    // the clear space. 84 x 646/250 = 217.1.
    src: "/brand/google-play-badge.png",
    className: "-mx-3.5 -my-3.5 h-[84px] w-[217px] max-w-none",
    alt: "Get it on Google Play",
  },
};

/**
 * Just the badge artwork, for callers that supply their own ground — a card,
 * say, where three platforms have to line up as one row. [`StoreBadges`] is
 * the standalone version that brings its own panel.
 */
export function StoreBadgeMark({ id }: { id: string }) {
  const art = STORE_ART[id];
  if (!art) return null;
  return <StoreBadgeArt art={art} />;
}

function StoreBadgeArt({ art }: { art: { src: string; className: string; alt: string } }) {
  // biome-ignore lint/performance/noImgElement: vendor badge artwork, served as supplied
  return <img src={art.src} alt={art.alt} className={art.className} />;
}

export function StoreBadges({
  badges,
  className,
}: {
  badges: StoreBadgeItem[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-3", className)}>
      {badges.map((badge) => {
        const art = STORE_ART[badge.id];
        if (!art) return null;
        return badge.href ? (
          <a
            key={badge.id}
            href={badge.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex rounded-[10px] transition-opacity hover:opacity-85"
          >
            <StoreBadgeArt art={art} />
          </a>
        ) : (
          // Not a link yet, so the badge sits on a backdrop that carries the
          // date beneath it — one object rather than a badge with a caption
          // floating near it, which over the hero artwork read as debris.
          <span
            key={badge.id}
            className="inline-flex flex-col overflow-hidden rounded-[10px] bg-char"
          >
            <span className="flex items-center justify-center px-3.5 pt-3 pb-2">
              <StoreBadgeArt art={art} />
            </span>
            <span className="px-3.5 pb-2.5 text-center font-sigil text-[10px] tracking-[0.22em] text-ember uppercase">
              Coming soon
            </span>
          </span>
        );
      })}
    </div>
  );
}

export interface InstallChipTarget {
  id: string;
  label: string;
  command: string;
}

/**
 * The install one-liner on a paper chip, with a copy button.
 *
 * Pass `targets` to put an OS switcher above the line: a Windows visitor is
 * otherwise handed a `sh` pipeline their machine cannot run. With a single
 * target (or none) the chip renders exactly as it always did.
 */
export function InstallCommand({
  command,
  targets,
  defaultTargetId,
  className,
  copyLabel = "Copy install command",
}: {
  command?: string;
  targets?: InstallChipTarget[];
  /** Usually the detected browser OS; falls back to the first target. */
  defaultTargetId?: string;
  className?: string;
  /** Overridable so a page can name the button something the copy reads to. */
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  const tabs = targets ?? [];
  // Detection lands after mount, so an untouched chip follows it; once the
  // reader picks a tab themselves, their choice wins.
  const activeId = chosen ?? defaultTargetId ?? tabs[0]?.id;
  const active = tabs.find((target) => target.id === activeId) ?? tabs[0];
  const shown = active?.command ?? command ?? "";

  return (
    <div className={cn("max-w-full", className)}>
      <div
        className={cn(
          // inline-flex so the chip shrinks to its one line of shell wherever it
          // lands; a stretching flex parent (the hero column on mobile) still
          // pulls it full-width.
          "inline-flex max-w-full flex-col rounded-sm border border-bone bg-void font-sigil text-[13px] text-bone",
        )}
      >
        {tabs.length > 1 && (
          <div
            role="tablist"
            aria-label="Install target"
            className="flex items-center gap-5 border-b border-bone/25 px-4 py-2.5"
          >
            {tabs.map((target) => {
              const selected = target.id === active?.id;
              return (
                <button
                  key={target.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => {
                    setChosen(target.id);
                    setCopied(false);
                  }}
                  className={cn(
                    "text-[11px] tracking-[0.18em] uppercase transition-colors",
                    selected ? "text-bone" : "text-ash hover:text-bone",
                  )}
                >
                  {target.label}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex max-w-full items-center gap-3 py-3.5 pr-3 pl-4">
          <span className="text-ember">$</span>
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{shown}</code>
          <button
            type="button"
            aria-label={copyLabel}
            onClick={() => {
              void navigator.clipboard?.writeText(shown).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              });
            }}
            className="ml-1 shrink-0 rounded-sm p-1 text-bone/50 transition-colors hover:text-bone"
          >
            {copied ? (
              <Check className="size-4 text-ember" aria-hidden />
            ) : (
              <Copy className="size-4" aria-hidden />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
