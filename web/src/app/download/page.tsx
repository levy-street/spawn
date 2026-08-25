"use client";

import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Laptop,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Colophon,
  CTA_QUIET,
  CTA_SLAB,
  Eyebrow,
  Masthead,
  RegistrationMarks,
} from "@/components/brand/press";
import { poster } from "@/lib/fonts";
import {
  type DesktopRelease,
  desktopDownloadUrl,
  desktopReleaseFromPayload,
  detectPlatform,
  type PlatformOS,
  UNDETECTED_PLATFORM,
} from "@/lib/platform";
import { cn } from "@/lib/utils";

const PLATFORM_COPY: Record<
  PlatformOS,
  {
    label: string;
    title: string;
    recommendation: string;
    service: string;
    status: "supported" | "unsupported" | "unknown";
  }
> = {
  macos: {
    label: "macOS",
    title: "Install on this Mac",
    recommendation:
      "Run the installer in Terminal. It downloads the macOS daemon build and starts a LaunchAgent after login.",
    service: "LaunchAgent: app.spawn.spawnd",
    status: "supported",
  },
  linux: {
    label: "Linux",
    title: "Install on this Linux host",
    recommendation:
      "Run the installer in a shell on the Linux machine. It downloads the Linux daemon build and starts a user systemd service when available.",
    service: "systemd user service: spawnd.service",
    status: "supported",
  },
  windows: {
    label: "Windows",
    title: "Use a macOS or Linux host",
    recommendation:
      "The daemon does not ship a Windows build yet. Install SPAWN D from a Mac, Linux workstation, or Linux server.",
    service: "Windows service support is not available yet.",
    status: "unsupported",
  },
  unknown: {
    label: "Unknown OS",
    title: "Run from a host terminal",
    recommendation:
      "The browser could not identify this OS. The installer supports macOS and Linux, and will detect the actual host when it runs.",
    service: "macOS LaunchAgent or Linux user systemd, depending on the host.",
    status: "unknown",
  },
};

const OPTIONS = [
  {
    title: "macOS",
    body: "Downloads a Darwin build for Apple Silicon or Intel, then starts a LaunchAgent.",
  },
  {
    title: "Linux",
    body: "Downloads an x86_64 or arm64 Linux build, then starts user systemd when available.",
  },
  {
    title: "Remote hosts",
    body: "SSH into the machine that should run agents, then run the same command there.",
  },
];

export default function DownloadPage() {
  const [platform, setPlatform] = useState(UNDETECTED_PLATFORM);
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(false);
  const [desktopRelease, setDesktopRelease] = useState<DesktopRelease | null>(null);

  useEffect(() => {
    setPlatform(detectPlatform());
    setCanCopy(Boolean(navigator.clipboard));
    const controller = new AbortController();
    void fetch("/api/release", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => setDesktopRelease(desktopReleaseFromPayload(payload)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const command = platform.installCommand;
  const prebuiltCommand = platform.prebuiltInstallCommand;
  const detected = PLATFORM_COPY[platform.os];
  const supported = detected.status === "supported";

  const copyCommand = async () => {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  // The one dot of colour on the detected plate: the brand ink says "good",
  // hellfire says "not here", ash says "we couldn't tell".
  const statusIcon = useMemo(() => {
    if (supported) return <CheckCircle2 className="size-4 text-ember" aria-hidden />;
    if (detected.status === "unsupported")
      return <AlertTriangle className="size-4 text-hellfire" aria-hidden />;
    return <Laptop className="size-4 text-ash" aria-hidden />;
  }, [detected.status, supported]);

  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <Masthead current="download" />

      {desktopRelease && (
        <section className="relative isolate overflow-hidden border-line-g border-b bg-bone text-void">
          <div
            aria-hidden
            className="absolute -top-28 right-[4%] size-[32rem] rotate-[9deg] opacity-[0.07]"
          >
            {/* biome-ignore lint/performance/noImgElement: decorative brand stamp */}
            <img src="/brand/spawnd-icon-black.svg" alt="" className="size-full" />
          </div>
          <div className="relative mx-auto grid w-full max-w-6xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1fr_auto] lg:items-end lg:py-20">
            <div>
              <p className="mb-5 font-sigil text-[11px] font-medium tracking-[0.28em] uppercase">
                Native macOS companion
              </p>
              <h1
                className={cn(
                  poster.className,
                  "max-w-[15ch] text-[clamp(38px,6vw,68px)] leading-[0.96] font-light uppercase",
                )}
              >
                Get SPAWN D for Mac
              </h1>
              <p className="mt-6 max-w-[56ch] text-[16px] leading-7">
                A tray-first, signed app that verifies the daemon, possesses this Mac, and then gets
                out of the way.
              </p>
              <p className="mt-5 font-sigil text-[11px] tracking-[0.18em] uppercase">
                Version {desktopRelease.version} · SHA {desktopRelease.tree.slice(0, 12)}
              </p>
            </div>
            <div className="flex min-w-[15rem] flex-col gap-3">
              {desktopRelease.platforms.includes("darwin-aarch64") && (
                <a
                  className={cn(CTA_SLAB, "justify-between border-void bg-void text-bone")}
                  href={desktopDownloadUrl(
                    platform.origin,
                    desktopRelease.version,
                    "darwin-aarch64",
                  )}
                >
                  Apple silicon
                  <Download className="size-4" aria-hidden />
                </a>
              )}
              {desktopRelease.platforms.includes("darwin-x86_64") && (
                <a
                  className="flex items-center justify-between border border-void px-5 py-3 font-sigil text-[12px] tracking-[0.12em] uppercase transition-colors hover:bg-void hover:text-bone"
                  href={desktopDownloadUrl(
                    platform.origin,
                    desktopRelease.version,
                    "darwin-x86_64",
                  )}
                >
                  Intel Mac
                  <Download className="size-4" aria-hidden />
                </a>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── The hero: the dial-out plate, type ranged left ─────── */}
      <section className="relative isolate overflow-hidden border-line-g border-b">
        <Image
          src="/brand/ink/hosts-ink.png"
          alt=""
          aria-hidden
          fill
          priority
          sizes="100vw"
          className="pointer-events-none object-cover object-[50%_45%]"
        />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,.94) 0%, rgba(0,0,0,.86) 40%, rgba(0,0,0,.9) 100%)",
          }}
        />
        <RegistrationMarks />

        <div className="relative z-10 mx-auto w-full max-w-6xl min-w-0 px-5 py-24 sm:px-8">
          <div className="grid min-w-0 gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              <Eyebrow className="mb-5">{desktopRelease ? "Servers and Linux" : "Install"}</Eyebrow>
              <h1
                className={cn(
                  poster.className,
                  "text-[clamp(35px,5.6vw,63px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
                )}
              >
                {desktopRelease ? (
                  <>
                    Possess any machine.{" "}
                    <em className="text-hellfire not-italic">From its terminal.</em>
                  </>
                ) : (
                  <>
                    Install the daemon.{" "}
                    <em className="text-hellfire not-italic">Possess the host.</em>
                  </>
                )}
              </h1>
              <p className="mt-6 max-w-[54ch] text-[17px] leading-8 text-ash">
                {desktopRelease
                  ? "Use the one-line installer for a Linux server, a remote host, or a Mac where you do not want the companion app. It downloads the matching daemon and starts the user service."
                  : "The installer detects macOS or Linux on the machine where it runs, downloads the matching prebuilt daemon, then starts it as a user service. One line, then the pairing ceremony — consensual, auditable, revocable."}
              </p>
            </div>

            {/* The detected plate, set like the lander's "server's entire view". */}
            <figure className="min-w-0 border border-line-strong bg-char">
              <figcaption className="flex items-center justify-between gap-4 border-line-g border-b px-5 py-3.5 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
                <span>Detected browser OS</span>
                <span aria-hidden className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-hellfire" />
                  <span className="size-2 rounded-full bg-blood" />
                  <span className="size-2 rounded-full bg-line-strong" />
                </span>
              </figcaption>
              <div className="min-w-0 px-5 py-6 sm:px-6">
                <div className="flex items-center gap-3">
                  {statusIcon}
                  <h2
                    className={cn(
                      poster.className,
                      "text-[28px] leading-none font-light text-bone uppercase",
                    )}
                  >
                    {detected.label}
                  </h2>
                </div>
                <p className="mt-4 text-[15px] leading-7 text-ash">{detected.recommendation}</p>
                <p className="mt-5 border-line-g border-t pt-4 font-sigil text-[12px] leading-6 text-ash">
                  {detected.service}
                </p>
              </div>
            </figure>
          </div>

          {/* The line itself, and the two doors out of the hero — the lander
           * hangs its install chip and CTA off the foot of the hero the same
           * way, so the fold always ends on something you can act on. */}
          <div className="mt-16 min-w-0 border-line-g border-t pt-10">
            <p className="mb-5 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
              Or possess any machine from its terminal: {detected.title}
            </p>
            <div className="flex max-w-full min-w-0 items-center gap-3 rounded-sm border border-bone bg-void py-4 pr-3 pl-4 font-sigil text-[13px] text-bone">
              <span className="text-ember">$</span>
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
            </div>
            <p className="mt-2 max-w-[65ch] text-xs leading-5 text-ash">
              Already running SPAWN D for another account on that machine? Add{" "}
              <code>--new-account</code>.
            </p>

            <div className="mt-8 flex flex-col items-stretch gap-5 sm:flex-row sm:items-center sm:gap-7">
              <button type="button" onClick={copyCommand} disabled={!canCopy} className={CTA_SLAB}>
                {copied ? (
                  <Check className="size-4" aria-hidden />
                ) : (
                  <Copy className="size-4" aria-hidden />
                )}
                {copied ? "Copied" : "Copy command"}
              </button>
              <Link href="/signup" className={CTA_QUIET}>
                Create account
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>

            {!supported && (
              <p className="mt-8 flex items-start gap-3 border-hellfire border-l-2 bg-char py-4 pr-5 pl-5 text-[15px] leading-7 text-bone">
                <AlertTriangle className="mt-1 size-4 shrink-0 text-hellfire" aria-hidden />
                <span>
                  Use this command from a supported macOS or Linux terminal, not from this browser
                  OS.
                </span>
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── Plate II: where it can run, black ink on red ───────── */}
      <section className="relative overflow-hidden bg-plate text-void">
        {/* Small, faint, and clear of the columns: at 20% the stamp darkened the
         * ground beneath it, and black body copy over dimmed red stopped
         * reading — the third column took the worst of it. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-20 -right-20 size-[16rem] rotate-[4deg] opacity-[0.10] sm:size-[22rem]"
        >
          {/* biome-ignore lint/performance/noImgElement: decorative stamp, no optimization needed */}
          <img src="/brand/spawnd-icon-black.svg" alt="" className="size-full" />
        </div>
        <div className="relative mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <p className="mb-14 font-sigil text-[12px] font-medium tracking-[0.3em] uppercase">
            Where it can run
          </p>
          <div className="grid min-w-0 gap-y-14 md:grid-cols-3 md:gap-x-12 md:gap-y-0">
            {OPTIONS.map((option) => (
              <div key={option.title} className="border-t-2 border-void pt-6">
                <h3
                  className={cn(
                    poster.className,
                    "mb-3 text-[26px] leading-[1.08] font-light uppercase",
                  )}
                >
                  {option.title}
                </h3>
                <p className="max-w-[44ch] text-[16px] leading-7">{option.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── The smoke test ─────────────────────────────────────── */}
      <section className="px-5 py-24 sm:px-8">
        <div className="mx-auto grid w-full max-w-6xl min-w-0 gap-10 md:grid-cols-2 md:items-center">
          <div>
            <Eyebrow className="mb-5">Prebuilt-only smoke test</Eyebrow>
            <h2
              className={cn(
                poster.className,
                "mb-4 max-w-[18ch] text-[clamp(26px,3.5vw,39px)] leading-[1.04] font-light text-bone uppercase",
              )}
            >
              Prove the hosted binary path.
            </h2>
            <p className="max-w-[50ch] text-[16px] leading-7 text-ash">
              Use this when you want to prove the hosted binary path works and fail instead of
              building from source.
            </p>
          </div>
          <div className="flex max-w-full min-w-0 items-center gap-3 rounded-sm border border-line-strong bg-char py-4 pr-3 pl-4 font-sigil text-[13px] text-bone">
            <span className="text-ember">$</span>
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
              {prebuiltCommand}
            </code>
          </div>
        </div>
      </section>

      <Colophon />
    </main>
  );
}
