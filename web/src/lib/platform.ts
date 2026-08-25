/**
 * Browser-side platform detection and daemon install commands.
 *
 * Shared by the download page, onboarding's connect-a-host step, and
 * Settings ▸ Hosts (`components/hosts/connect-host.tsx`) so the OS sniffing
 * and the install one-liner live in exactly one place.
 */

export type PlatformOS = "macos" | "linux" | "windows" | "unknown";

export interface PlatformInfo {
  os: PlatformOS;
  /** One-line daemon install for the current deployment origin. */
  installCommand: string;
  /** Variant that refuses the source-build fallback (deploy smoke tests). */
  prebuiltInstallCommand: string;
}

/** Used until the real origin is known (SSR render, tests). */
export const FALLBACK_ORIGIN = "https://spawnd.dev";

export function installCommand(origin: string): string {
  return `curl -fsSL ${origin}/install.sh | sh`;
}

/** Phase C attended setup: the claim routes the existing approval ceremony. */
export function setupInstallCommand(origin: string, token: string): string {
  return `curl -fsSL ${origin}/install.sh | sh -s -- --setup ${token}`;
}

export function prebuiltInstallCommand(origin: string): string {
  return `curl -fsSL ${origin}/install.sh | sh -s -- --prebuilt-only`;
}

/** Pure OS classifier over `navigator.platform` + `navigator.userAgent`. */
export function detectOS(platform: string, userAgent: string): PlatformOS {
  const ua = userAgent.toLowerCase();
  const plat = platform.toLowerCase();

  if (plat.includes("mac") || ua.includes("mac os x")) return "macos";
  if (plat.includes("linux") || ua.includes("linux")) return "linux";
  if (plat.includes("win") || ua.includes("windows")) return "windows";
  return "unknown";
}

/** What a server render (or a browser we can't identify) gets. */
export const UNDETECTED_PLATFORM: PlatformInfo = {
  os: "unknown",
  installCommand: installCommand(FALLBACK_ORIGIN),
  prebuiltInstallCommand: prebuiltInstallCommand(FALLBACK_ORIGIN),
};

/**
 * Detect the current browser's OS and build install commands against the
 * current origin. SSR-safe: without a `window` it returns
 * {@link UNDETECTED_PLATFORM}, so call it from an effect and keep the
 * fallback as initial state to stay hydration-consistent.
 */
export function detectPlatform(): PlatformInfo {
  if (typeof window === "undefined") return UNDETECTED_PLATFORM;
  const origin = window.location.origin;
  return {
    os: detectOS(window.navigator.platform, window.navigator.userAgent),
    installCommand: installCommand(origin),
    prebuiltInstallCommand: prebuiltInstallCommand(origin),
  };
}
