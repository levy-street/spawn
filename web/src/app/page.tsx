"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, Plus, Server } from "lucide-react";
import { Bodoni_Moda } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
import { cn } from "@/lib/utils";

/*
 * The landing's poster face: a high-contrast didone for display type only.
 * next/font inlines it at build time — no runtime font request — and the app
 * chrome never sees it; body copy stays on the grimoire serif.
 */
const poster = Bodoni_Moda({ subsets: ["latin"], style: ["normal", "italic"], display: "swap" });

import { AppShell } from "@/components/nav/AppShell";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { NewWorkspaceMenu } from "@/components/workspace/new-workspace-menu";
import { hosts, workspaces } from "@/lib/api";
import { useAuth, useAuthConfig } from "@/lib/auth";

export default function HomePage() {
  const router = useRouter();
  const { user, loading: authLoading, error: authError } = useAuth();
  const { config, loading: configLoading, error: configError } = useAuthConfig();
  const [skippedHost, setSkippedHost] = useState<boolean | null>(null);
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    enabled: Boolean(user),
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaces.list,
    enabled: Boolean(user),
  });

  useEffect(() => {
    if (!user) {
      setSkippedHost(null);
      return;
    }
    setSkippedHost(window.localStorage.getItem("spawn.onboarding.skippedHost") === "true");
  }, [user]);

  const listedHosts = useMemo(() => hostsQ.data ?? [], [hostsQ.data]);
  const orderedWorkspaces = useMemo(
    () => [...(workspacesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [workspacesQ.data],
  );
  const firstOnlineHost = listedHosts.find((host) => host.status === "online");
  const verificationIncomplete = Boolean(
    user && config?.email_verification_required && !user.email_verified_at,
  );

  useEffect(() => {
    if (
      !user ||
      !config ||
      skippedHost === null ||
      hostsQ.isLoading ||
      workspacesQ.isLoading ||
      hostsQ.error ||
      workspacesQ.error
    ) {
      return;
    }
    if (config.email_verification_required && !user.email_verified_at) {
      router.replace("/onboarding");
      return;
    }
    if (listedHosts.length === 0) {
      if (!skippedHost) router.replace("/onboarding?step=host");
      return;
    }
    if (orderedWorkspaces.length > 0) {
      const savedId = window.localStorage.getItem("spawn.workspaces.last");
      const target =
        orderedWorkspaces.find((workspace) => workspace.id === savedId) ?? orderedWorkspaces[0];
      if (target) {
        window.localStorage.setItem("spawn.workspaces.last", target.id);
        router.replace(`/w/${target.id}`);
      }
      return;
    }
  }, [
    config,
    hostsQ.error,
    hostsQ.isLoading,
    listedHosts,
    orderedWorkspaces,
    router,
    skippedHost,
    user,
    workspacesQ.error,
    workspacesQ.isLoading,
  ]);

  if (authLoading) return <HomeSpinner />;
  if (authError) {
    return (
      <EmptyState
        title="Could not check your account"
        body={authError instanceof Error ? authError.message : String(authError)}
      />
    );
  }

  if (!user) return <LandingPage />;

  if (
    configLoading ||
    skippedHost === null ||
    hostsQ.isLoading ||
    workspacesQ.isLoading ||
    verificationIncomplete
  ) {
    return <HomeSpinner />;
  }

  if (configError || hostsQ.error || workspacesQ.error) {
    const error = configError ?? hostsQ.error ?? workspacesQ.error;
    return (
      <EmptyState
        title="Could not load your workspace"
        body={error instanceof Error ? error.message : String(error)}
        action={
          <Button
            onClick={() => {
              void hostsQ.refetch();
              void workspacesQ.refetch();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  if (listedHosts.length === 0 && skippedHost) {
    return (
      <AppShell>
        <EmptyState
          className="min-h-[calc(var(--vv-height)-3rem)]"
          icon={<Server />}
          title="Connect a host to start a session"
          body="Install the daemon on a machine you control, then approve its pairing code."
          action={<Button onClick={() => openSettings("hosts")}>Connect a host</Button>}
        />
      </AppShell>
    );
  }

  if (listedHosts.length > 0 && orderedWorkspaces.length === 0 && !firstOnlineHost) {
    return (
      <AppShell>
        <EmptyState
          className="min-h-[calc(var(--vv-height)-3rem)]"
          icon={<Server />}
          title="Your host is offline"
          body="Bring a daemon online before creating the first workspace."
          action={<Button onClick={() => openSettings("hosts")}>View hosts</Button>}
        />
      </AppShell>
    );
  }

  if (orderedWorkspaces.length === 0) {
    // No silent auto-create: the first workspace is a deliberate act — pick
    // its folder (or replay a saved template) from the same menu the sidebar
    // button opens.
    return (
      <AppShell>
        <EmptyState
          className="min-h-[calc(var(--vv-height)-3rem)]"
          icon={<Trident className="size-8" />}
          title="Create your first workspace"
          body="A workspace is a grid of terminal panes rooted in one folder on your host. Shells, agents, and file explorers all open there."
          action={
            <NewWorkspaceMenu
              trigger={
                <Button size="lg">
                  <Plus className="size-4" aria-hidden />
                  New workspace
                </Button>
              }
              onCreated={({ workspaceId, focusSessionId }) => {
                window.localStorage.setItem("spawn.workspaces.last", workspaceId);
                router.replace(
                  focusSessionId
                    ? `/w/${workspaceId}?focus=${focusSessionId}`
                    : `/w/${workspaceId}`,
                );
              }}
            />
          }
        />
      </AppShell>
    );
  }

  return <HomeSpinner />;
}

function HomeSpinner() {
  return (
    <div className="flex min-h-vv items-center justify-center">
      <Spinner size={20} label="Opening your workspace" />
    </div>
  );
}

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
      className="pointer-events-none absolute -top-16 -right-16 size-[22rem] rotate-[4deg] opacity-20 will-change-transform sm:size-[30rem]"
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

/** The install one-liner on a paper chip, with a copy button. */
function InstallCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        "flex w-full max-w-full items-center gap-3 rounded-sm border border-bone bg-void py-3.5 pr-3 pl-4 font-sigil text-[13px] text-bone sm:w-auto",
        className,
      )}
    >
      <span className="text-ember">$</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
      <button
        type="button"
        aria-label="Copy install command"
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

const GITHUB_URL = "https://github.com/levy-street/spawn";

/** Collapses the masthead continuously with the scroll: every value is a
 * pure function of scrollY, written straight to the DOM, so there is no
 * threshold to flip back and forth across and no re-render per frame. */
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

function LandingPage() {
  const [origin, setOrigin] = useState("https://spawnd.dev");
  const { navRef, brandRef, markRef, wordRef } = useMastheadScrub();

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const installCommand = `curl -fsSL ${origin}/install.sh | sh`;

  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      {/* ── Nav: three zones, the brand at the centre, pinned ──── */}
      <header className="sticky top-0 z-40 border-line-g border-b bg-void/85 backdrop-blur-md">
        <nav
          ref={navRef}
          className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-4 px-5 py-6 font-sigil text-[11px] tracking-[0.22em] uppercase sm:grid sm:grid-cols-[1fr_auto_1fr] sm:px-8 sm:text-[12px]"
        >
          <div className="hidden items-center gap-7 sm:flex sm:gap-10">
            <Link
              href="/security"
              className="hidden text-ash transition-colors hover:text-bone sm:inline"
            >
              Security
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden text-ash transition-colors hover:text-bone sm:inline"
            >
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
        <span
          aria-hidden
          className="pointer-events-none absolute top-3 left-4 z-10 font-sigil text-[15px] text-hellfire/50 select-none"
        >
          +
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute top-3 right-4 z-10 font-sigil text-[15px] text-hellfire/50 select-none"
        >
          +
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-3 left-4 z-10 font-sigil text-[15px] text-hellfire/50 select-none"
        >
          +
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute right-4 bottom-3 z-10 font-sigil text-[15px] text-hellfire/50 select-none"
        >
          +
        </span>

        <div className="relative z-10 mx-auto flex min-h-[90svh] w-full max-w-[1440px] flex-col items-start justify-start px-5 pt-4 pb-20 sm:px-8 sm:pt-6 sm:pb-24">
          <h1
            className={cn(
              poster.className,
              "max-w-[13ch] text-[clamp(30px,4vw,58px)] leading-[1.08] font-medium text-bone uppercase [text-wrap:balance]",
            )}
          >
            A daemon on every host <em className="text-hellfire not-italic">you&nbsp;own.</em>
          </h1>

          <div className="mt-auto flex w-full flex-col items-stretch gap-4 pt-16 sm:w-auto sm:flex-row sm:items-center">
            <InstallCommand command={installCommand} />
            <Link
              href="/download"
              className="group inline-flex items-center justify-center gap-2 rounded-sm bg-bone px-7 py-[15px] font-sigil text-[13px] font-medium tracking-[0.14em] text-void uppercase transition-colors hover:bg-white"
            >
              Install the daemon
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Plate II: the rite, black ink on red ───────────────── */}
      <section className="relative overflow-hidden bg-hellfire text-void">
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
                  "max-w-[20ch] text-[clamp(30px,4.4vw,56px)] leading-[0.98] font-medium uppercase",
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
                alt="A wall of terminal panes in a tidy grid, one brighter than the rest, printed in red ink on black"
              >
                A workspace is a named grid of terminal panes rooted in one folder on a host, with
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
                  "max-w-[17ch] text-[clamp(26px,3.4vw,44px)] leading-[1.04] font-medium text-bone uppercase",
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
                "mx-auto mt-24 max-w-[34ch] text-center text-[clamp(22px,3.4vw,38px)] leading-[1.25] text-bone italic",
              )}
            >
              A daemon that dials out and answers to one master sounds ominous, until you notice
              <span className="text-hellfire"> the master is you.</span>
            </p>
          </Drift>
        </div>
      </section>

      {/* ── Specimen strip: scrubbed by the scroll itself ──────── */}
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
              "mb-5 text-[clamp(34px,5.2vw,64px)] leading-[0.98] font-medium text-bone uppercase",
            )}
          >
            Bring a host online.
          </h2>
          <p className="mx-auto mb-9 max-w-[48ch] text-[17px] leading-8 text-ash">
            One line installs the daemon; you approve it against a fingerprint you can see. From
            then on, it answers only to you.
          </p>
          <InstallCommand command={installCommand} className="mb-9" />
          <div className="flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-7">
            <Link
              href="/signup"
              className="group inline-flex items-center justify-center gap-2 rounded-sm bg-hellfire px-7 py-4 font-sigil text-[13px] tracking-[0.14em] text-void uppercase transition-colors hover:bg-ember"
            >
              Sign up
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/download"
              className="font-sigil text-[12px] tracking-[0.18em] text-bone uppercase underline decoration-ember/70 underline-offset-8 transition-colors hover:text-ember hover:decoration-ember"
            >
              Install the daemon
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
    </main>
  );
}

function Rite({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t-2 border-void pt-6">
      <h3 className={cn(poster.className, "mb-3 text-[24px] leading-[1.08] font-medium uppercase")}>
        {title}
      </h3>
      <p className="max-w-[44ch] text-[15px] leading-7">{children}</p>
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
