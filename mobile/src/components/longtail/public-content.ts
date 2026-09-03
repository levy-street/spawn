export const SECURITY_URL = "https://spawnd.dev/security";
export const SOURCE_URL = "https://github.com/levy-street/spawn";
// Apple 5.1.1(i) requires the privacy policy to be reachable from INSIDE the
// app, not only from the store listing, and Google requires it on the listing.
// Without this link the app cannot be submitted to either store at all — which
// was true before billing existed and is simply overdue. docs/BILLING.md §5.2.
export const PRIVACY_URL = "https://spawnd.dev/privacy";
export const TERMS_URL = "https://spawnd.dev/terms";
// No DOWNLOAD_URL. The rule being applied is about a link's DESTINATION, not
// about the site it lands on: no in-app link may lead to a page that sells or
// prices anything (App Store guideline 3.1.1). Legal and informational pages
// stay — a privacy policy the app is required to link cannot also be a
// violation to link, and every company's site has pricing in its nav. The
// download page went for a plainer reason on top of that: every install
// command it carried is already on the About screen, so it only ever offered a
// longer road to the same text.

export const DEFAULT_INSTALL_ORIGIN = "https://spawnd.dev";
export const WINDOWS_PLATFORM_ID = "windows-x86_64";

export type InstallTargetId = "unix" | "windows" | "windows-wsl";

export interface InstallCommands {
  standard: string;
  windows: string;
  windowsWsl: string;
  prebuiltOnly: string;
  windowsWslPrebuiltOnly: string;
}

export interface InstallTarget {
  id: InstallTargetId;
  label: "macOS / Linux" | "Windows" | "Windows (WSL)";
  command: string;
  prompt: "$" | "PS>";
  commandAccessibilityLabel: "Terminal command" | "PowerShell command";
  stepHeading: "Open Terminal on your machine" | "Open PowerShell on your PC";
  stepDescription: string;
}

function originForBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

export function standardInstallCommand(origin: string): string {
  return `curl -fsSL ${originForBaseUrl(origin)}/install.sh | sh`;
}

export function windowsInstallCommand(origin: string): string {
  return `irm ${originForBaseUrl(origin)}/install.ps1 | iex`;
}

export function windowsWslInstallCommand(origin: string): string {
  return `wsl -- bash -c "curl -fsSL ${originForBaseUrl(origin)}/install.sh | sh"`;
}

export function windowsWslPrebuiltInstallCommand(origin: string): string {
  return `wsl -- bash -c "curl -fsSL ${originForBaseUrl(origin)}/install.sh | sh -s -- --prebuilt-only"`;
}

export function installCommandsForBaseUrl(baseUrl: string): InstallCommands {
  const standard = standardInstallCommand(baseUrl);
  return {
    standard,
    windows: windowsInstallCommand(baseUrl),
    windowsWsl: windowsWslInstallCommand(baseUrl),
    prebuiltOnly: `${standard} -s -- --prebuilt-only`,
    windowsWslPrebuiltOnly: windowsWslPrebuiltInstallCommand(baseUrl),
  };
}

export function installCommandForHostOS(
  baseUrl: string,
  hostOS: string | null | undefined,
): string {
  const commands = installCommandsForBaseUrl(baseUrl);
  return hostOS?.trim().toLocaleLowerCase() === "windows" ? commands.windows : commands.standard;
}

export function installTargetsForBaseUrl(
  baseUrl: string,
  nativeWindowsAvailable: boolean,
): InstallTarget[] {
  const commands = installCommandsForBaseUrl(baseUrl);
  const unix: InstallTarget = {
    id: "unix",
    label: "macOS / Linux",
    command: commands.standard,
    prompt: "$",
    commandAccessibilityLabel: "Terminal command",
    stepHeading: "Open Terminal on your machine",
    stepDescription: "On a Mac or Linux machine you control, open Terminal and run:",
  };
  const windows: InstallTarget = {
    id: "windows",
    label: "Windows",
    command: commands.windows,
    prompt: "PS>",
    commandAccessibilityLabel: "PowerShell command",
    stepHeading: "Open PowerShell on your PC",
    stepDescription: "On a Windows PC you control, open PowerShell and run:",
  };
  const windowsWsl: InstallTarget = {
    id: "windows-wsl",
    label: "Windows (WSL)",
    command: commands.windowsWsl,
    prompt: "PS>",
    commandAccessibilityLabel: "PowerShell command",
    stepHeading: "Open PowerShell on your PC",
    stepDescription: "On a Windows PC with WSL, open PowerShell and run:",
  };
  // WSL is the fallback it always was, not a second Windows. Offering both
  // asks a Windows user to know that one possesses their PC and the other
  // possesses a Linux environment inside it — a distinction the labels cannot
  // carry. Mirrors `installTargets` in web/src/lib/platform.ts.
  return nativeWindowsAvailable ? [unix, windows] : [unix, windowsWsl];
}

export function nativeWindowsAvailableFromRelease(
  release: { daemon?: { targets?: Readonly<Record<string, unknown>> } | null } | null | undefined,
): boolean {
  return release?.daemon?.targets?.[WINDOWS_PLATFORM_ID] !== undefined;
}

export const DEFAULT_INSTALL_COMMAND = standardInstallCommand(DEFAULT_INSTALL_ORIGIN);
export const DEFAULT_INSTALL_TARGETS = installTargetsForBaseUrl(DEFAULT_INSTALL_ORIGIN, false);
