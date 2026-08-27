/**
 * Browser-side platform detection and daemon install commands.
 *
 * Shared by the download page, onboarding's connect-a-host step, and
 * Settings ▸ Hosts (`components/hosts/connect-host.tsx`) so the OS sniffing
 * and the install one-liner live in exactly one place.
 */

export type PlatformOS = "macos" | "linux" | "windows" | "ios" | "android" | "unknown";

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

export interface LocalDesktopBuild {
  version: string;
  platforms: DesktopPlatform[];
  /** A digest of the image itself — what tells two builds of one version apart. */
  build: string;
}

/**
 * The `/desktop-build` answer: a disk image sitting in `public/desktop/`,
 * reported by the development-only route of the same name. It carries no tree
 * because there is nothing to prove — it is a file on disk, not a release.
 */
export function localDesktopBuildFromPayload(payload: unknown): LocalDesktopBuild | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.version !== "string" || value.version.trim() === "") return null;
  if (!Array.isArray(value.platforms)) return null;
  const platforms = value.platforms.filter(
    (item): item is DesktopPlatform => item === "darwin-aarch64" || item === "darwin-x86_64",
  );
  if (platforms.length === 0) return null;
  if (typeof value.build !== "string" || value.build.trim() === "") return null;
  return { version: value.version, platforms: [...new Set(platforms)], build: value.build };
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

/**
 * The Windows line.
 *
 * There is no native Windows daemon: the installer's `SUPPORTED_TARGETS` is
 * darwin/linux only, `install.sh` is POSIX sh, and `spawnd` cannot even compile
 * for Windows while `nix` is an unconditional dependency. The Linux build under
 * WSL2 is the path that actually works, so that is what the Windows tab hands
 * over rather than a command that cannot run.
 */
export function windowsInstallCommand(origin: string): string {
  return `wsl -- bash -c "curl -fsSL ${origin}/install.sh | sh"`;
}

export type InstallTargetId = "unix" | "windows";

export interface InstallTarget {
  id: InstallTargetId;
  label: string;
  command: string;
}

/** The tabs behind the install chip, in display order. */
export function installTargets(origin: string): InstallTarget[] {
  return [
    { id: "unix", label: "macOS / Linux", command: installCommand(origin) },
    { id: "windows", label: "Windows", command: windowsInstallCommand(origin) },
  ];
}

/** Which tab a detected browser OS should land on. */
export function installTargetForOS(os: PlatformOS): InstallTargetId {
  return os === "windows" ? "windows" : "unix";
}

export function prebuiltInstallCommand(origin: string): string {
  return `curl -fsSL ${origin}/install.sh | sh -s -- --prebuilt-only`;
}

/**
 * Pure OS classifier over `navigator.platform` + `navigator.userAgent`.
 *
 * Phones are classified before desktops on purpose. Android's UA contains
 * "linux", and iPadOS Safari reports `MacIntel` — indistinguishable from a
 * desktop Mac except that it reports touch points, which is why
 * `maxTouchPoints` is taken as well.
 */
export function detectOS(platform: string, userAgent: string, maxTouchPoints = 0): PlatformOS {
  const ua = userAgent.toLowerCase();
  const plat = platform.toLowerCase();

  if (ua.includes("android")) return "android";
  if (/iphone|ipad|ipod/u.test(ua) || /iphone|ipad|ipod/u.test(plat)) return "ios";
  // An iPad on iPadOS 13+ masquerades as a Mac; only touch gives it away.
  if ((plat.includes("mac") || ua.includes("mac os x")) && maxTouchPoints > 1) return "ios";

  if (plat.includes("mac") || ua.includes("mac os x")) return "macos";
  if (plat.includes("linux") || ua.includes("linux")) return "linux";
  if (plat.includes("win") || ua.includes("windows")) return "windows";
  return "unknown";
}

/** The phones, where the daemon install line is meaningless. */
export function isMobileOS(os: PlatformOS): os is "ios" | "android" {
  return os === "ios" || os === "android";
}

/**
 * The token SPAWN D's macOS app puts on the end of its webview's user agent
 * (`desktop/src-tauri/src/window.rs`).
 */
export const DESKTOP_SHELL_TOKEN = "SpawnDesktop/";

/**
 * Whether this page is the desktop app's product face rather than a browser
 * tab.
 *
 * Inside that window the marketing site is a dead end: there is no address bar
 * and no way back, so a masthead, a colophon or a brand mark that goes to the
 * lander walks someone out of the app and leaves them there. Everything that
 * leads out is dropped when this is true.
 *
 * The agent carries the signal because it survives every navigation the
 * product makes — a query parameter does not — and because the app cannot
 * reach the page any other way: the product face is the web app, and it gets
 * no IPC.
 */
export function isDesktopShell(userAgent: string): boolean {
  return userAgent.includes(DESKTOP_SHELL_TOKEN);
}

/**
 * Public store listings.
 *
 * `mobile/eas.json` carries an App Store Connect id and an Android package,
 * but a Connect record is not a published listing — neither store resolves
 * yet. Keep these null until the listing is live: a badge that 404s on the
 * lander is worse than one that says it is coming. Filling them in is the
 * only change needed to turn the badges into links.
 */
export const APP_STORE_URL: string | null = null;
export const PLAY_STORE_URL: string | null = null;

export interface StoreBadge {
  id: "ios" | "android";
  label: string;
  /** Null until the listing is public; the badge then reads "Coming soon". */
  href: string | null;
}

export function storeBadges(): StoreBadge[] {
  return [
    { id: "ios", label: "App Store", href: APP_STORE_URL },
    { id: "android", label: "Google Play", href: PLAY_STORE_URL },
  ];
}

/** The badge matching a detected phone, or null on a desktop. */
export function storeBadgeForOS(os: PlatformOS): StoreBadge | null {
  if (!isMobileOS(os)) return null;
  return storeBadges().find((badge) => badge.id === os) ?? null;
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
