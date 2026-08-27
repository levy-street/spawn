"use client";

import { useEffect, useState } from "react";
import {
  type DesktopPlatform,
  type DesktopRelease,
  desktopDownloadUrl,
  desktopReleaseFromPayload,
  localDesktopBuildFromPayload,
} from "@/lib/platform";

export interface DesktopReleaseState {
  /**
   * The manifest's desktop block — release *identity*, so a version and the
   * tree that proves it. Null where this deployment can prove none, which is
   * not the same as having nothing to hand out; see `url`.
   */
  release: DesktopRelease | null;
  /**
   * Whether the asking is over — including by failing. "We have not asked yet"
   * is not the same answer as "there is nothing to hand out", and a download
   * pressed during that window waits for the real one rather than being sent
   * somewhere else.
   */
  settled: boolean;
  /** The Apple Silicon disk image to hand over, once something names one. */
  url: string | null;
  /** That build's version, whichever source named it. */
  version: string | null;
  /**
   * What identifies *this* build rather than its version: the desktop tree the
   * manifest proves, or the digest of the image on disk. A development rebuild
   * keeps its version and changes this, which is the only way a page can tell
   * that the thing it offers is not the thing you already have.
   */
  buildId: string | null;
}

/**
 * The Mac build this deployment can hand over.
 *
 * Two sources, asked in order of authority:
 *
 * 1. `/api/release`, the release manifest. It names a version only when the
 *    checkout can prove one, so it is silent on any host with uncommitted
 *    work in `desktop/` — the ordinary state of a development machine.
 * 2. `/desktop-build`, which reports the disk image actually sitting in
 *    `public/desktop/`. Development only, by design: in production `/desktop/`
 *    is nginx's static alias and Next cannot see what is in it.
 *
 * Both public download surfaces — the lander's hero and /download — hand out
 * the same file and both have to tell waiting apart from nothing, so the
 * question is asked in one place.
 */
export function useDesktopRelease(origin: string): DesktopReleaseState {
  const [release, setRelease] = useState<DesktopRelease | null>(null);
  const [local, setLocal] = useState<{ version: string; build: string } | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    // Each ask absorbs its own failure: a server that cannot answer has still
    // answered, as far as the button is concerned — and it must not take the
    // next source down with it, which is exactly the case on a development
    // machine with no API running behind the dev server.
    const ask = async (path: string): Promise<unknown> => {
      try {
        const response = await fetch(path, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    };

    void (async () => {
      const named = desktopReleaseFromPayload(await ask("/api/release"));
      if (named) {
        setRelease(named);
      } else {
        const built = localDesktopBuildFromPayload(await ask("/desktop-build"));
        if (built) setLocal({ version: built.version, build: built.build });
      }
      // An abort is this effect being torn down, not an answer.
      if (!controller.signal.aborted) setSettled(true);
    })();

    return () => controller.abort();
  }, []);

  const version = release?.version ?? local?.version ?? null;
  const platform: DesktopPlatform = "darwin-aarch64";
  return {
    release,
    settled,
    version,
    buildId: release?.tree ?? local?.build ?? null,
    url: version === null ? null : desktopDownloadUrl(origin, version, platform),
  };
}
