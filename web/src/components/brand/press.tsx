"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
import { useDesktopDownload } from "@/hooks/useDesktopDownload";
import { useDesktopShell } from "@/hooks/useDesktopShell";
import { useAuth, useAuthConfig } from "@/lib/auth";
import { type DesktopPlatform, WINDOWS_DESKTOP_PLATFORM } from "@/lib/platform";
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

/**
 * The second action where the first one is a slab and they share a plate: the
 * same shape and measure, drawn in the plate's own ground until it is pointed
 * at. Two slabs would argue; a bare rule next to a slab disappeared into the
 * print behind it.
 */
export const CTA_GHOST =
  "group inline-flex items-center justify-center gap-2 rounded-sm px-7 py-[15px] font-sigil text-[13px] font-medium tracking-[0.14em] text-bone uppercase transition-colors hover:bg-bone/12";

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
 * Whether this deployment sells anything, and may therefore offer a pricing
 * link. Fails **closed**: until something says otherwise the answer is no, so a
 * self-hosted install never advertises a shop it does not have.
 *
 * `serverAnswer` is what the page's own server render already knew — a public
 * page that read `GET /api/auth/config` server-side passes it down, so the link
 * is in the first paint rather than popping in. The browser then reads the same
 * endpoint and takes over: same source of truth, just later. On the first
 * client render that query has nothing yet, so the answer is the prop, which is
 * exactly what the server rendered — the same care `useDesktopShell` takes when
 * it reads the user agent in an effect instead of during render.
 */
function useBillingLink(serverAnswer: boolean): boolean {
  const { config } = useAuthConfig();
  // `useAuthConfig` seeds itself from a localStorage copy as placeholder
  // data, which the browser has during hydration and the server never did.
  // Reading it on the first client render put a Pricing link where the HTML
  // had Security, and React refused the tree. So the first client render
  // repeats the server's answer, and the config takes over one render later.
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  return hydrated && config ? config.billing.enabled : serverAnswer;
}

/** A store that never changes: `useSyncExternalStore` only wants its snapshots. */
function subscribeToNothing() {
  return () => {};
}

/**
 * The masthead: three zones with the brand at the centre, pinned, collapsing as
 * you scroll. The session changes only the right-hand pair — no account, the two
 * doors in (log in, sign up); an account, the one door back (`/app`).
 *
 * `current` inks the link for the page you're already on rather than hiding it,
 * so the row never changes width between surfaces.
 */
export function Masthead({
  current,
}: {
  current?: "security" | "download" | "pricing";
  /**
   * What the page's server render knew about billing. The masthead no
   * longer carries a pricing link — that lives in the colophon, which reads
   * this same answer — but pages pass it to both, so it stays accepted.
   */
  billingEnabled?: boolean;
}) {
  const { navRef, brandRef, markRef, wordRef } = useMastheadScrub();
  const { user } = useAuth();
  // Inside the app every zone but the brand leads somewhere the window cannot
  // come back from, and the brand itself has to lead the other way: whoever is
  // reading this in there wants the product, not more of the site.
  const inShell = useDesktopShell();

  const zoneLink = (active: boolean) =>
    cn("hidden transition-colors sm:inline", active ? "text-bone" : "text-ash hover:text-bone");

  return (
    <header className="sticky top-0 z-40 border-line-g border-b bg-void/85 backdrop-blur-md">
      <nav
        ref={navRef}
        className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-4 px-5 py-6 font-sigil text-[11px] tracking-[0.22em] uppercase sm:grid sm:grid-cols-[1fr_auto_1fr] sm:px-8 sm:text-[12px]"
      >
        <div className="hidden items-center gap-7 sm:flex sm:gap-10">
          {inShell ? null : (
            <>
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
            </>
          )}
        </div>
        <Link
          href={inShell ? "/app" : "/"}
          aria-label={inShell ? "Back to SPAWN D" : "SPAWN D home"}
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
          {user || inShell ? (
            <Link
              href="/app"
              className="text-ember transition-colors hover:text-hellfire"
              aria-label="Open SPAWN D"
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
                Sign&nbsp;up
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

/**
 * The colophon that closes every public page.
 *
 * Terms and Privacy are not billing-conditional: they are legal pages and they
 * exist on every deployment, self-hosted included. Pricing is, and fails closed
 * — see `useBillingLink`.
 */
export function Colophon({ billingEnabled = false }: { billingEnabled?: boolean }) {
  // The rule still closes the page in the app; the routes it offers do not,
  // because none of them is a place that window can be left.
  const inShell = useDesktopShell();
  const showPricing = useBillingLink(billingEnabled);

  return (
    <footer className="border-line-g border-t px-5 py-10 sm:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 font-sigil text-[11px] tracking-[0.14em] text-ash uppercase sm:flex-row">
        <span>consensual · auditable · revocable</span>
        {inShell ? null : (
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {showPricing && (
              <Link href="/pricing" className="transition-colors hover:text-bone">
                Pricing
              </Link>
            )}
            <Link href="/security" className="transition-colors hover:text-bone">
              Security
            </Link>
            <Link href="/download" className="transition-colors hover:text-bone">
              Install
            </Link>
            <Link href="/terms" className="transition-colors hover:text-bone">
              Terms
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-bone">
              Privacy
            </Link>
            <Link href="/login" className="transition-colors hover:text-bone">
              Log in
            </Link>
          </div>
        )}
        <span>Open source · MIT / Apache-2.0</span>
      </div>
    </footer>
  );
}

/**
 * Apple's mark, monochrome by rule, taking the ink of whatever it sits on.
 * Required beside "Download for macOS" the same way it is beside "Sign in with
 * Apple" (`components/onboarding/oauth-buttons`).
 */
function AppleMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-[26px] shrink-0 -translate-y-px fill-current", className)}
      viewBox="0 0 24 24"
    >
      <path d="M17.05 12.53c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.18-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.75 2.21 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.67-2.15.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.33-3.54zM14.86 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.7-.92 2.7.97.08 1.97-.49 2.58-1.23z" />
    </svg>
  );
}

/** Microsoft's four panes, monochrome so the slab keeps one ink. */
function WindowsMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-[22px] shrink-0 fill-current", className)}
      viewBox="0 0 24 24"
    >
      <path d="M2.5 4.7 11 3.5v8.1H2.5zM12.2 3.3 21.5 2v9.6h-9.3zM2.5 12.7H11v8L2.5 19.4zM12.2 12.7h9.3V22l-9.3-1.3z" />
    </svg>
  );
}

/**
 * The desktop download, set the way the phone stores set theirs: the platform's
 * own mark, then the words, as one object you press — not a caption with a
 * link somewhere under it.
 *
 * It uses the platform mark, not the vendor colour. Every download on this
 * site is the bone slab on the void, and hellfire is never a button ground,
 * so borrowing a vendor colour would put a second "click me" ink on the page
 * and break the one rule the palette carries.
 *
 * It is also a *download button*, which means it answers for the download and
 * not merely for the press: it fills as the file arrives, says when the file
 * is here, and on the next visit says that this browser already has this
 * build — offering another copy rather than pretending nothing happened. The
 * bytes come through `fetch` so there is something true to report; a browser
 * that cannot do that, or a fetch that fails, falls back to the plain link it
 * still is underneath, so the file is never held hostage to the flourish.
 *
 * Three situations, and only the first two are ordinary:
 *
 * - a `href`: the file, fetched on the press.
 * - `pending`: the release manifest has not named the build yet, which is the
 *   ordinary first paint. The slab presses like any other and holds the press
 *   until the name arrives. Sending that press to /download instead made the
 *   button a detour on every cold load, which is the one thing a download
 *   button must not be.
 * - neither: nothing to hand out here, so /download, where the builds are
 *   listed with their versions.
 */
export function DesktopDownloadButton({
  href,
  version = null,
  buildId = null,
  pending = false,
  className,
  label,
  platform,
}: {
  href: string | null;
  /** The build's version, for the words. */
  version?: string | null;
  /**
   * What tells this build from the last one of the same version — the desktop
   * tree, or the digest of the image. A rebuild changes it, and the button
   * goes back to offering a download rather than claiming you have this one.
   */
  buildId?: string | null;
  /** The release manifest has not answered yet; a press waits on it. */
  pending?: boolean;
  className?: string;
  label?: string;
  /** Exact artifact requested — the pending press is stamped with this value. */
  platform: DesktopPlatform;
}) {
  const { phase, percent, busy, alreadyHas, press } = useDesktopDownload({
    href,
    pending,
    platform,
    version,
    buildId,
  });
  const shell = cn(
    "group relative isolate inline-flex h-14 items-center justify-center gap-2.5 overflow-hidden rounded-sm bg-bone px-7 font-sigil text-[13px] font-medium tracking-[0.14em] text-void uppercase transition-colors hover:bg-white",
    className,
  );
  const windows = platform === WINDOWS_DESKTOP_PLATFORM;
  const mark = windows ? <WindowsMark /> : <AppleMark />;
  const words = label ?? (windows ? "Download for Windows" : "Download for macOS");
  const testId = windows ? "windows-download" : "mac-download";

  const spinner = <Loader2 className="size-[22px] shrink-0 animate-spin" aria-hidden="true" />;
  const face = (() => {
    switch (phase.at) {
      case "waiting":
        return { icon: spinner, said: "Preparing download" };
      case "running":
        return {
          icon: spinner,
          said:
            percent === null ? "Downloading" : `Downloading ${Math.min(99, Math.round(percent))}%`,
        };
      case "done":
        return {
          icon: <Check className="size-[22px] shrink-0" aria-hidden="true" />,
          said: "Downloaded",
        };
      case "failed":
        return { icon: mark, said: "Download started" };
      default:
        // A build this browser already has is still offered — just honestly.
        return { icon: mark, said: alreadyHas ? "Download again" : words };
    }
  })();
  const inner = (
    <>
      {percent !== null && (
        // The slab fills as the file arrives: the part still to come is the
        // part still shaded.
        <span
          aria-hidden="true"
          className="absolute inset-y-0 right-0 -z-10 bg-void/15 transition-[left] duration-150 ease-out"
          style={{ left: `${percent}%` }}
        />
      )}
      {face.icon}
      {face.said}
    </>
  );

  if (href === null && pending) {
    return (
      <button type="button" onClick={press} aria-busy={busy} className={shell} data-testid={testId}>
        {inner}
      </button>
    );
  }
  if (href === null) {
    return (
      <Link href="/download" className={shell} data-testid={testId}>
        {mark}
        {words}
      </Link>
    );
  }
  // A real link underneath, so a middle click, a right click and a keyboard
  // all behave — the flourish belongs to the ordinary press alone.
  return (
    <a
      href={href}
      download
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        press();
      }}
      aria-busy={busy}
      className={shell}
      data-testid={testId}
    >
      {inner}
    </a>
  );
}

export interface StoreBadgeItem {
  id: string;
  label: string;
  /** Null while the listing is not public; the badge is then artwork, not a link. */
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
 * A listing that is not live yet is the same artwork without the link: the
 * badge stays compliant, and nothing is drawn around or under it — a backdrop
 * or a caption made it a different object from the one beside it.
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
          <span key={badge.id} className="inline-flex rounded-[10px]">
            <StoreBadgeArt art={art} />
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
  prompt?: "$" | "PS>";
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
  onTargetChange,
  boxClassName,
}: {
  command?: string;
  targets?: InstallChipTarget[];
  /** Usually the detected browser OS; falls back to the first target. */
  defaultTargetId?: string;
  className?: string;
  /** Overridable so a page can name the button something the copy reads to. */
  copyLabel?: string;
  /**
   * Told which target the reader picked, so a caller can follow it. The chip
   * and the download button beside it are one answer to "what do I run on this
   * machine"; switching the chip to Windows and leaving a Mac download under it
   * made them two.
   */
  onTargetChange?: (id: string) => void;
  /**
   * Classes for the chip itself, for a caller that sets it inside a panel of
   * its own — where the chip's border would be a second line drawn a hair
   * inside the first.
   */
  boxClassName?: string;
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
          "inline-flex max-w-full flex-col rounded-[16px] border border-bone bg-void font-sigil text-[13px] text-bone",
          boxClassName,
        )}
      >
        {tabs.length > 1 && (
          <div
            role="tablist"
            aria-label="Install target"
            // The rule under the tabs is set in from both sides, like every
            // other divider inside a panel — an edge-to-edge line here read as
            // the chip's own border rather than a division inside it.
            className="relative flex flex-wrap items-center gap-x-5 gap-y-2 px-4 pt-4 pb-2.5 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-bone/25 after:content-['']"
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
                    onTargetChange?.(target.id);
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
          <span className="shrink-0 text-ember">{active?.prompt ?? "$"}</span>
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
