export const SECURITY_URL = "https://spawnd.dev/security";
export const DOWNLOAD_URL = "https://spawnd.dev/download";
export const SOURCE_URL = "https://github.com/levy-street/spawn";

export interface InstallCommands {
  standard: string;
  prebuiltOnly: string;
}

export function installCommandsForBaseUrl(baseUrl: string): InstallCommands {
  const origin = new URL(baseUrl).origin;
  const standard = `curl -fsSL ${origin}/install.sh | sh`;
  return {
    standard,
    prebuiltOnly: `${standard} -s -- --prebuilt-only`,
  };
}
