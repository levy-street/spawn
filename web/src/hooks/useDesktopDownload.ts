"use client";

import { useCallback, useEffect, useState } from "react";
import type { DesktopPlatform } from "@/lib/platform";

/**
 * The desktop download, as a state machine rather than a link.
 *
 * A download button that answers for the press and not merely for the click:
 * it holds a press made before the release manifest named a build, reports
 * the bytes as they arrive, and says when the file is here. The bytes come
 * through `fetch` so there is something true to report; a browser that cannot
 * do that, or a fetch that fails, falls back to handing the URL straight to
 * the browser, so the file is never held hostage to the flourish.
 *
 * Shared by the two surfaces that offer a build: the bone slab on the public
 * pages (`brand/press.tsx`) and the account row's menu inside the app
 * (`nav/download-menu.tsx`). They are drawn nothing alike and behave
 * identically, which is the whole reason this lives apart from both.
 */

/** How long a surface says "Downloaded" before settling into offering another. */
export const DOWNLOAD_ACK_MS = 4000;
/** Where a browser remembers which build it has already been handed. */
const DOWNLOADED_KEY = "spawn:desktop-downloaded";

export type DesktopDownloadPhase =
  | { at: "offer" }
  /** Pressed before the build was named: the press is held, not spent. */
  | { at: "waiting"; platform: DesktopPlatform }
  | { at: "running"; received: number; total: number | null }
  | { at: "done" }
  | { at: "failed" };

export interface DesktopDownloadState {
  phase: DesktopDownloadPhase;
  /** 0–100 while the length is known; null when it is not, or nothing runs. */
  percent: number | null;
  /** A press is in flight — held for a build, or reading one. */
  busy: boolean;
  /** This browser has already been handed exactly this build. */
  alreadyHas: boolean;
  /** Take an ordinary left press. */
  press: () => void;
}

/** The build this browser downloaded last, or null. Storage can throw — a
 * private window, a browser set to refuse it — and a download button is not
 * worth failing over, so it answers null and the button reads as fresh. */
function rememberedDownload(): string | null {
  try {
    return window.localStorage.getItem(DOWNLOADED_KEY);
  } catch {
    return null;
  }
}

function rememberDownload(stamp: string): void {
  try {
    window.localStorage.setItem(DOWNLOADED_KEY, stamp);
  } catch {
    // A download that happened is still a download that happened.
  }
}

/** Hand a blob or a URL over as a file, without leaving the page. */
function saveAs(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** The file's own name, off the end of its URL. */
function filenameOf(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || "SPAWN-D.dmg";
}

export function useDesktopDownload({
  href,
  pending = false,
  platform,
  version = null,
  buildId = null,
}: {
  /** The artifact, or null while none is advertised for this platform. */
  href: string | null;
  /** The release manifest has not answered yet; a press waits on it. */
  pending?: boolean;
  /** Exact artifact requested — a held press is stamped with this value. */
  platform: DesktopPlatform;
  version?: string | null;
  /**
   * What tells this build from the last one of the same version — the desktop
   * tree, or the digest of the image. A rebuild changes it, and the surface
   * goes back to offering a download rather than claiming you have this one.
   */
  buildId?: string | null;
}): DesktopDownloadState {
  const [phase, setPhase] = useState<DesktopDownloadPhase>({ at: "offer" });
  const [had, setHad] = useState<string | null>(null);
  // Read after mount, never during render: the server has no localStorage, and
  // a first paint that disagreed with it would be a hydration mismatch.
  useEffect(() => setHad(rememberedDownload()), []);

  /** This browser already has exactly this build — not merely its version. */
  const stamp = buildId === null ? null : `${platform}:${version ?? "?"}@${buildId}`;

  const fetchIt = useCallback(
    async (url: string) => {
      setPhase({ at: "running", received: 0, total: null });
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const length = Number(response.headers.get("Content-Length"));
        const total = Number.isFinite(length) && length > 0 ? length : null;
        const reader = response.body.getReader();
        const chunks: BlobPart[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value as BlobPart);
          received += value.byteLength;
          setPhase({ at: "running", received, total });
        }
        const blob = new Blob(chunks, { type: "application/octet-stream" });
        const objectUrl = URL.createObjectURL(blob);
        saveAs(objectUrl, filenameOf(url));
        // Long enough for the browser to have taken it; the blob is the only
        // copy until it does.
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        if (stamp !== null) {
          rememberDownload(stamp);
          setHad(stamp);
        }
        setPhase({ at: "done" });
      } catch {
        // Whatever went wrong with reading it ourselves, the browser can still
        // be asked to fetch it the ordinary way.
        saveAs(url, filenameOf(url));
        setPhase({ at: "failed" });
      }
    },
    [stamp],
  );

  // The held press, spent as soon as there is something to spend it on.
  useEffect(() => {
    if (phase.at !== "waiting") return;
    if (phase.platform !== platform) {
      setPhase({ at: "offer" });
      window.location.assign("/download");
      return;
    }
    if (href !== null) {
      void fetchIt(href);
      return;
    }
    // The manifest answered without that exact artifact, or the surrounding
    // target changed while the request was held. Deliberately cancel to the
    // inventory page; never reinterpret the old press as another platform.
    if (!pending) {
      setPhase({ at: "offer" });
      window.location.assign("/download");
    }
  }, [phase, href, pending, fetchIt, platform]);

  useEffect(() => {
    if (phase.at !== "done" && phase.at !== "failed") return;
    const timer = setTimeout(() => setPhase({ at: "offer" }), DOWNLOAD_ACK_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const press = useCallback(() => {
    if (href !== null) {
      void fetchIt(href);
      return;
    }
    if (pending) {
      setPhase({ at: "waiting", platform });
      return;
    }
    window.location.assign("/download");
  }, [fetchIt, href, pending, platform]);

  return {
    phase,
    percent:
      phase.at === "running" && phase.total !== null
        ? Math.min(100, (phase.received / phase.total) * 100)
        : null,
    busy: phase.at === "waiting" || phase.at === "running",
    alreadyHas: stamp !== null && had === stamp,
    press,
  };
}
