"use client";

import { AlertTriangle, ArrowRight, CheckCircle2, Laptop, Smartphone } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Colophon,
  CTA_SLAB,
  Eyebrow,
  InstallCommand,
  MacDownloadButton,
  Masthead,
  RegistrationMarks,
  StoreBadgeMark,
} from "@/components/brand/press";
import { useDesktopRelease } from "@/hooks/useDesktopRelease";
import { poster } from "@/lib/fonts";
import {
  desktopDownloadUrl,
  detectPlatform,
  installTargetForOS,
  installTargets,
  type PlatformOS,
  storeBadges,
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
    status: "supported" | "wsl" | "mobile" | "unsupported" | "unknown";
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
    title: "Install through WSL",
    recommendation:
      "There is no native Windows daemon yet. The Windows line runs the Linux build inside WSL2 — install WSL and a distribution, and the installer takes it from there.",
    service: "Linux user systemd inside WSL, where the distribution provides it.",
    status: "wsl",
  },
  ios: {
    label: "iPhone or iPad",
    title: "Get the app, possess a computer",
    recommendation:
      "The daemon runs on a Mac, Linux, or Windows machine — never on the phone. Get the app here, then run the installer on the computer you want to possess.",
    service: "The daemon lives on that computer; the app drives it from here.",
    status: "mobile",
  },
  android: {
    label: "Android",
    title: "Get the app, possess a computer",
    recommendation:
      "The daemon runs on a Mac, Linux, or Windows machine — never on the phone. Get the app here, then run the installer on the computer you want to possess.",
    service: "The daemon lives on that computer; the app drives it from here.",
    status: "mobile",
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

const PLATFORM_CARDS = [
  {
    id: "mac",
    platform: "Desktop · macOS",
    body: "Tray-first and signed. It verifies the daemon, possesses this Mac, then gets out of the way.",
  },
  {
    id: "ios",
    platform: "iPhone and iPad",
    body: "The same seance as the browser, not a summary of it. Approve a host, watch an agent work, end a session.",
  },
  {
    id: "android",
    platform: "Android",
    body: "Every possessed host in your pocket, with the terminal live — the daemon stays on your machine.",
  },
] as const;

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
  const {
    release: desktopRelease,
    settled: releaseSettled,
    url: macBuildUrl,
  } = useDesktopRelease(platform.origin);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const prebuiltCommand = platform.prebuiltInstallCommand;
  const detected = PLATFORM_COPY[platform.os];
  const supported = detected.status === "supported";
  const targets = installTargets(platform.origin);
  const defaultTargetId = installTargetForOS(platform.os);

  // The one dot of colour on the detected plate: the brand ink says "good",
  // hellfire says "not here", ash says "we couldn't tell".
  const statusIcon = useMemo(() => {
    if (supported) return <CheckCircle2 className="size-4 text-ember" aria-hidden />;
    if (detected.status === "unsupported")
      return <AlertTriangle className="size-4 text-hellfire" aria-hidden />;
    if (detected.status === "mobile")
      return <Smartphone className="size-4 text-ember" aria-hidden />;
    return <Laptop className="size-4 text-ash" aria-hidden />;
  }, [detected.status, supported]);

  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <Masthead current="download" />

      {/* ── The hero: the things you actually download ───────── */}
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
          <Eyebrow className="mb-5">Download</Eyebrow>
          <h1
            className={cn(
              poster.className,
              "max-w-[16ch] text-[clamp(35px,5.6vw,63px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            Take it with you. <em className="text-hellfire not-italic">Every screen.</em>
          </h1>
          <p className="mt-6 max-w-[58ch] text-[17px] leading-8 text-ash">
            One account, three windows onto the same possessed hosts: the companion in your menu
            bar, the app in your pocket, the browser anywhere. The daemon never leaves your machine
            — these only look in on it.
          </p>

          {/* Three platforms, one row: identical cards on solid ground, with
           * a fixed-height mark well so vendor artwork of different
           * proportions still lines up. The plate behind is busy, so each card
           * brings its own ground rather than floating on it. */}
          <div className="mt-14 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PLATFORM_CARDS.map((card) => {
              const mac = card.id === "mac";
              const href = mac
                ? macBuildUrl
                : (storeBadges().find((badge) => badge.id === card.id)?.href ?? null);
              // The Mac build is named by a manifest that has not answered on
              // the first paint. That is not "coming soon" — the card presses
              // and waits, the way the slab does.
              const waitingOnManifest = mac && !releaseSettled;
              return (
                <div
                  key={card.id}
                  className="flex min-w-0 flex-col rounded-[12px] bg-char px-6 pt-6 pb-5"
                >
                  <div className="flex h-14 items-center">
                    {mac ? (
                      // The same shape the two stores hand out, so the row
                      // reads as three downloads rather than two badges and a
                      // nameplate.
                      <MacDownloadButton
                        href={href}
                        pending={waitingOnManifest}
                        className="h-14 px-6"
                      />
                    ) : (
                      <StoreBadgeMark id={card.id} />
                    )}
                  </div>
                  <p className="mt-6 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
                    {card.platform}
                  </p>
                  <p className="mt-3 flex-1 text-[15px] leading-7 text-ash">{card.body}</p>
                  <p className="mt-6 border-line-g border-t pt-4 font-sigil text-[11px] tracking-[0.22em] uppercase">
                    {href ? (
                      <a
                        href={href}
                        download
                        className="text-bone transition-colors hover:text-ember"
                      >
                        Download
                      </a>
                    ) : waitingOnManifest ? (
                      <span className="text-ash">Checking for a build…</span>
                    ) : (
                      <span className="text-ember">Coming soon</span>
                    )}
                  </p>
                </div>
              );
            })}
          </div>

          {desktopRelease && (
            <p className="mt-6 font-sigil text-[11px] tracking-[0.18em] text-ash uppercase">
              Mac build {desktopRelease.version} · SHA {desktopRelease.tree.slice(0, 12)}
              {desktopRelease.platforms.includes("darwin-x86_64") && (
                <>
                  {" · "}
                  <a
                    href={desktopDownloadUrl(
                      platform.origin,
                      desktopRelease.version,
                      "darwin-x86_64",
                    )}
                    className="text-bone underline decoration-line-strong underline-offset-4 transition-colors hover:text-ember"
                  >
                    Intel Mac
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      </section>

      {/* ── The daemon: what all three windows are looking at ──── */}
      <section className="border-line-g border-b">
        <div className="mx-auto w-full max-w-6xl min-w-0 px-5 py-20 sm:px-8">
          <div className="grid min-w-0 gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
            <div className="min-w-0">
              <Eyebrow className="mb-5">And the daemon itself</Eyebrow>
              <h2
                className={cn(
                  poster.className,
                  "max-w-[18ch] text-[clamp(28px,3.7vw,46px)] leading-[1.04] font-light text-bone uppercase",
                )}
              >
                Possess a machine from its terminal.
              </h2>
              <p className="mt-6 max-w-[54ch] text-[17px] leading-8 text-ash">
                The apps are windows; this is the thing they look at. Run one line on the machine
                you want to possess — never on the phone — and it downloads the matching prebuilt
                daemon, then starts it as a user service. Then the pairing ceremony: consensual,
                auditable, revocable.
              </p>

              <InstallCommand
                targets={targets}
                defaultTargetId={defaultTargetId}
                className="mt-9"
              />

              {detected.status === "unsupported" && (
                <p className="mt-8 flex items-start gap-3 border-hellfire border-l-2 bg-char py-4 pr-5 pl-5 text-[15px] leading-7 text-bone">
                  <AlertTriangle className="mt-1 size-4 shrink-0 text-hellfire" aria-hidden />
                  <span>
                    Run this from a supported macOS or Linux terminal, not from this browser OS.
                  </span>
                </p>
              )}

              <div className="mt-9">
                <Link href="/signup" className={CTA_SLAB}>
                  Create account
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </div>
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
                  <h3
                    className={cn(
                      poster.className,
                      "text-[28px] leading-none font-light text-bone uppercase",
                    )}
                  >
                    {detected.label}
                  </h3>
                </div>
                <p className="mt-4 text-[15px] leading-7 text-ash">{detected.recommendation}</p>
                <p className="mt-5 border-line-g border-t pt-4 font-sigil text-[12px] leading-6 text-ash">
                  {detected.service}
                </p>
              </div>
            </figure>
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
