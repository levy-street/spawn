"use client";

import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Colophon,
  CTA_GHOST,
  CTA_QUIET,
  CTA_SLAB,
  InstallCommand,
  MacDownloadButton,
  Masthead,
  RegistrationMarks,
  StoreBadges,
} from "@/components/brand/press";
import { Wordmark } from "@/components/icons/BrandMark";
import { useDesktopRelease } from "@/hooks/useDesktopRelease";
import { poster } from "@/lib/fonts";
import {
  detectPlatform,
  installTargetForOS,
  installTargets,
  type PlatformOS,
  storeBadgeForOS,
  storeBadges,
} from "@/lib/platform";
import { cn } from "@/lib/utils";

/*
 * ── Scroll system ────────────────────────────────────────────────
 * Every effect below is scrubbed: a pure function of scroll position,
 * so it plays forward as you scroll down and in reverse as you scroll
 * back. One shared shape — rAF-throttled scroll/resize listeners,
 * transform-only writes, inert under reduced motion.
 */

function useScrub(
  ref: RefObject<HTMLElement | null>,
  frame: (el: HTMLElement, viewProgress: number, scrollY: number) => void,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // 0 when the element's top edge is below the fold, 1 when its bottom
      // edge has scrolled past the top — a full travel through the viewport.
      const progress = Math.min(1, Math.max(0, (vh - rect.top) / (vh + rect.height)));
      frame(el, progress, window.scrollY);
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
  }, [ref, frame]);
}

/** Scroll-scrubbed vertical drift: rises (or sinks, negative speed) as the
 * element travels through the viewport, and reverses with the scroll. */
function Drift({
  speed,
  className,
  children,
}: {
  speed: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useScrub(
    ref,
    useCallback(
      (el, progress) => {
        el.style.transform = `translate3d(0, ${((progress - 0.5) * -speed).toFixed(2)}px, 0)`;
      },
      [speed],
    ),
  );
  return (
    <div ref={ref} className={cn("will-change-transform", className)}>
      {children}
    </div>
  );
}

/** The black stamp on the red plate turns a few degrees with the scroll. */
function ScrollStamp() {
  const ref = useRef<HTMLDivElement>(null);
  useScrub(
    ref,
    useCallback((el, progress) => {
      el.style.transform = `rotate(${(4 + progress * 16).toFixed(2)}deg)`;
    }, []),
  );
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute -top-20 -right-20 size-[16rem] rotate-[4deg] opacity-[0.10] will-change-transform sm:size-[22rem]"
    >
      {/* biome-ignore lint/performance/noImgElement: decorative stamp, no optimization needed */}
      <img src="/brand/spawnd-icon-black.svg" alt="" className="size-full" />
    </div>
  );
}

const AGENT_SPECIMENS = ["claude", "codex", "opencode", "aider", "$SHELL"];

/** The specimen strip is driven by the scroll position itself — it slides as
 * you scroll and slides back when you do. */
function ScrubMarquee() {
  const ref = useRef<HTMLDivElement>(null);
  useScrub(
    ref,
    useCallback((el, _progress, scrollY) => {
      const half = el.scrollWidth / 2;
      if (!half) return;
      const x = (scrollY * 0.45) % half;
      el.style.transform = `translate3d(${(-x).toFixed(2)}px, 0, 0)`;
    }, []),
  );
  return (
    <div className="overflow-hidden">
      <div
        ref={ref}
        className="flex w-max items-baseline font-sigil text-[clamp(26px,4.5vw,48px)] whitespace-nowrap text-bone will-change-transform"
      >
        {[0, 1].map((copy) => (
          <div
            key={copy}
            aria-hidden={copy === 1}
            className="flex items-baseline gap-8 whitespace-nowrap pr-8"
          >
            {AGENT_SPECIMENS.map((agent) => (
              <span key={agent} className="flex items-baseline gap-8">
                <span>{agent}</span>
                <span aria-hidden className="text-hellfire">
                  ✕
                </span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A living print whose playhead is driven by the scroll: it scrubs forward
 * as the plate travels up the viewport and rewinds when you scroll back.
 * Under reduced motion the scrub never arms and the poster frame stands. */
function ScrubVideo({ src, poster, alt }: { src: string; poster: string; alt: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useScrub(
    wrapRef,
    useCallback((el, _progress) => {
      const video = videoRef.current;
      if (!video || video.readyState < 1 || !Number.isFinite(video.duration)) return;
      // A pending seek means the decoder is still busy — queueing another
      // behind it is what turns scrubbing into a slideshow.
      if (video.seeking) return;
      // Position through the viewport alone: playback begins once the plate's
      // top has climbed into view and completes only when its BOTTOM nears
      // the top edge, so tall plates play for their whole visible life.
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const start = vh * 0.8;
      const travelled = start - rect.top;
      const full = start - vh * 0.3 + rect.height;
      const p = Math.min(1, Math.max(0, travelled / full));
      const t = Math.min(video.duration - 0.05, p * video.duration);
      if (Math.abs(t - video.currentTime) < 1 / 30) return;
      video.currentTime = t;
    }, []),
  );
  return (
    <div ref={wrapRef} className="absolute inset-0">
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        muted
        playsInline
        preload="auto"
        poster={poster}
        aria-label={alt}
      >
        <source src={src} type="video/mp4" />
      </video>
    </div>
  );
}

/**
 * The lander is `/` for everyone, signed in or not — the brand mark in the
 * app chrome comes back here, and so does signing out. The masthead, the
 * install chip, and the colophon are the shared press chrome
 * (`components/brand/press`), so /security and /download wear them too.
 */
export default function LandingPage() {
  const [origin, setOrigin] = useState("https://spawnd.dev");
  const [detectedOS, setDetectedOS] = useState<PlatformOS>("unknown");
  // The Mac build the hero hands out, named by the release manifest rather
  // than guessed at. Until it answers, the slab holds a press instead of
  // sending it to /download — see `MacDownloadButton`.
  const {
    settled: releaseSettled,
    url: macBuildUrl,
    version: macBuildVersion,
    buildId: macBuildId,
  } = useDesktopRelease(origin);
  /**
   * The install target the reader picked on the chip, once they have picked
   * one. The chip and the download beside it answer the same question, so
   * switching the chip to Windows switches the button with it.
   */
  const [chosenTarget, setChosenTarget] = useState<string | null>(null);
  /**
   * Whether the panel's two sections step apart, measured rather than assumed:
   * the shell line grows and shrinks with the target, and the buttons wrap on a
   * narrow window.
   *
   * A step is either worth the name or it is not there at all. Below the
   * threshold the line above is grown to the row's width instead, because a
   * five-pixel overhang with square corners is not a shape — it is a slip.
   */
  const commandRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  // Stepped until measured otherwise: the common case (and the one the server
  // renders) is the buttons running wider than the shell line, and starting
  // flush meant the panel painted square and then stepped a frame later.
  const [stepped, setStepped] = useState(true);

  useEffect(() => {
    const measure = () => {
      const command = commandRef.current;
      const actions = actionsRef.current;
      if (!command || !actions) return;
      // Measured off the stretch, not through it: once the line above is grown
      // to match, its rendered width would answer "flush" for ever, however the
      // row changed underneath it.
      const stretched = command.style.width;
      command.style.width = "auto";
      const intrinsic = command.getBoundingClientRect().width;
      command.style.width = stretched;
      setStepped(intrinsic > 0 && actions.getBoundingClientRect().width - intrinsic >= 32);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (commandRef.current) observer.observe(commandRef.current);
    if (actionsRef.current) observer.observe(actionsRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const platform = detectPlatform();
    setOrigin(platform.origin);
    setDetectedOS(platform.os);
  }, []);

  const targets = installTargets(origin);
  const defaultTargetId = installTargetForOS(detectedOS);
  // A phone cannot host the daemon, so the shell line is noise there — the
  // reader wants the app instead. Detection lands after mount, so the server
  // render keeps the install chip and a phone swaps to the badge.
  const phoneBadge = storeBadgeForOS(detectedOS);
  // The app itself is Mac-only, so a detected Linux or Windows reader keeps
  // the plain slab to /download rather than being handed a build their machine
  // cannot open. Undetected (the server render, and any browser we cannot
  // read) gets the Mac slab: it is the download this site is here to hand out,
  // and /download is one press away either way.
  const installTarget = chosenTarget ?? defaultTargetId;
  const windowsChosen = installTarget === "windows";

  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <Masthead />

      {/* ── The living hero: full-bleed ink video, type top-left ── */}
      <section className="relative isolate overflow-hidden border-line-g border-b">
        {/* The print hangs low in the frame — black headroom above it, and its
         * own black edges blend into the ground. */}
        <div className="absolute inset-x-0 top-0 bottom-0">
          <video
            className="pointer-events-none absolute inset-0 h-full w-full object-cover motion-reduce:hidden"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              // Half speed: the 15s loop breathes for 30.
              event.currentTarget.playbackRate = 0.5;
            }}
            poster="/brand/ink/hero-ink.png"
            aria-label="A lone figure before towering server racks in a vast machine hall, printed in red ink on black, gently animated"
          >
            <source src="/brand/ink/hero-ink.mp4" type="video/mp4" />
          </video>
          <Image
            src="/brand/ink/hero-ink.png"
            alt=""
            aria-hidden
            fill
            priority
            sizes="100vw"
            className="pointer-events-none hidden object-cover motion-reduce:block"
          />
        </div>
        {/* Registration marks: the corners of the press bed. */}
        <RegistrationMarks />

        <div className="relative z-10 mx-auto flex min-h-[90svh] w-full max-w-[1440px] flex-col items-start justify-start px-5 pt-4 pb-20 sm:px-8 sm:pt-6 sm:pb-24">
          <h1
            className={cn(
              poster.className,
              "max-w-[13ch] text-[clamp(32px,4.3vw,63px)] leading-[1.08] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            A daemon on every host <em className="text-hellfire not-italic">you&nbsp;own.</em>
          </h1>

          <div className="mt-auto flex w-full flex-col items-stretch gap-5 pt-16 sm:w-auto sm:items-start">
            {/* One panel, one answer to "what do I run on this machine": the
             * line to paste, and the downloads, inside a single border that
             * closes around both. The hero is full-bleed ink, and a control set
             * straight on it falls into the print — so the panel is the ground
             * everything here stands on, and the slab is the only thing that
             * brings its own.
             *
             * A phone cannot host the daemon, so the shell line is left out
             * there and the store badge is the whole answer. */}
            <div className="inline-flex max-w-full flex-col items-start">
              {phoneBadge ? null : (
                // The seam between the two sections is a divider, not an edge:
                // a short grey rule set in from both sides, laid over the white
                // outline that runs unbroken around the panel behind it.
                <div
                  ref={commandRef}
                  className={cn(
                    "relative z-10 max-w-full after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-line-strong after:content-['']",
                    !stepped && "w-full",
                  )}
                >
                  {/* The outer corner where this line meets the wider row
                   * below. A 270° turn cannot be rounded by rounding a box —
                   * that cuts the corner away rather than filling it — so the
                   * fillet is drawn: a quarter of the row's own ground laid
                   * into the crook, clipped to its own square, with the white
                   * edge running round the arc. */}
                  {stepped ? (
                    <span
                      aria-hidden
                      // Pulled a pixel left so its own left edge lands exactly
                      // on this section's right one: side by side they drew
                      // that edge twice, and the doubled line read as a white
                      // seam running down into the corner.
                      className="pointer-events-none absolute bottom-0 left-full -ml-px size-[14px] overflow-hidden"
                    >
                      <span className="block size-full rounded-bl-[14px] border-b border-l border-bone shadow-[-14px_14px_0_14px_rgb(18_15_14_/_0.9)]" />
                    </span>
                  ) : null}
                  <InstallCommand
                    targets={targets}
                    defaultTargetId={defaultTargetId}
                    onTargetChange={setChosenTarget}
                    className={cn(!stepped && "w-full")}
                    boxClassName={cn(
                      // Opaque, and with no bottom edge of its own: the white
                      // outline belongs to the panel, and this section's own
                      // ground is what hides the length of it running beneath.
                      "rounded-b-none border-bone border-b-0 bg-void",
                      !stepped && "w-full",
                    )}
                  />
                </div>
              )}
              {/* The row runs wider than the line above it, and the outline
               * follows rather than boxing both into the widest rectangle: one
               * shape that steps out where the buttons need the room, with the
               * shared edge left drawn as the rule between them.
               *
               * It wraps as a row before either label wraps inside its own
               * button — two words on two lines inside a slab reads as damage,
               * where a stacked pair of buttons reads as a narrow window. */}
              <div
                ref={actionsRef}
                className={cn(
                  // The white edge runs unbroken around the whole shape,
                  // including the length of this section's top that juts out
                  // past the line above — and it always fills the panel, so
                  // that line can never be the wider of the two and the step
                  // only ever turns one way.
                  // The actions wrap only when they genuinely do not fit, and
                  // whichever of them ends up alone on a line fills it: a
                  // breakpoint instead put them in a column while there was
                  // still room for both, which is neither of the two states
                  // this panel has.
                  "-mt-px flex w-full max-w-full flex-wrap items-center gap-3 rounded-[16px] rounded-t-none border border-bone bg-char/90 p-4 backdrop-blur-sm",
                  stepped && "rounded-tr-[16px]",
                )}
              >
                {phoneBadge ? (
                  // The vendors' own artwork, as supplied: an App Store or Play
                  // badge is the download button on those platforms, and neither
                  // may be redrawn in someone else's house style.
                  <StoreBadges badges={[phoneBadge]} />
                ) : windowsChosen ? (
                  // No Windows build to hand over — the line above runs inside
                  // WSL — so the button goes where that is explained.
                  <MacDownloadButton
                    href={null}
                    platform="windows"
                    className="h-14 grow rounded-[11px] whitespace-nowrap"
                  />
                ) : detectedOS === "linux" ? (
                  <Link
                    href="/download"
                    className={cn(CTA_SLAB, "h-14 grow rounded-[11px] whitespace-nowrap")}
                  >
                    Download
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <MacDownloadButton
                    href={macBuildUrl}
                    version={macBuildVersion}
                    buildId={macBuildId}
                    pending={!releaseSettled}
                    className="h-14 grow rounded-[11px] whitespace-nowrap"
                  />
                )}
                <Link
                  href="/download"
                  className={cn(
                    CTA_GHOST,
                    // A ground of its own, faint but always there: beside a
                    // bone slab, a shape painted only on hover reads as the
                    // smaller of the two even when the boxes match to the
                    // pixel.
                    "h-14 grow rounded-[11px] bg-bone/[0.06] whitespace-nowrap hover:bg-bone/12",
                  )}
                >
                  More download options
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Plate II: the rite, black ink on red ───────────────── */}
      <section className="relative overflow-hidden bg-plate text-void">
        <ScrollStamp />
        <div className="relative mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <p className="mb-14 font-sigil text-[12px] font-medium tracking-[0.3em] uppercase">
            The rite · how it works
          </p>
          <div className="grid min-w-0 gap-y-14 md:grid-cols-3 md:gap-x-12 md:gap-y-0">
            <Rite title="One daemon per host.">
              Installs with a line. It dials out, no inbound ports, no SSH, no tailnet, and
              registers the host as yours.
            </Rite>
            <Rite title="Summon agents into it.">
              Anything that runs in a PTY. Each agent runs on your hardware, on the subscriptions
              you already pay for. We never hold your keys.
            </Rite>
            <Rite title="Reach them from anywhere.">
              The real terminal, in any browser, down to the one in your pocket. A second device can
              take the session mid-keystroke.
            </Rite>
          </div>
        </div>
      </section>

      {/* ── The gallery: proofs on paper ───────────────────────── */}
      <section className="border-t-4 border-hellfire bg-bone text-void">
        <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <h2
                className={cn(
                  poster.className,
                  "max-w-[20ch] text-[clamp(32px,4.8vw,60px)] leading-[0.98] font-light uppercase",
                )}
              >
                The same terminal, anywhere you stand.
              </h2>
            </div>
          </div>

          <div className="mt-16 grid min-w-0 gap-14 sm:grid-cols-2 sm:gap-x-10 lg:gap-x-16">
            <Drift speed={26} className="flex flex-col gap-14 sm:gap-20">
              <PaperPlate
                src="/brand/ink/pocket-ink.png"
                video="/brand/ink/pocket-ink.mp4"
                width={1122}
                height={1402}
                rotate="-rotate-1"
                label="№ 1 · The pocket terminal"
                alt="A hand holding a phone running a live terminal, printed in red ink on black"
              >
                Every session is a live PTY on your host, rendered faithfully in the browser in your
                pocket, not a read-only viewer.
              </PaperPlate>
              <PaperPlate
                src="/brand/ink/grid-ink.png"
                video="/brand/ink/grid-ink.mp4"
                width={1448}
                height={1086}
                rotate="rotate-[0.6deg]"
                label="№ 3 · The workspace"
                alt="A wall of terminal windows in a tidy grid, one brighter than the rest, printed in red ink on black"
              >
                A workspace is a named grid of terminal windows rooted in one folder on a host, with
                shells, agents, and file explorers side by side.
              </PaperPlate>
            </Drift>
            <Drift speed={-26} className="flex flex-col gap-14 sm:mt-24 sm:gap-20">
              <PaperPlate
                src="/brand/ink/hosts-ink.png"
                video="/brand/ink/hosts-ink.mp4"
                width={1448}
                height={1086}
                rotate="rotate-[0.75deg]"
                label="№ 2 · The dial-out"
                alt="Three monolithic hosts dialing out to a single point, printed in red ink on black"
              >
                Every daemon dials out to one master: no inbound ports, no SSH, no tailnet. Revoke a
                host and the socket dies.
              </PaperPlate>
              <PaperPlate
                src="/brand/ink/handoff-ink.png"
                video="/brand/ink/handoff-ink.mp4"
                width={1536}
                height={1024}
                rotate="-rotate-[0.5deg]"
                label="№ 4 · The handoff"
                alt="A laptop terminal and a phone showing the same session, joined by a thread of light, printed in red ink on black"
              >
                Walk away mid-command and pick the same session up on another device. It follows you{" "}
                <em className="not-italic underline decoration-hellfire decoration-2 underline-offset-4">
                  mid-keystroke
                </em>
                .
              </PaperPlate>
            </Drift>
          </div>
        </div>
      </section>

      {/* ── It answers only to you ─────────────────────────────── */}
      <section className="relative overflow-hidden border-line-g border-b">
        <div className="relative mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <div className="grid min-w-0 gap-14 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
            <div>
              <h2
                className={cn(
                  poster.className,
                  "max-w-[17ch] text-[clamp(28px,3.7vw,48px)] leading-[1.04] font-light text-bone uppercase",
                )}
              >
                The server can't read your terminal.
              </h2>
              <p className="mt-6 max-w-[52ch] text-[17px] leading-8 text-ash">
                Terminal bytes travel browser-to-daemon, end-to-end encrypted; a forced relay
                carries ciphertext it can't read. The daemon dials out, so there are no inbound
                ports, no SSH, no tailnet. The threat model names our own servers as the adversary,
                because you should treat them as one.
              </p>
              <Link
                href="/security"
                className="mt-8 inline-block font-sigil text-[12px] tracking-[0.18em] text-ash uppercase underline decoration-line-strong underline-offset-8 transition-colors hover:text-bone hover:decoration-ember"
              >
                Read the threat model
              </Link>
            </div>
            <Drift speed={28} className="min-w-0">
              <figure className="min-w-0 border border-line-strong bg-char">
                <figcaption className="flex items-center justify-between gap-4 border-line-g border-b px-5 py-3.5 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
                  <span>The server's entire view</span>
                  <span aria-hidden className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-hellfire" />
                    <span className="size-2 rounded-full bg-blood" />
                    <span className="size-2 rounded-full bg-line-strong" />
                  </span>
                </figcaption>
                <div className="min-w-0 space-y-2.5 overflow-x-auto px-5 py-6 font-sigil text-[12px] leading-6 text-bone sm:px-6 sm:text-[13px]">
                  <p className="whitespace-nowrap">
                    <span className="text-ember">$</span> spawnd relay --attach 8f31c2
                  </p>
                  <ServerViewRow label="signal">
                    browser ⇄ daemon · <span className="text-bone">introduced</span>
                  </ServerViewRow>
                  <ServerViewRow label="terminal">
                    <Redacted /> ciphertext only
                  </ServerViewRow>
                  <ServerViewRow label="plaintext">never arrives</ServerViewRow>
                  <ServerViewRow label="transcript">none kept</ServerViewRow>
                  <ServerViewRow label="keys">none held, agents use their own logins</ServerViewRow>
                  <p className="whitespace-nowrap pt-3">
                    <span className="text-ember">$</span> spawnd revoke host-07
                  </p>
                  <p className="whitespace-nowrap text-hellfire">
                    socket closed. it answers to no one now.
                  </p>
                </div>
              </figure>
            </Drift>
          </div>
          <Drift speed={16}>
            <p
              className={cn(
                poster.className,
                "mx-auto mt-24 max-w-[34ch] text-center text-[clamp(24px,3.7vw,41px)] leading-[1.25] text-bone italic",
              )}
            >
              A daemon that dials out and answers to one master sounds ominous, until you notice
              <span className="text-hellfire"> the master is you.</span>
            </p>
          </Drift>
        </div>
      </section>

      {/* ── Specimen strip: scrubbed by the scroll itself ──────── */}
      {/* ── The pocket plate: the app is part of the offer ────── */}
      {/* The altar print runs full-bleed behind the plate and breathes, like the
       * hero — knocked back to 80% against the black ground rather than sat
       * under a scrim, since the copy has its own black slab anyway. Square
       * corners, and the slab hugs its contents rather than ruling a column:
       * a card pressed onto the sheet, not a panel floating above it. */}
      <section className="border-line-g relative isolate overflow-hidden border-b">
        <div className="absolute inset-0 opacity-80">
          <video
            className="pointer-events-none absolute inset-0 h-full w-full object-cover object-[50%_45%] motion-reduce:hidden"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              // Half speed, as the hero runs: the 13s loop breathes for 26.
              event.currentTarget.playbackRate = 0.5;
            }}
            poster="/brand/ink/altar-ink.png"
            aria-label="A lone figure before two towering monoliths on a flat plain, printed in red ink on black, gently animated"
          >
            <source src="/brand/ink/altar-ink.mp4" type="video/mp4" />
          </video>
          <Image
            src="/brand/ink/altar-ink.png"
            alt=""
            aria-hidden
            fill
            sizes="100vw"
            className="pointer-events-none hidden object-cover object-[50%_45%] motion-reduce:block"
          />
        </div>
        <div className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
          <div className="w-fit max-w-full bg-void px-6 py-10 sm:px-10 sm:py-12">
            <p className="mb-5 font-sigil text-[12px] font-medium tracking-[0.3em] text-ash uppercase">
              The reliquary · carried
            </p>
            <h2
              className={cn(
                poster.className,
                "max-w-[19ch] text-[clamp(28px,3.7vw,48px)] leading-[1.04] font-light text-bone uppercase",
              )}
            >
              Every possession, in your pocket.
            </h2>
            <p className="mt-6 max-w-[56ch] text-[17px] leading-8 text-ash">
              The app is the same seance as the browser, not a summary of it. Start a session at the
              desk and pick it up on the train; approve a host, watch an agent work, end it from the
              platform. The daemon never leaves your machine — the phone is only a window onto it.
            </p>
            <StoreBadges badges={storeBadges()} className="mt-9" />
          </div>
        </div>
      </section>

      <section className="border-line-g border-b py-12">
        <ScrubMarquee />
        <p className="mx-auto mt-8 max-w-[64ch] px-5 text-center font-sigil text-[13px] leading-6 tracking-[0.04em] text-ash sm:px-8">
          Agents are shortcuts, not lock-in: a named command typed into a real shell on your host.
          If it runs in a terminal, it runs here, under its own login, on your machine.
        </p>
      </section>

      {/* ── The closing poster ─────────────────────────────────── */}
      <section className="relative isolate overflow-hidden">
        <Image
          src="/brand/ink/altar-ink.png"
          alt=""
          aria-hidden
          fill
          sizes="100vw"
          className="pointer-events-none object-cover object-[50%_38%]"
        />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,.98) 0%, rgba(0,0,0,.9) 34%, rgba(0,0,0,.62) 62%, rgba(0,0,0,.82) 100%)",
          }}
        />
        <div className="relative z-10 mx-auto w-full max-w-3xl px-5 pt-32 pb-20 text-center sm:px-8">
          <h2
            className={cn(
              poster.className,
              "mb-5 text-[clamp(40px,7.5vw,92px)] leading-[0.98] font-light text-bone uppercase",
            )}
          >
            Bring a host online.
          </h2>
          <p className="mx-auto mb-9 max-w-[48ch] text-[clamp(17px,2vw,21px)] leading-[1.6] text-ash">
            One line installs the daemon; you approve it against a fingerprint you can see. From
            then on, it answers only to you.
          </p>
          {phoneBadge ? (
            <StoreBadges badges={[phoneBadge]} className="mb-9 justify-center" />
          ) : (
            <InstallCommand targets={targets} defaultTargetId={defaultTargetId} className="mb-9" />
          )}
          <div className="flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-7">
            <Link href="/signup" className={CTA_SLAB}>
              Sign up
            </Link>
            <Link href="/download" className={CTA_QUIET}>
              Download
            </Link>
          </div>
        </div>

        {/* The brand poster: the drawn wordmark at full plate width, rising
         * out of the fold as the page bottoms out — and sinking back. */}
        <Drift speed={-56} className="relative z-10 px-2 pt-16 sm:px-3">
          <Wordmark aria-hidden className="block w-full text-hellfire" />
        </Drift>
      </section>

      {/* ── Colophon ───────────────────────────────────────────── */}
      <Colophon />
    </main>
  );
}

function Rite({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t-2 border-void pt-6">
      <h3 className={cn(poster.className, "mb-3 text-[26px] leading-[1.08] font-light uppercase")}>
        {title}
      </h3>
      <p className="max-w-[44ch] text-[16px] leading-7">{children}</p>
    </div>
  );
}

function PaperPlate({
  src,
  video,
  width,
  height,
  rotate,
  label,
  alt,
  children,
}: {
  src: string;
  video: string;
  width: number;
  height: number;
  rotate: string;
  label: string;
  alt: string;
  children: ReactNode;
}) {
  return (
    <figure>
      {/* A living print. Hover presses it down into its own shadow. */}
      <div
        className={cn(
          "border border-void/25 bg-void",
          "ease-swift transition-transform duration-200 hover:translate-y-[4px]",
          rotate,
        )}
      >
        <div
          className="relative w-full overflow-hidden"
          style={{ aspectRatio: `${width} / ${height}` }}
        >
          <ScrubVideo src={video} poster={src} alt={alt} />
        </div>
      </div>
      <figcaption className="mt-7">
        <span className="font-sigil text-[12px] font-medium tracking-[0.22em] text-blood uppercase">
          {label}
        </span>
        <p className="mt-3 max-w-[46ch] text-[15px] leading-7 text-void/80">{children}</p>
      </figcaption>
    </figure>
  );
}

function ServerViewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex gap-4 whitespace-nowrap">
      <span className="w-20 shrink-0 text-ash/70 sm:w-24">{label}</span>
      <span className="text-ash">{children}</span>
    </p>
  );
}

function Redacted() {
  return (
    <>
      <span
        aria-hidden
        className="inline-block h-[0.8em] w-36 translate-y-[0.08em] bg-hellfire/90"
      />
      <span className="sr-only">redacted</span>{" "}
    </>
  );
}
