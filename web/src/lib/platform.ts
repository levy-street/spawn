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
  origin: string;
  /** One-line daemon install for the current deployment origin. */
  installCommand: string;
  /** Variant that refuses the source-build fallback (deploy smoke tests). */
  prebuiltInstallCommand: string;
}

/** Used until the real origin is known (SSR render, tests). */
export const FALLBACK_ORIGIN = "https://spawnd.dev";

export type DesktopPlatform = "darwin-aarch64" | "darwin-x86_64";

export interface DesktopRelease {
  version: string;
  tree: string;
  platforms: DesktopPlatform[];
}

/** Strictly feature-detect the additive /api/release.desktop block. */
export function desktopReleaseFromPayload(payload: unknown): DesktopRelease | null {
  if (typeof payload !== "object" || payload === null) return null;
  const desktop = (payload as Record<string, unknown>).desktop;
  if (typeof desktop !== "object" || desktop === null) return null;
  const value = desktop as Record<string, unknown>;
  if (typeof value.version !== "string" || value.version.trim() === "") return null;
  if (typeof value.tree !== "string" || !/^[0-9a-f]{40}$/u.test(value.tree)) return null;
  if (!Array.isArray(value.platforms)) return null;
  const platforms = value.platforms.filter(
    (item): item is DesktopPlatform => item === "darwin-aarch64" || item === "darwin-x86_64",
  );
  if (platforms.length === 0 || platforms.length !== value.platforms.length) return null;
  return { version: value.version, tree: value.tree, platforms: [...new Set(platforms)] };
}

export function desktopDownloadUrl(
  origin: string,
  version: string,
  platform: DesktopPlatform,
): string {
  return `${origin.replace(/\/$/u, "")}/desktop/SPAWN-D_${encodeURIComponent(version)}_${platform}.dmg`;
}

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
  origin: FALLBACK_ORIGIN,
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
    origin,
    installCommand: installCommand(origin),
    prebuiltInstallCommand: prebuiltInstallCommand(origin),
  };
}
