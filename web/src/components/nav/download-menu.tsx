"use client";

import { ArrowRight, Download, Laptop, Smartphone } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useDesktopRelease } from "@/hooks/useDesktopRelease";
import {
  desktopPlatformForOS,
  detectPlatform,
  storeBadges,
  WINDOWS_DESKTOP_PLATFORM,
} from "@/lib/platform";

/**
 * The apps, one press from the account row: the desktop build for the OS this
 * browser is on, and the two phone apps. The full story — build switchers,
 * install one-liners, remote hosts — stays on /download, which the last row
 * leads to; this menu is for the person who already knows they want the app.
 */
export function DownloadMenu() {
  return (
    <DropdownMenu
      side="top"
      align="end"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label="Download the apps"
          title="Download the apps"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Download className="size-4" aria-hidden />
        </button>
      )}
    >
      {/* Mounted only while open, so /api/release is only asked for once
          someone actually reaches for the button. */}
      <DownloadMenuItems />
    </DropdownMenu>
  );
}

function DownloadMenuItems() {
  // Safe to read in the initializer: menu content never server-renders, so
  // there is no hydration pass for the detected OS to disagree with.
  const [platform] = useState(detectPlatform);
  const desktopPlatform = desktopPlatformForOS(platform.os) ?? "darwin-aarch64";
  const release = useDesktopRelease(platform.origin, desktopPlatform);
  const desktopName = desktopPlatform === WINDOWS_DESKTOP_PLATFORM ? "Windows" : "macOS";
  const badges = storeBadges();

  return (
    <>
      <DropdownMenuLabel>Get SPAWN D</DropdownMenuLabel>
      {/* Until a build is advertised (or before discovery settles), the row
          leads to /download, which explains itself; a dead download link
          explains nothing. */}
      <DropdownMenuItem href={release.url ?? "/download"} external={release.url !== null}>
        <Laptop className="size-4" aria-hidden />
        Download for {desktopName}
        {release.version && (
          <span className="ml-auto shrink-0 pl-3 font-mono text-[10px] text-muted-foreground">
            v{release.version}
          </span>
        )}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {badges.map((badge) => (
        <DropdownMenuItem
          key={badge.id}
          // A listing that is not live yet falls back to the download page,
          // same bargain the lander's badges strike: never a link that 404s.
          href={badge.href ?? "/download"}
          external={badge.href !== null}
          newTab={badge.href !== null}
        >
          <Smartphone className="size-4" aria-hidden />
          Download for {badge.id === "ios" ? "iOS" : "Android"}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem href="/download">
        <ArrowRight className="size-4" aria-hidden />
        All downloads
      </DropdownMenuItem>
    </>
  );
}
