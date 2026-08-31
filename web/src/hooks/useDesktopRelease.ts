"use client";

import { useEffect, useState } from "react";
import {
  type DesktopPlatform,
  type DesktopRelease,
  desktopDownloadUrl,
  desktopReleaseFromPayload,
  localDesktopBuildFromPayload,
  nativeWindowsAvailableFromPayload,
} from "@/lib/platform";

export interface DesktopReleaseState {
  /** The signed manifest's desktop block, or null where this deployment ships none. */
  release: DesktopRelease | null;
  /** The exact platform this caller asked the deployment to hand over. */
  platform: DesktopPlatform | null;
  /** Whether discovery — including a development fallback — has settled. */
  settled: boolean;
  /** A URL only when the corresponding artifact was actually advertised. */
  url: string | null;
  /** The resolved artifact version, whichever source named it. */
  version: string | null;
  /** Release tree or local artifact digest, used to distinguish same-version rebuilds. */
  buildId: string | null;
  /** Whether verified release metadata proves the native Windows daemon exists. */
  nativeWindowsAvailable: boolean;
}

type ResolvedBuild = {
  version: string;
  platforms: DesktopPlatform[];
  /** Null when the release block advertises a fallback build with no tree. */
  buildId: string | null;
};

/**
 * The desktop build this deployment can prove for one requested platform.
 *
 * Two sources are asked in order of authority:
 *
 * 1. `/api/release`, whose desktop block carries the signed release identity.
 * 2. `/desktop-build`, which reports artifacts actually present under
 *    `public/desktop/` on a development checkout that cannot prove a clean
 *    release. Production never consults this route.
 *
 * A release response also independently proves whether native Windows daemon
 * setup is available. That fact must survive when the desktop EXE is absent.
 */
export function useDesktopRelease(
  origin: string,
  requestedPlatform: DesktopPlatform | null,
): DesktopReleaseState {
  const [release, setRelease] = useState<DesktopRelease | null>(null);
  const [resolvedBuild, setResolvedBuild] = useState<ResolvedBuild | null>(null);
  const [settled, setSettled] = useState(false);
  const [nativeWindowsAvailable, setNativeWindowsAvailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setResolvedBuild(null);
    setSettled(false);

    // Each source absorbs its own failure. A development server with no API
    // behind it may still have a freshly built companion in public/desktop/.
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
      const payload = await ask("/api/release");
      if (controller.signal.aborted) return;

      const manifestRelease = desktopReleaseFromPayload(payload);
      setRelease(manifestRelease);
      setNativeWindowsAvailable(nativeWindowsAvailableFromPayload(payload));

      let resolved: ResolvedBuild | null = manifestRelease
        ? {
            version: manifestRelease.version,
            platforms: manifestRelease.platforms,
            buildId: manifestRelease.tree,
          }
        : null;

      if (
        requestedPlatform !== null &&
        !manifestRelease?.platforms.includes(requestedPlatform) &&
        process.env.NODE_ENV !== "production"
      ) {
        const local = localDesktopBuildFromPayload(await ask("/desktop-build"));
        if (controller.signal.aborted) return;
        if (local?.platforms.includes(requestedPlatform)) {
          resolved = {
            version: local.version,
            platforms: local.platforms,
            buildId: local.build,
          };
        }
      }

      setResolvedBuild(resolved);
      setSettled(true);
    })();

    return () => controller.abort();
  }, [requestedPlatform]);

  const available =
    requestedPlatform !== null && resolvedBuild?.platforms.includes(requestedPlatform);
  return {
    release,
    platform: requestedPlatform,
    settled,
    url:
      available && requestedPlatform !== null && resolvedBuild
        ? desktopDownloadUrl(origin, resolvedBuild.version, requestedPlatform)
        : null,
    version: available && resolvedBuild ? resolvedBuild.version : null,
    buildId: available && resolvedBuild ? resolvedBuild.buildId : null,
    nativeWindowsAvailable,
  };
}
