"use client";

import {
  AlertTriangle,
  Apple,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
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
import { detectPlatform, type PlatformOS, UNDETECTED_PLATFORM } from "@/lib/platform";

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
      "The daemon does not ship a Windows build yet. Install spawn from a Mac, Linux workstation, or Linux server.",
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
    icon: <Apple className="size-5" />,
    title: "macOS",
    body: "Downloads a Darwin build for Apple Silicon or Intel, then starts a LaunchAgent.",
  },
  {
    icon: <Server className="size-5" />,
    title: "Linux",
    body: "Downloads an x86_64 or arm64 Linux build, then starts user systemd when available.",
  },
  {
    icon: <MonitorCog className="size-5" />,
    title: "Remote hosts",
    body: "SSH into the machine that should run agents, then run the same command there.",
  },
];

export default function DownloadPage() {
  const [platform, setPlatform] = useState(UNDETECTED_PLATFORM);
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(false);

  useEffect(() => {
    setPlatform(detectPlatform());
    setCanCopy(Boolean(navigator.clipboard));
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

  const statusIcon = useMemo(() => {
    if (supported) return <CheckCircle2 className="size-5 text-success" />;
    if (detected.status === "unsupported") return <AlertTriangle className="size-5 text-warning" />;
    return <Laptop className="size-5 text-info" />;
  }, [detected.status, supported]);

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
              <Download className="size-4 text-info" />
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
            <div className="flex items-start gap-3">
              <div className="mt-1">{statusIcon}</div>
              <div>
                <p className="text-sm text-muted-foreground">Detected browser OS</p>
                <h2 className="mt-1 text-2xl font-semibold">{detected.label}</h2>
                <p className="mt-3 text-sm leading-6 text-foreground/85">
                  {detected.recommendation}
                </p>
                <p className="mt-3 text-sm text-muted-foreground">{detected.service}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto grid w-full max-w-7xl gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="rounded-md border border-brand-hairline bg-brand-panel p-4 sm:p-6">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-md bg-white text-black">
                <Terminal className="size-5" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">{detected.title}</h2>
                <p className="text-sm text-muted-foreground">Run this in the host terminal.</p>
              </div>
            </div>

            <div className="mt-5 rounded-md border border-brand-hairline bg-brand-well p-3 font-mono text-sm text-foreground">
              <span className="mr-2 text-success">$</span>
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
              <p className="mt-4 rounded-md border border-warning/25 bg-warning-soft px-3 py-2 text-sm text-warning">
                Use this command from a supported macOS or Linux terminal, not from this browser OS.
              </p>
            )}
          </div>

          <div className="grid gap-3">
            {OPTIONS.map((option) => (
              <InstallOption key={option.title} icon={option.icon} title={option.title}>
                {option.body}
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
            <span className="mr-2 text-success">$</span>
            <code className="break-all">{prebuiltCommand}</code>
          </div>
        </div>
      </section>
    </main>
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
