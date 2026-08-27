"use client";

import { useEffect, useState } from "react";
import { type DesktopRelease, desktopDownloadUrl, desktopReleaseFromPayload } from "@/lib/platform";

export interface DesktopReleaseState {
  /** The manifest's desktop block, or null where this deployment ships none. */
  release: DesktopRelease | null;
  /**
   * Whether `/api/release` has answered — including by failing. "We have not
   * asked yet" is not the same answer as "there is nothing to hand out", and a
   * download pressed during that window waits for the real one rather than
   * being sent somewhere else.
   */
  settled: boolean;
  /** The Apple Silicon build to hand over, once the manifest names it. */
  url: string | null;
}

/**
 * The Mac build this deployment publishes.
 *
 * Both public download surfaces — the lander's hero and /download — hand out
 * the same file and both have to tell waiting apart from nothing, so the
 * question is asked in one place.
 */
export function useDesktopRelease(origin: string): DesktopReleaseState {
  const [release, setRelease] = useState<DesktopRelease | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/release", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        setRelease(desktopReleaseFromPayload(payload));
        setSettled(true);
      })
      .catch(() => {
        // A server that cannot answer has still answered, as far as the button
        // is concerned: a spinner that never stops is worse than /download.
        // An abort has not — that is this effect being torn down.
        if (!controller.signal.aborted) setSettled(true);
      });
    return () => controller.abort();
  }, []);

  return {
    release,
    settled,
    url: release ? desktopDownloadUrl(origin, release.version, "darwin-aarch64") : null,
  };
}
