export const SECURITY_URL = "https://spawnd.dev/security";
export const DOWNLOAD_URL = "https://spawnd.dev/download";
export const SOURCE_URL = "https://github.com/levy-street/spawn";

export interface InstallCommands {
  standard: string;
  /**
   * Windows has no native daemon build, and `install.sh` is POSIX sh, so the
   * Linux build inside WSL2 is the path that works. Mobile never installs onto
   * the phone itself — the target is always another machine — so this is
   * offered outright rather than detected, unlike on the web.
   */
  windows: string;
  prebuiltOnly: string;
}

export function installCommandsForBaseUrl(baseUrl: string): InstallCommands {
  const origin = new URL(baseUrl).origin;
  const standard = `curl -fsSL ${origin}/install.sh | sh`;
  return {
    standard,
    windows: `wsl -- bash -c "${standard}"`,
    prebuiltOnly: `${standard} -s -- --prebuilt-only`,
  };
}
