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
        <div className="flex flex-wrap items-center justify-center gap-5">
          <Link href="/security" className="transition-colors hover:text-bone">
            Security
          </Link>
          <Link href="/download" className="transition-colors hover:text-bone">
            Install
          </Link>
          <Link href="/use" className="transition-colors hover:text-bone">
            Use&nbsp;cases
          </Link>
          <Link href="/for" className="transition-colors hover:text-bone">
            Agents
          </Link>
          <Link href="/vs" className="transition-colors hover:text-bone">
            Compared
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

/** The install one-liner on a paper chip, with a copy button. */
export function InstallCommand({
  command,
  className,
  copyLabel = "Copy install command",
}: {
  command: string;
  className?: string;
  /** Overridable so a page can name the button something the copy reads to. */
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        // inline-flex so the chip shrinks to its one line of shell wherever it
        // lands; a stretching flex parent (the hero column on mobile) still
        // pulls it full-width.
        "inline-flex max-w-full items-center gap-3 rounded-sm border border-bone bg-void py-3.5 pr-3 pl-4 font-sigil text-[13px] text-bone",
        className,
      )}
    >
      <span className="text-ember">$</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
      <button
        type="button"
        aria-label={copyLabel}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
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
  );
}
