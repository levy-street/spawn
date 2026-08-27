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
  /** The platform this caller asked the deployment to hand over. */
  platform: DesktopPlatform | null;
  /** Whether release discovery (including a development fallback) has settled. */
  settled: boolean;
  /** A URL only when the corresponding artifact was actually advertised. */
  url: string | null;
  /** The verified Windows daemon artifact is present in release metadata. */
  nativeWindowsAvailable: boolean;
}

type ResolvedBuild = { version: string; platforms: DesktopPlatform[] };

/**
 * The desktop build this deployment can prove for one requested platform.
 *
 * Production trusts only `/api/release`. Development may use the local
 * `/desktop-build` inventory when the signed release does not contain the
 * requested artifact. Linux, phones, and the initial hydration-safe unknown
 * render request no desktop platform and therefore never receive a URL.
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
    setSettled(false);
    setResolvedBuild(null);

    const discover = async () => {
      try {
        const response = await fetch("/api/release", {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload: unknown = response.ok ? await response.json() : null;
        const manifestRelease = desktopReleaseFromPayload(payload);
        if (controller.signal.aborted) return;
        setRelease(manifestRelease);
        setNativeWindowsAvailable(nativeWindowsAvailableFromPayload(payload));

        if (
          requestedPlatform === null ||
          manifestRelease?.platforms.includes(requestedPlatform) ||
          process.env.NODE_ENV === "production"
        ) {
          setResolvedBuild(manifestRelease);
          setSettled(true);
          return;
        }

        const localResponse = await fetch("/desktop-build", {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const localPayload: unknown = localResponse.ok ? await localResponse.json() : null;
        if (controller.signal.aborted) return;
        const local = localDesktopBuildFromPayload(localPayload);
        setResolvedBuild(local?.platforms.includes(requestedPlatform) ? local : manifestRelease);
        setSettled(true);
      } catch {
        if (controller.signal.aborted) return;
        setRelease(null);
        setResolvedBuild(null);
        setNativeWindowsAvailable(false);
        setSettled(true);
      }
    };

    void discover();
    return () => controller.abort();
  }, [requestedPlatform]);

  const url =
    requestedPlatform !== null && resolvedBuild?.platforms.includes(requestedPlatform)
      ? desktopDownloadUrl(origin, resolvedBuild.version, requestedPlatform)
      : null;

  return {
    release,
    platform: requestedPlatform,
    settled,
    url,
    nativeWindowsAvailable,
  };
}
