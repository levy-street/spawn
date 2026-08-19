"use client";

import { Server } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The OS mark for a host tile.
 *
 * Follows the pattern `AgentKindIcon` already establishes: inline brand marks
 * with a lucide fallback for anything unrecognized. `host.os` has always been
 * collected (`std::env::consts::OS`) and only ever printed as text, so picking
 * the right box out of a list was a read rather than a glance.
 *
 * Marks are deliberately monochrome `currentColor` glyphs at UI-glyph size —
 * these are trademarks, and an altered wordmark is worse than no mark.
 */
export type HostOs = "macos" | "linux" | "windows" | "unknown";

export function hostOs(os: string | null | undefined): HostOs {
  const value = (os ?? "").trim().toLowerCase();
  if (value === "macos" || value === "darwin" || value.includes("mac")) return "macos";
  if (value === "windows" || value.startsWith("win")) return "windows";
  if (value === "linux" || value.includes("linux")) return "linux";
  return "unknown";
}

export function hostOsLabel(os: string | null | undefined): string {
  switch (hostOs(os)) {
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "windows":
      return "Windows";
    default:
      // Say what the daemon actually reported rather than inventing a name.
      return (os ?? "").trim() || "Unknown OS";
  }
}

export function HostOsIcon({
  os,
  className,
}: {
  os: string | null | undefined;
  className?: string;
}) {
  const kind = hostOs(os);
  const label = hostOsLabel(os);
  const classes = cn("size-4", className);
  switch (kind) {
    case "macos":
      return <AppleMark className={classes} title={label} />;
    case "linux":
      return <LinuxMark className={classes} title={label} />;
    case "windows":
      return <WindowsMark className={classes} title={label} />;
    default:
      return <Server className={classes} aria-label={label} role="img" />;
  }
}

function AppleMark({ className, title }: { className?: string; title: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-label={title}>
      <title>{title}</title>
      <path
        d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.18-1.72-1.35-.14-2.64.79-3.33.79-.69 0-1.75-.77-2.87-.75-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.74 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.08 2.65-2.14.83-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.31-3.53zM14.9 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.7-.92 2.7.97.08 1.96-.5 2.58-1.23z"
        fill="currentColor"
      />
    </svg>
  );
}

function LinuxMark({ className, title }: { className?: string; title: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-label={title}>
      <title>{title}</title>
      <path
        d="M12 2c-2.2 0-3.6 1.7-3.5 4 .04 1 .1 1.9-.1 2.6-.2.8-.8 1.5-1.4 2.5-.7 1.1-1.3 2.2-1.6 3.3-.3 1-.2 1.9.2 2.4.3.4.3.9.2 1.4-.1.6.2 1.1.8 1.3.7.2 1.7.2 2.4-.2.4-.2.7-.2 1 0 .6.3 1.3.4 2 .4s1.4-.1 2-.4c.3-.2.6-.2 1 0 .7.4 1.7.4 2.4.2.6-.2.9-.7.8-1.3-.1-.5-.1-1 .2-1.4.4-.5.5-1.4.2-2.4-.3-1.1-.9-2.2-1.6-3.3-.6-1-1.2-1.7-1.4-2.5-.2-.7-.14-1.6-.1-2.6.1-2.3-1.3-4-3.5-4zm-1.6 4.1c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zm3.2 0c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zm-1.6 2.6c.8 0 1.6.4 1.6.8 0 .2-.2.3-.5.5-.3.2-.7.4-1.1.4s-.8-.2-1.1-.4c-.3-.2-.5-.3-.5-.5 0-.4.8-.8 1.6-.8z"
        fill="currentColor"
      />
    </svg>
  );
}

function WindowsMark({ className, title }: { className?: string; title: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-label={title}>
      <title>{title}</title>
      <path
        d="M3 5.6l7.2-1v7.1H3V5.6zm8.4-1.2L21 3v8.7h-9.6V4.4zM3 12.9h7.2V20L3 19V12.9zm8.4 0H21V21l-9.6-1.3v-6.8z"
        fill="currentColor"
      />
    </svg>
  );
}
