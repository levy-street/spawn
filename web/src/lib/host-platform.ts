import { installCommand, windowsInstallCommand } from "@/lib/platform";

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function formatHostOS(value: string | null | undefined): string {
  const original = clean(value);
  if (original === null) return "Unknown OS";
  switch (original.toLowerCase()) {
    case "darwin":
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "windows":
      return "Windows";
    default:
      return original;
  }
}

export function formatHostArch(value: string | null | undefined): string {
  const original = clean(value);
  if (original === null) return "Unknown architecture";
  switch (original.toLowerCase()) {
    case "aarch64":
    case "arm64":
      return "ARM64";
    case "x86_64":
    case "amd64":
      return "x64";
    default:
      return original;
  }
}

export function formatHostPlatform(host: { os?: string | null; arch?: string | null }): string {
  const os = formatHostOS(host.os);
  return clean(host.arch) === null ? os : `${os} · ${formatHostArch(host.arch)}`;
}

/** Recovery follows the remote host, never the controlling browser. */
export function installCommandForHostOS(os: string | null | undefined, origin: string): string {
  return clean(os)?.toLowerCase() === "windows"
    ? windowsInstallCommand(origin)
    : installCommand(origin);
}
