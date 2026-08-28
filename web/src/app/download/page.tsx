"use client";

import { ArrowRight, Check, CheckCircle2, ChevronDown, Laptop, Smartphone } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Colophon,
  CTA_SLAB,
  DesktopDownloadButton,
  Eyebrow,
  InstallCommand,
  Masthead,
  RegistrationMarks,
  StoreBadges,
} from "@/components/brand/press";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useDesktopRelease } from "@/hooks/useDesktopRelease";
import { poster } from "@/lib/fonts";
import {
  type DesktopPlatform,
  desktopPlatformForOS,
  detectPlatform,
  type InstallTargetId,
  installTargetForOS,
  installTargets,
  type PlatformOS,
  storeBadges,
  UNDETECTED_PLATFORM,
  WINDOWS_DESKTOP_PLATFORM,
} from "@/lib/platform";
import { cn } from "@/lib/utils";

const PLATFORM_COPY: Record<
  PlatformOS,
  {
    label: string;
    title: string;
    recommendation: string;
    service: string;
    status: "supported" | "wsl" | "mobile" | "unknown";
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
    title: "Install on this Windows PC",
    recommendation:
      "Run the installer in PowerShell. It downloads the Windows daemon build and registers SPAWN D to start when you sign in.",
    service: "Scheduled task: SPAWN D, runs at sign-in",
    status: "supported",
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
    title: "Choose the host platform",
    recommendation:
      "The browser could not identify this OS. Choose macOS / Linux, Windows, or Windows (WSL) below.",
    service:
      "SPAWN D starts with a LaunchAgent, user systemd service, or Windows scheduled task, depending on the host.",
    status: "unknown",
  },
};

const WINDOWS_WSL_COPY = {
  label: "Windows",
  title: "Run SPAWN D through WSL",
  recommendation:
    "Native Windows support is not available yet. Install WSL2 and a Linux distribution, enable systemd, then run the Windows (WSL) command.",
  service:
    "Inside WSL: systemd user service spawnd.service. Windows must start the distribution at sign-in.",
  status: "wsl" as const,
};

const UNKNOWN_WSL_COPY = {
  label: "Unknown OS",
  title: "Choose the host platform",
  recommendation:
    "The browser could not identify this OS. Choose macOS / Linux or Windows (WSL) below.",
  service: "SPAWN D starts with a LaunchAgent or user systemd service, depending on the host.",
  status: "unknown" as const,
};

const WSL_PHONE_COPY =
  "The daemon runs on a Mac or Linux machine (or on Windows through WSL) — never on the phone. Get the app here, then run the installer on the computer you want to possess.";
const NATIVE_PHONE_COPY =
  "The daemon runs on macOS, Linux, or Windows — never on the phone. Get the app here, then install SPAWN D on the computer you want to possess.";

/**
 * The desktop builds the slab can be switched to, in menu order. `label` is
 * the menu row, `name` the prose when the build is not published, and `slab`
 * the words on the button where the default ("Download for macOS") would not
 * say which Mac.
 */
const DESKTOP_BUILDS: {
  platform: DesktopPlatform;
  label: string;
  name: string;
  slab?: string;
}[] = [
  { platform: "darwin-aarch64", label: "macOS · Apple Silicon", name: "macOS" },
  {
    platform: "darwin-x86_64",
    label: "macOS · Intel",
    name: "Intel Mac",
    slab: "Download for Intel Mac",
  },
  { platform: WINDOWS_DESKTOP_PLATFORM, label: "Windows", name: "Windows" },
];

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
    title: "Windows",
    body: "Downloads the x86_64 Windows build, then registers SPAWN D as a scheduled task at sign-in.",
  },
  {
    title: "Remote hosts",
    body: "SSH into the machine that should run agents, then run the same command there.",
  },
];

export default function DownloadPage() {
  const [platform, setPlatform] = useState(UNDETECTED_PLATFORM);
  const [chosenTarget, setChosenTarget] = useState<InstallTargetId | null>(null);
  // The build the slab offers: the reader's pick from the menu beside it, else
  // the one for the browser they are reading on, else Apple Silicon — someone
  // on Linux or a phone is most often fetching a build for a Mac.
  const [chosenDesktop, setChosenDesktop] = useState<DesktopPlatform | null>(null);
  const desktopPlatform: DesktopPlatform =
    chosenDesktop ?? desktopPlatformForOS(platform.os) ?? "darwin-aarch64";
  const desktopBuild =
    DESKTOP_BUILDS.find((build) => build.platform === desktopPlatform) ?? DESKTOP_BUILDS[0];
  const {
    settled: releaseSettled,
    url: desktopBuildUrl,
    version: desktopBuildVersion,
    buildId: desktopBuildId,
    nativeWindowsAvailable,
  } = useDesktopRelease(platform.origin, desktopPlatform);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const baseDetected =
    platform.os === "windows" && !nativeWindowsAvailable
      ? WINDOWS_WSL_COPY
      : platform.os === "unknown" && !nativeWindowsAvailable
        ? UNKNOWN_WSL_COPY
        : PLATFORM_COPY[platform.os];
  const detected =
    (platform.os === "ios" || platform.os === "android") && baseDetected.status === "mobile"
      ? {
          ...baseDetected,
          recommendation: nativeWindowsAvailable ? NATIVE_PHONE_COPY : WSL_PHONE_COPY,
        }
      : baseDetected;
  const supported = detected.status === "supported";
  const targets = installTargets(platform.origin, nativeWindowsAvailable);
  const defaultTargetId = installTargetForOS(platform.os, nativeWindowsAvailable);
  const activeTarget =
    targets.find((target) => target.id === (chosenTarget ?? defaultTargetId)) ?? targets[0];
  const prebuiltCommand = activeTarget?.prebuiltCommand ?? platform.prebuiltInstallCommand;
  const showWslCaveats = activeTarget?.id === "windows-wsl";

  // The one dot of colour on the detected plate: the brand ink says "good",
  // hellfire says "not here", ash says "we couldn't tell".
  const statusIcon = useMemo(() => {
    if (supported) return <CheckCircle2 className="size-4 text-ember" aria-hidden />;
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
            One account, three windows onto the same possessed hosts: the companion on your desktop,
            the app in your pocket, the browser anywhere. The daemon never leaves your machine —
            these only look in on it.
          </p>

          {/* Two doors: the desktop slab with a menu beside it for the builds
           * it is not showing, and the phone stores in their own artwork. Side
           * by side with a rule between them where the line has room for both;
           * one under the other where it does not. The four cards this
           * replaced said the same thing four times over; what a reader wants
           * here is the button. */}
          <div className="mt-14 flex min-w-0 flex-col gap-12 lg:flex-row lg:gap-0">
            <div className="min-w-0 lg:pr-12">
              <p className="font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
                Download on desktop
              </p>
              {/* A split slab: the download on the left, the switch on the
               * right, one shape. Full-width on a phone so the words never
               * wrap inside the slab; its own width everywhere else. */}
              <div className="mt-4 flex w-full max-w-full items-stretch sm:inline-flex sm:w-auto">
                {desktopBuildUrl || !releaseSettled ? (
                  <DesktopDownloadButton
                    // A new build is a new button: a press held for the last
                    // one is dropped rather than spent on this one.
                    key={desktopPlatform}
                    href={desktopBuildUrl}
                    version={desktopBuildVersion}
                    buildId={desktopBuildId}
                    pending={!releaseSettled}
                    platform={desktopPlatform}
                    label={desktopBuild.slab}
                    className="h-14 min-w-0 grow rounded-r-none px-6 sm:grow-0"
                  />
                ) : (
                  <span className="inline-flex min-h-14 min-w-0 grow items-center rounded-sm rounded-r-none border border-r-0 border-line-strong px-6 py-3 font-sigil text-[12px] leading-5 tracking-[0.14em] text-ash uppercase sm:grow-0">
                    {/* Windows has not launched, so it is coming rather than
                     * merely missing; a Mac build absent from a release is the
                     * second thing and should not borrow the first one's words. */}
                    {desktopPlatform === WINDOWS_DESKTOP_PLATFORM
                      ? `${desktopBuild.name} desktop app coming soon`
                      : `${desktopBuild.name} desktop build not published yet`}
                  </span>
                )}
                <DropdownMenu
                  align="end"
                  className="flex shrink-0"
                  menuClassName="min-w-56 rounded-sm bg-char p-1.5"
                  renderTrigger={(props) => (
                    <button
                      type="button"
                      {...props}
                      aria-label="Choose a different desktop build"
                      className="inline-flex min-h-14 items-center justify-center self-stretch rounded-sm rounded-l-none border-l border-void/20 bg-bone px-3.5 text-void transition-colors hover:bg-white"
                    >
                      <ChevronDown className="size-4" aria-hidden />
                    </button>
                  )}
                >
                  {DESKTOP_BUILDS.map((build) => (
                    <DropdownMenuItem
                      key={build.platform}
                      onSelect={() => setChosenDesktop(build.platform)}
                      className="justify-between gap-4 rounded-sm px-3 py-2.5 font-sigil text-[12px] tracking-[0.14em] text-bone uppercase"
                    >
                      {build.label}
                      {build.platform === desktopPlatform && (
                        <Check className="size-4 shrink-0 text-ember" aria-hidden />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenu>
              </div>
            </div>

            <div className="min-w-0 lg:shrink-0 lg:border-l lg:border-line-strong lg:pl-12">
              <p className="font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
                Download on mobile
              </p>
              {/* The vendors' own badges, as supplied: on a phone the badge is
               * the download button, and neither may be redrawn. A listing
               * that is not live yet says so under the badge. */}
              <StoreBadges badges={storeBadges()} className="mt-4" />
            </div>
          </div>
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
                Possess a machine with one line.
              </h2>
              <p className="mt-6 max-w-[54ch] text-[17px] leading-8 text-ash">
                The apps are windows; this is the thing they look at. Run one line on the machine
                you want to possess — never on the phone — and it downloads the matching prebuilt
                daemon, then starts it for your account. Then the pairing ceremony: consensual,
                auditable, revocable.
              </p>

              <InstallCommand
                targets={targets}
                defaultTargetId={defaultTargetId}
                onTargetChange={(id) => setChosenTarget(id as InstallTargetId)}
                className="mt-9"
              />

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
                <p className="mt-4 font-sigil text-[12px] tracking-[0.12em] text-bone uppercase">
                  {detected.title}
                </p>
                <p className="mt-4 text-[15px] leading-7 text-ash">{detected.recommendation}</p>
                <p className="mt-5 border-line-g border-t pt-4 font-sigil text-[12px] leading-6 text-ash">
                  {detected.service}
                </p>
              </div>
              {showWslCaveats && (
                <div className="grid gap-6 border-line-g border-t px-5 py-6 text-[14px] leading-7 text-ash sm:px-6">
                  <div className="grid gap-3">
                    <h4 className="font-sigil text-[12px] tracking-[0.14em] text-bone uppercase">
                      Enable the service manager
                    </h4>
                    <p>
                      In WSL, add this to <code>/etc/wsl.conf</code>:
                    </p>
                    <pre className="overflow-x-auto rounded-sm bg-void px-4 py-3 font-mono text-[13px] text-bone">
                      <code>{`[boot]\nsystemd=true`}</code>
                    </pre>
                    <p>
                      Then run <code>wsl --shutdown</code> from PowerShell and reopen the
                      distribution.
                    </p>
                  </div>
                  <div className="grid gap-3">
                    <h4 className="font-sigil text-[12px] tracking-[0.14em] text-bone uppercase">
                      Keep it online after sign-in
                    </h4>
                    <p>
                      WSL does not start a distribution at Windows sign-in. Create a logon task
                      whose action is <code>wsl -d &lt;distro&gt; --exec true</code>. Without that
                      task, SPAWN D remains offline until the distribution starts.
                    </p>
                  </div>
                </div>
              )}
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
          <div className="grid min-w-0 gap-y-14 md:grid-cols-2 md:gap-x-12 xl:grid-cols-4 xl:gap-y-0">
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
            <span className="text-ember">{activeTarget?.prompt ?? "$"}</span>
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
