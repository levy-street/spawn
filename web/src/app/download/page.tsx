"use client";

import {
  AlertTriangle,
  Apple,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  Fingerprint,
  KeySquare,
  Laptop,
  MonitorCog,
  Server,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DetectedPlatform = "macos" | "linux" | "windows" | "unknown";

/** The three a person can choose. "unknown" is a detection outcome, not a choice. */
const SELECTABLE: Array<Exclude<DetectedPlatform, "unknown">> = ["macos", "linux", "windows"];

type PlatformNote = { icon: ReactNode; title: string; body: string };

const PLATFORM_COPY: Record<
  DetectedPlatform,
  {
    label: string;
    title: string;
    recommendation: string;
    service: string;
    status: "supported" | "unsupported" | "unknown";
    /** Replaces the old fixed macOS/Linux/Remote trio, which was the same on every OS. */
    notes: PlatformNote[];
  }
> = {
  macos: {
    label: "macOS",
    title: "Install on this Mac",
    recommendation:
      "Run the installer in Terminal. It downloads the macOS daemon build and starts a LaunchAgent after login.",
    service: "LaunchAgent: app.spawn.spawnd",
    status: "supported",
    notes: [
      {
        icon: <Apple className="size-5" />,
        title: "Apple Silicon and Intel",
        body: "Downloads the matching Darwin build, then starts a LaunchAgent that comes back after a reboot.",
      },
      {
        icon: <MonitorCog className="size-5" />,
        title: "Another Mac",
        body: "SSH into the Mac that should run agents and run the same line there — the installer resolves the host it lands on.",
      },
    ],
  },
  linux: {
    label: "Linux",
    title: "Install on this Linux host",
    recommendation:
      "Run the installer in a shell on the Linux machine. It downloads the Linux daemon build and starts a user systemd service when available.",
    service: "systemd user service: spawnd.service",
    status: "supported",
    notes: [
      {
        icon: <Server className="size-5" />,
        title: "x86_64 and arm64",
        body: "Downloads the matching Linux build, then starts a user systemd service when one is available.",
      },
      {
        icon: <MonitorCog className="size-5" />,
        title: "Remote hosts",
        body: "SSH into the box that should run agents — a dev box, a GPU host — then run the same command there.",
      },
      {
        icon: <Terminal className="size-5" />,
        title: "Headless boxes",
        body: "Nothing here needs a display: the installer prints an approval link you open from any browser.",
      },
    ],
  },
  windows: {
    label: "Windows",
    title: "Use a macOS or Linux host",
    recommendation:
      "There is no native Windows daemon build yet. Run the installer inside WSL2, or from a Mac, Linux workstation, or Linux server.",
    service: "Windows service support is not available yet.",
    status: "unsupported",
    notes: [
      {
        icon: <MonitorCog className="size-5" />,
        title: "WSL2 is the way in",
        body: "A WSL2 distro is a Linux host as far as spawn is concerned: open its shell and run the Linux command above.",
      },
      {
        icon: <Server className="size-5" />,
        title: "Or possess a Linux box",
        body: "SSH into a Linux machine and install there. Then drive it from this Windows browser like any other host.",
      },
      {
        icon: <AlertTriangle className="size-5" />,
        title: "No native service yet",
        body: "There is no Windows service to register, so nothing runs outside WSL2 or the remote host you chose.",
      },
    ],
  },
  unknown: {
    label: "Unknown OS",
    title: "Run from a host terminal",
    recommendation:
      "The browser could not identify this OS. The installer supports macOS and Linux, and will detect the actual host when it runs.",
    service: "macOS LaunchAgent or Linux user systemd, depending on the host.",
    status: "unknown",
    notes: [
      {
        icon: <Apple className="size-5" />,
        title: "macOS",
        body: "Downloads a Darwin build for Apple Silicon or Intel, then starts a LaunchAgent.",
      },
      {
        icon: <Server className="size-5" />,
        title: "Linux",
        body: "Downloads an x86_64 or arm64 build, then starts user systemd when available.",
      },
      {
        icon: <MonitorCog className="size-5" />,
        title: "Remote hosts",
        body: "SSH into the machine that should run agents, then run the same command there.",
      },
    ],
  },
};

export default function DownloadPage() {
  const [origin, setOrigin] = useState("https://spawnd.dev");
  // What the browser reports, and what the reader chose. Detection picks the
  // default; it does not get to be the only answer. The host you want to
  // possess is frequently not the machine you are reading this on.
  const [detectedPlatform, setDetectedPlatform] = useState<DetectedPlatform>("unknown");
  const [chosenPlatform, setChosenPlatform] = useState<DetectedPlatform | null>(null);
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    setDetectedPlatform(detectPlatform());
    setCanCopy(Boolean(navigator.clipboard));
  }, []);

  const platform = chosenPlatform ?? detectedPlatform;
  const command = `curl -fsSL ${origin}/install.sh | sh`;
  const prebuiltCommand = `curl -fsSL ${origin}/install.sh | sh -s -- --prebuilt-only`;
  const active = PLATFORM_COPY[platform];
  const supported = active.status === "supported";
  const showingDetected = platform === detectedPlatform;

  const copyCommand = async () => {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const statusIcon = useMemo(() => {
    if (supported)
      return <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-300" />;
    if (active.status === "unsupported")
      return <AlertTriangle className="size-5 text-amber-600 dark:text-amber-300" />;
    return <Laptop className="size-5 text-sky-600 dark:text-sky-300" />;
  }, [active.status, supported]);

  return (
    <main className="min-h-vv bg-brand-bg text-foreground">
      <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-5 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-3 text-lg font-semibold">
          <SquareTerminal className="size-7 shrink-0" aria-hidden />
          <span>spawnd</span>
        </Link>
        <Button asChild variant="ghost" size="sm">
          <Link href="/">
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
      </nav>

      <section className="border-border border-y bg-brand-panel px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-md border border-brand-hairline bg-brand-panel/70 px-3 py-1 text-sm text-foreground/85">
              <Download className="size-4 text-sky-600 dark:text-sky-300" />
              Possess a host
            </p>
            <h1 className="text-4xl font-semibold leading-tight sm:text-5xl">
              Install the daemon. Possess the host.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-foreground/85">
              The installer detects macOS or Linux on the machine where it runs, downloads the
              matching prebuilt daemon, then starts it as a user service. One line, then the pairing
              ceremony — consensual, auditable, revocable.
            </p>
          </div>

          <div className="rounded-md border border-brand-hairline bg-brand-panel/60 p-4 sm:p-5">
            {/* Real radios in a fieldset, as in Settings -> Appearance: arrow-key
                navigation, form semantics and screen-reader grouping all come
                free, and the input is only hidden visually. */}
            <fieldset>
              <legend className="text-sm text-muted-foreground">Host OS</legend>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {SELECTABLE.map((option) => {
                  const copy = PLATFORM_COPY[option];
                  const selected = platform === option;
                  return (
                    <label
                      key={option}
                      className={cn(
                        "flex cursor-pointer flex-col items-center gap-1 rounded-md border px-2 py-2 text-center transition-colors",
                        "focus-within:ring-2 focus-within:ring-ring",
                        selected
                          ? "border-ring bg-brand-panel text-foreground"
                          : "border-brand-hairline text-muted-foreground hover:bg-brand-panel/60 hover:text-foreground",
                      )}
                    >
                      <input
                        type="radio"
                        name="spawn-host-os"
                        value={option}
                        checked={selected}
                        onChange={() => setChosenPlatform(option)}
                        className="sr-only"
                      />
                      <span className="text-sm font-medium">{copy.label}</span>
                      <span
                        className={cn(
                          "text-[10px] uppercase tracking-wide",
                          option === detectedPlatform
                            ? "text-sky-600 dark:text-sky-300"
                            : "invisible",
                        )}
                      >
                        detected
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-4 flex items-start gap-3 border-t border-brand-hairline pt-4">
              <div className="mt-1">{statusIcon}</div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {showingDetected
                    ? "Detected browser OS"
                    : `Showing ${active.label} · detected ${PLATFORM_COPY[detectedPlatform].label}`}
                </p>
                <h2 className="mt-1 text-2xl font-semibold">{active.label}</h2>
                <p className="mt-3 text-sm leading-6 text-foreground/85">{active.recommendation}</p>
                <p className="mt-3 text-sm text-muted-foreground">{active.service}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* The two things you actually do, in order. Before this, the page
          handed over a command and then stopped: the installer prints a code,
          and there was nothing here to redeem it with. */}
      <section className="px-4 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-7xl">
          {/* items-start: step 1 is the shorter card, and stretching it to
              match leaves a dead void under the command block. */}
          <ol className="grid items-start gap-6 lg:grid-cols-2">
            <Step
              n={1}
              icon={<Terminal className="size-5" />}
              title={active.title}
              blurb="Run this in the host terminal."
            >
              <div className="mt-5 rounded-md border border-brand-hairline bg-brand-well p-3 font-mono text-sm text-foreground">
                <span className="mr-2 text-emerald-600 dark:text-emerald-300">$</span>
                <code className="break-all">{command}</code>
              </div>

              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <Button type="button" onClick={copyCommand} disabled={!canCopy}>
                  <Copy className="size-4" />
                  {copied ? "Copied" : "Copy command"}
                </Button>
                <Button asChild variant="outline">
                  <Link href="/signup">
                    Create account
                    <CheckCircle2 className="size-4" />
                  </Link>
                </Button>
              </div>

              {!supported && (
                <p className="mt-4 rounded-md border border-amber-300/25 bg-amber-600 dark:bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
                  Use this command from a supported macOS or Linux terminal, not from this browser
                  OS.
                </p>
              )}
            </Step>

            <Step
              n={2}
              icon={<KeySquare className="size-5" />}
              title="Approve the host"
              blurb="The installer opens this page for you."
            >
              <p className="mt-5 text-sm leading-6 text-foreground/85">
                Possession is proven by the host&apos;s own key before anything is shown, so the
                link the installer prints names a ceremony your machine started. Landed here some
                other way? Redeem the code it printed.
              </p>

              <div className="mt-4">
                <Button asChild>
                  <Link href="/device">
                    <KeySquare className="size-4" />
                    Enter code
                  </Link>
                </Button>
              </div>

              {/* The step-2 card is where the ceremony actually happens, so
                  the reminder belongs here rather than buried in prose. */}
              <div className="mt-5 flex gap-3 rounded-md border border-brand-hairline bg-brand-well p-3">
                <Fingerprint className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-300" />
                <p className="text-sm leading-6 text-muted-foreground">
                  Check the verification code in the browser matches the one in the terminal before
                  you approve. That comparison is the part only you can do — approving binds this
                  host to your account.
                </p>
              </div>
            </Step>
          </ol>

          {/* Per-OS, so the cards say something the selected tab does not
              already say. They used to be a fixed macOS/Linux/Remote trio that
              looked like a chooser and was not one. */}
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {active.notes.map((note) => (
              <InstallOption key={note.title} icon={note.icon} title={note.title}>
                {note.body}
              </InstallOption>
            ))}
          </div>
        </div>
      </section>

      <section className="border-border border-t bg-brand-panel px-4 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto grid w-full max-w-7xl gap-6 md:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold">Prebuilt-only smoke test</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Use this when you want to prove the hosted binary path works and fail instead of
              building from source.
            </p>
          </div>
          <div className="rounded-md border border-brand-hairline bg-brand-well p-3 font-mono text-sm text-foreground">
            <span className="mr-2 text-emerald-600 dark:text-emerald-300">$</span>
            <code className="break-all">{prebuiltCommand}</code>
          </div>
        </div>
      </section>
    </main>
  );
}

function detectPlatform(): DetectedPlatform {
  const nav = window.navigator;
  const userAgent = nav.userAgent.toLowerCase();
  const platform = nav.platform.toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os x")) return "macos";
  if (platform.includes("linux") || userAgent.includes("linux")) return "linux";
  if (platform.includes("win") || userAgent.includes("windows")) return "windows";
  return "unknown";
}

/** One numbered step. The ordinal is the point, so it carries the emphasis. */
function Step({
  n,
  icon,
  title,
  blurb,
  children,
}: {
  n: number;
  icon: ReactNode;
  title: string;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <li className="rounded-md border border-brand-hairline bg-brand-panel p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="relative flex size-10 shrink-0 items-center justify-center rounded-md bg-white text-black">
          {icon}
          <span
            aria-hidden
            className="absolute -left-2 -top-2 grid size-5 place-items-center rounded-full bg-hellfire font-sigil text-[11px] text-void"
          >
            {n}
          </span>
        </div>
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">
            <span className="sr-only">Step {n}: </span>
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{blurb}</p>
        </div>
      </div>
      {children}
    </li>
  );
}

function InstallOption({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-brand-hairline bg-brand-panel/50 p-4">
      <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-white text-black">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{children}</p>
    </div>
  );
}
