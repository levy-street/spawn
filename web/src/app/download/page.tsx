"use client";

import { Check, Clipboard, Download, Laptop, MonitorCog, Terminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type PlatformId = "macos" | "linux" | "windows";

type Platform = {
  id: PlatformId;
  label: string;
  detail: string;
  commandLabel: string;
  command: (origin: string) => string;
  notes: string[];
};

const PLATFORMS: Platform[] = [
  {
    id: "macos",
    label: "macOS",
    detail: "Apple Silicon and Intel Macs",
    commandLabel: "Terminal",
    command: (origin) => `curl -fsSL ${origin}/install.sh | sh -s -- --server ${origin}`,
    notes: ["Uses a hosted self-contained daemon release when one is available for this Mac."],
  },
  {
    id: "linux",
    label: "Linux",
    detail: "Debian, Ubuntu, Fedora, Arch, SUSE, Alpine",
    commandLabel: "Shell",
    command: (origin) => `curl -fsSL ${origin}/install.sh | sh -s -- --server ${origin}`,
    notes: [
      "Uses a hosted self-contained daemon release when one is available for this Linux target.",
    ],
  },
  {
    id: "windows",
    label: "Windows",
    detail: "Windows 11 with WSL2",
    commandLabel: "PowerShell, then WSL",
    command: (origin) =>
      `wsl --install -d Ubuntu\nwsl\ncurl -fsSL ${origin}/install.sh | sh -s -- --server ${origin}`,
    notes: ["Run the Linux daemon inside WSL for a normal Unix PTY and filesystem."],
  },
];

function detectPlatform(): PlatformId {
  const nav = window.navigator as Navigator & { userAgentData?: { platform?: string } };
  const raw = `${nav.userAgentData?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`;
  const text = raw.toLowerCase();
  if (text.includes("win")) return "windows";
  if (text.includes("mac")) return "macos";
  return "linux";
}

export default function DownloadPage() {
  return (
    <main className="min-h-vv bg-background text-foreground pad-safe-top pad-safe-bottom pad-safe-x">
      <DaemonDownload />
    </main>
  );
}

function DaemonDownload() {
  const [origin, setOrigin] = useState("https://spawnd.dev");
  const [selected, setSelected] = useState<PlatformId>("linux");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    setSelected(detectPlatform());
  }, []);

  const platform = useMemo(
    () => PLATFORMS.find((item) => item.id === selected) ?? PLATFORMS[1],
    [selected],
  );
  const command = platform.command(origin);

  const copyCommand = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="mx-auto w-full max-w-4xl p-4">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Install daemon</h1>
          <p className="text-sm text-muted-foreground">spawnd runs agents on your machine.</p>
        </div>
        <Button asChild variant="outline">
          <a href="/install.sh">
            <Download className="size-4" />
            install.sh
          </a>
        </Button>
      </header>

      <div className="grid gap-4 @container/download">
        <div className="grid gap-2 @md/download:grid-cols-3">
          {PLATFORMS.map((item) => {
            const active = item.id === selected;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelected(item.id)}
                className={cn(
                  "flex min-h-24 items-start gap-3 rounded-md border border-border p-3 text-left transition-colors",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                {item.id === "windows" ? (
                  <MonitorCog className="mt-0.5 size-5 shrink-0" />
                ) : item.id === "macos" ? (
                  <Laptop className="mt-0.5 size-5 shrink-0" />
                ) : (
                  <Terminal className="mt-0.5 size-5 shrink-0" />
                )}
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{item.detail}</span>
                </span>
              </button>
            );
          })}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{platform.label}</CardTitle>
            <CardDescription>{platform.commandLabel}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-hidden rounded-md border border-border bg-muted">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-xs font-medium uppercase text-muted-foreground">Command</span>
                <Button variant="ghost" size="sm" onClick={copyCommand}>
                  {copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap p-3 text-sm">
                <code>{command}</code>
              </pre>
            </div>

            <div className="grid gap-2 text-sm text-muted-foreground">
              {platform.notes.map((note) => (
                <div key={note} className="rounded-md border border-border px-3 py-2">
                  {note}
                </div>
              ))}
              <div className="rounded-md border border-border px-3 py-2">
                If your target has no hosted artifact yet, add{" "}
                <span className="text-foreground">--build-from-source</span> to build locally.
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                After login, approve the daemon from{" "}
                <span className="text-foreground">Approve a daemon</span>.
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
