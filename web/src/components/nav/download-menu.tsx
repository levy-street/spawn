"use client";

import { ArrowRight, Check, Download, Laptop, Loader2, Smartphone } from "lucide-react";
import { useState } from "react";
import {
  DROPDOWN_ITEM_CLASS,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RailTooltip } from "@/components/ui/tooltip";
import { useDesktopDownload } from "@/hooks/useDesktopDownload";
import { type DesktopReleaseState, useDesktopRelease } from "@/hooks/useDesktopRelease";
import {
  type DesktopPlatform,
  desktopPlatformForOS,
  detectPlatform,
  storeBadges,
  WINDOWS_DESKTOP_PLATFORM,
} from "@/lib/platform";
import { cn } from "@/lib/utils";

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
      /*
       * A fixed measure rather than one the content settles into. Two things
       * arrive after the menu has been placed — the build's version, and the
       * download's own progress — and a menu that changes width after it
       * opens is re-anchored to its trigger's other edge, which reads as the
       * whole thing sliding in from the far side of the screen.
       */
      menuClassName="w-68"
      // The trigger keeps its 28px beside the account row, whatever the row
      // does with the space it is given — and stands 6px in from the pill's
      // right edge, the same distance the avatar stands from its left, so
      // its own hover ground reads as a button inside the row rather than a
      // notch cut out of the row's end.
      className="mr-1.5 shrink-0"
      renderTrigger={(props) => (
        <RailTooltip label="Get SPAWN D">
          <button
            {...props}
            type="button"
            aria-label="Get SPAWN D"
            // Two lights, nested: the account row's pill brightens for the
            // whole row, and this button lays its own ground on top of that
            // so the pointer resting on the mark reads as being on the
            // button, not merely on the row it shares.
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Download className="size-4" aria-hidden />
          </button>
        </RailTooltip>
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
  const desktopPlatform = desktopPlatformForOS(platform.os);
  const badges = storeBadges();

  return (
    <>
      <DropdownMenuLabel>Get SPAWN D</DropdownMenuLabel>
      {desktopPlatform === null ? (
        // No desktop build for this OS — Linux, ChromeOS, something unknown.
        // /download says which platforms there are; a macOS disk image handed
        // to a Linux browser would only say the menu had not looked.
        <DropdownMenuItem href="/download">
          <Laptop className="size-4" aria-hidden />
          Download for desktop
        </DropdownMenuItem>
      ) : (
        <DesktopDownloadRow origin={platform.origin} platform={desktopPlatform} />
      )}
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
      {/* The arrow trails: this row leaves the menu for a page, and an arrow
          at the far edge says "onward" where one in the icon column would
          only say "another download". */}
      <DropdownMenuItem href="/download">
        <span className="min-w-0 flex-1">All downloads</span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuItem>
    </>
  );
}

/**
 * The desktop row, which answers for the download rather than merely starting
 * one: it holds a press made before the manifest named a build, counts the
 * bytes in, and says when the file is here — the same machine the bone slab
 * on /download runs, drawn as a menu row.
 *
 * Alone among the rows it does not dismiss the menu on press: the menu is
 * where the progress is shown, and a surface that vanishes the instant it has
 * something to report is the state this row exists to replace. Closing it
 * mid-download only takes the readout away; the file still lands.
 */
function DesktopDownloadRow({ origin, platform }: { origin: string; platform: DesktopPlatform }) {
  const release: DesktopReleaseState = useDesktopRelease(origin, platform);
  const { phase, percent, busy, alreadyHas, press } = useDesktopDownload({
    href: release.url,
    pending: !release.settled,
    platform,
    version: release.version,
    buildId: release.buildId,
  });
  const name = platform === WINDOWS_DESKTOP_PLATFORM ? "Windows" : "macOS";
  const spinner = <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />;
  const face = (() => {
    switch (phase.at) {
      case "waiting":
        return { icon: spinner, said: "Preparing download" };
      case "running":
        return {
          icon: spinner,
          said:
            percent === null ? "Downloading" : `Downloading ${Math.min(99, Math.round(percent))}%`,
        };
      case "done":
        return { icon: <Check className="size-4 shrink-0" aria-hidden />, said: "Downloaded" };
      case "failed":
        return { icon: <Laptop className="size-4" aria-hidden />, said: "Download started" };
      default:
        return {
          icon: <Laptop className="size-4" aria-hidden />,
          // A build this browser already has is still offered — just honestly.
          said: alreadyHas ? `Download ${name} again` : `Download for ${name}`,
        };
    }
  })();

  const inner = (
    <>
      {percent !== null && (
        // The row fills as the file arrives, behind the words.
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 -z-10 bg-popover-accent transition-[width] duration-150 ease-out"
          style={{ width: `${percent}%` }}
        />
      )}
      {face.icon}
      <span className="min-w-0 flex-1 truncate">{face.said}</span>
      {release.version && (
        <span className="shrink-0 pl-3 font-mono text-[10px] text-muted-foreground">
          v{release.version}
        </span>
      )}
    </>
  );
  const classes = cn(DROPDOWN_ITEM_CLASS, "relative isolate overflow-hidden");

  // Until discovery settles the row still presses — the press is held until
  // the build is named, rather than spent on a detour through /download.
  if (release.url === null && !release.settled) {
    return (
      <button
        type="button"
        role="menuitem"
        // The menu is this press's own readout; it stays up to give it.
        onClick={(event) => {
          event.stopPropagation();
          press();
        }}
        aria-busy={busy}
        className={classes}
        data-testid="menu-desktop-download"
      >
        {inner}
      </button>
    );
  }
  // Nothing advertised for this platform: /download explains itself, where a
  // dead download link would explain nothing.
  if (release.url === null) {
    return (
      <DropdownMenuItem href="/download">
        <Laptop className="size-4" aria-hidden />
        Download for {name}
      </DropdownMenuItem>
    );
  }
  // A real link underneath, so a middle click, a right click and a keyboard
  // all behave — the flourish belongs to the ordinary press alone.
  return (
    <a
      role="menuitem"
      href={release.url}
      download
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        press();
      }}
      aria-busy={busy}
      className={classes}
      data-testid="menu-desktop-download"
    >
      {inner}
    </a>
  );
}
