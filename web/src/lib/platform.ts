/**
 * Browser-side platform detection, install targets, and desktop artifacts.
 *
 * Shared by the public download surfaces and every connect-a-host gate so the
 * platform facts and one-liners each live in exactly one place.
 */

export type PlatformOS = "macos" | "linux" | "windows" | "ios" | "android" | "unknown";

export interface PlatformInfo {
  os: PlatformOS;
  origin: string;
  /** POSIX install line retained for older consumers. */
  installCommand: string;
  /** POSIX prebuilt-only line retained for deploy smoke tests. */
  prebuiltInstallCommand: string;
}

/** Used until the real origin is known (SSR render, tests). */
export const FALLBACK_ORIGIN = "https://spawnd.dev";

export const WINDOWS_DESKTOP_PLATFORM = "windows-x86_64" as const;

export type DesktopPlatform = "darwin-aarch64" | "darwin-x86_64" | typeof WINDOWS_DESKTOP_PLATFORM;

const DESKTOP_PLATFORMS = new Set<DesktopPlatform>([
  "darwin-aarch64",
  "darwin-x86_64",
  WINDOWS_DESKTOP_PLATFORM,
]);
const DESKTOP_ARTIFACT = new RegExp(
  `^SPAWN-D_(?<version>[^_/\\\\]+)_(?<platform>darwin-(?:aarch64|x86_64)|${WINDOWS_DESKTOP_PLATFORM})(?<suffix>\\.dmg|-setup\\.exe)$`,
  "u",
);

export interface DesktopRelease {
  version: string;
  tree: string;
  platforms: DesktopPlatform[];
}

export interface LocalDesktopBuild {
  version: string;
  platforms: DesktopPlatform[];
}

export function originWithoutTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/u, "");
}

function parseDesktopPlatforms(value: unknown): DesktopPlatform[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const platforms: DesktopPlatform[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !DESKTOP_PLATFORMS.has(item as DesktopPlatform)) return null;
    platforms.push(item as DesktopPlatform);
  }
  return [...new Set(platforms)];
}

/** Strictly feature-detect the additive /api/release.desktop block. */
export function desktopReleaseFromPayload(payload: unknown): DesktopRelease | null {
  if (typeof payload !== "object" || payload === null) return null;
  const desktop = (payload as Record<string, unknown>).desktop;
  if (typeof desktop !== "object" || desktop === null) return null;
  const value = desktop as Record<string, unknown>;
  if (typeof value.version !== "string" || value.version.trim() === "") return null;
  if (typeof value.tree !== "string" || !/^[0-9a-f]{40}$/u.test(value.tree)) return null;
  const platforms = parseDesktopPlatforms(value.platforms);
  return platforms ? { version: value.version, tree: value.tree, platforms } : null;
}

/** Parse the development route's deliberately smaller identity. */
export function localDesktopBuildFromPayload(payload: unknown): LocalDesktopBuild | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.version !== "string" || value.version.trim() === "") return null;
  const platforms = parseDesktopPlatforms(value.platforms);
  return platforms ? { version: value.version, platforms } : null;
}

/**
 * Native daemon setup is available only when the verified daemon manifest
 * names Windows. Desktop availability is deliberately independent: a
 * deployment may offer PowerShell setup before it publishes the companion EXE.
 */
export function nativeWindowsAvailableFromPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const daemon = (payload as Record<string, unknown>).daemon;
  if (typeof daemon !== "object" || daemon === null) return false;
  const targets = (daemon as Record<string, unknown>).targets;
  return (
    typeof targets === "object" &&
    targets !== null &&
    Object.hasOwn(targets, WINDOWS_DESKTOP_PLATFORM)
  );
}

/** The one filename rule used by public URLs and the local build route. */
export function desktopArtifactFilename(version: string, platform: DesktopPlatform): string {
  const stem = `SPAWN-D_${encodeURIComponent(version)}_${platform}`;
  return platform === WINDOWS_DESKTOP_PLATFORM ? `${stem}-setup.exe` : `${stem}.dmg`;
}

export function desktopDownloadUrl(
  origin: string,
  version: string,
  platform: DesktopPlatform,
): string {
  return `${originWithoutTrailingSlash(origin)}/desktop/${desktopArtifactFilename(version, platform)}`;
}

/** Strict inverse of desktopArtifactFilename for local artifact discovery. */
export function desktopArtifactFromFilename(
  filename: string,
): { version: string; platform: DesktopPlatform } | null {
  const match = DESKTOP_ARTIFACT.exec(filename);
  if (!match?.groups) return null;
  const platform = match.groups.platform as DesktopPlatform;
  let version: string;
  try {
    version = decodeURIComponent(match.groups.version);
  } catch {
    return null;
  }
  return desktopArtifactFilename(version, platform) === filename ? { version, platform } : null;
}

export function desktopPlatformForOS(os: PlatformOS): DesktopPlatform | null {
  if (os === "windows") return WINDOWS_DESKTOP_PLATFORM;
  if (os === "macos") return "darwin-aarch64";
  return null;
}

export function installCommand(origin: string): string {
  return `curl -fsSL ${originWithoutTrailingSlash(origin)}/install.sh | sh`;
}

export function prebuiltInstallCommand(origin: string): string {
  return `curl -fsSL ${originWithoutTrailingSlash(origin)}/install.sh | sh -s -- --prebuilt-only`;
}

/** The native PowerShell line. */
export function windowsInstallCommand(origin: string): string {
  return `irm ${originWithoutTrailingSlash(origin)}/install.ps1 | iex`;
}

/** The explicit WSL migration/fallback line. */
export function windowsWslInstallCommand(origin: string): string {
  return `wsl -- bash -c "curl -fsSL ${originWithoutTrailingSlash(origin)}/install.sh | sh"`;
}

function windowsWslPrebuiltInstallCommand(origin: string): string {
  return `wsl -- bash -c "curl -fsSL ${originWithoutTrailingSlash(origin)}/install.sh | sh -s -- --prebuilt-only"`;
}

export type InstallTargetId = "unix" | "windows" | "windows-wsl";

export interface InstallTarget {
  id: InstallTargetId;
  label: "macOS / Linux" | "Windows" | "Windows (WSL)";
  command: string;
  prebuiltCommand: string;
  prompt: "$" | "PS>";
}

/**
 * Install tabs in display order. Until release metadata proves the complete
 * Windows handoff, the immediate WSL-only stage remains the honest model.
 */
export function installTargets(origin: string, nativeWindowsAvailable = false): InstallTarget[] {
  const targets: InstallTarget[] = [
    {
      id: "unix",
      label: "macOS / Linux",
      command: installCommand(origin),
      prebuiltCommand: prebuiltInstallCommand(origin),
      prompt: "$",
    },
  ];
  if (nativeWindowsAvailable) {
    const command = windowsInstallCommand(origin);
    targets.push({
      id: "windows",
      label: "Windows",
      command,
      // The Windows installer only hands over a hosted build; there is no
      // source-build fallback or unconfirmed PowerShell parameter to invent.
      prebuiltCommand: command,
      prompt: "PS>",
    });
  }
  targets.push({
    id: "windows-wsl",
    label: "Windows (WSL)",
    command: windowsWslInstallCommand(origin),
    prebuiltCommand: windowsWslPrebuiltInstallCommand(origin),
    prompt: "PS>",
  });
  return targets;
}

/** Which tab a detected browser OS should land on. */
export function installTargetForOS(
  os: PlatformOS,
  nativeWindowsAvailable = false,
): InstallTargetId {
  if (os !== "windows") return "unix";
  return nativeWindowsAvailable ? "windows" : "windows-wsl";
}

/**
 * Pure OS classifier over `navigator.platform` + `navigator.userAgent`.
 * Phones are classified first because Android's UA contains "linux" and an
 * iPad may masquerade as a Mac.
 */
export function detectOS(platform: string, userAgent: string, maxTouchPoints = 0): PlatformOS {
  const ua = userAgent.toLowerCase();
  const plat = platform.toLowerCase();

  if (ua.includes("android")) return "android";
  if (/iphone|ipad|ipod/u.test(ua) || /iphone|ipad|ipod/u.test(plat)) return "ios";
  if ((plat.includes("mac") || ua.includes("mac os x")) && maxTouchPoints > 1) return "ios";

  if (plat.includes("mac") || ua.includes("mac os x")) return "macos";
  if (plat.includes("linux") || ua.includes("linux")) return "linux";
  if (plat.includes("win") || ua.includes("windows")) return "windows";
  return "unknown";
}

export function isMobileOS(os: PlatformOS): os is "ios" | "android" {
  return os === "ios" || os === "android";
}

export const APP_STORE_URL: string | null = null;
export const PLAY_STORE_URL: string | null = null;

export interface StoreBadge {
  id: "ios" | "android";
  label: string;
  href: string | null;
}

export function storeBadges(): StoreBadge[] {
  return [
    { id: "ios", label: "App Store", href: APP_STORE_URL },
    { id: "android", label: "Google Play", href: PLAY_STORE_URL },
  ];
}

export function storeBadgeForOS(os: PlatformOS): StoreBadge | null {
  if (!isMobileOS(os)) return null;
  return storeBadges().find((badge) => badge.id === os) ?? null;
}

export const UNDETECTED_PLATFORM: PlatformInfo = {
  os: "unknown",
  origin: FALLBACK_ORIGIN,
  installCommand: installCommand(FALLBACK_ORIGIN),
  prebuiltInstallCommand: prebuiltInstallCommand(FALLBACK_ORIGIN),
};

/** SSR-safe current-browser platform and same-origin install commands. */
export function detectPlatform(): PlatformInfo {
  if (typeof window === "undefined") return UNDETECTED_PLATFORM;
  const origin = window.location.origin;
  return {
    os: detectOS(
      window.navigator.platform,
      window.navigator.userAgent,
      window.navigator.maxTouchPoints,
    ),
    origin,
    installCommand: installCommand(origin),
    prebuiltInstallCommand: prebuiltInstallCommand(origin),
  };
}
