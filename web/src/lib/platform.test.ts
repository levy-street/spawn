import { describe, expect, test } from "bun:test";
import {
  desktopArtifactFilename,
  desktopArtifactFromFilename,
  desktopDownloadUrl,
  desktopPlatformForOS,
  desktopReleaseFromPayload,
  detectOS,
  installCommand,
  installTargetForOS,
  installTargets,
  isMobileOS,
  localDesktopBuildFromPayload,
  nativeWindowsAvailableFromPayload,
  storeBadgeForOS,
  storeBadges,
  WINDOWS_DESKTOP_PLATFORM,
  windowsInstallCommand,
  windowsWslInstallCommand,
} from "./platform";

const TREE = "a".repeat(40);

describe("install targets", () => {
  test("the immediate stage is explicit macOS/Linux plus Windows WSL", () => {
    const targets = installTargets("https://spawnd.dev/");
    expect(targets.map(({ id, label, prompt }) => ({ id, label, prompt }))).toEqual([
      { id: "unix", label: "macOS / Linux", prompt: "$" },
      { id: "windows-wsl", label: "Windows (WSL)", prompt: "PS>" },
    ]);
    expect(targets[0]?.command).toBe("curl -fsSL https://spawnd.dev/install.sh | sh");
    expect(targets[1]?.command).toBe(
      'wsl -- bash -c "curl -fsSL https://spawnd.dev/install.sh | sh"',
    );
    expect(installTargetForOS("windows")).toBe("windows-wsl");
  });

  test("the proven native stage inserts Windows and defaults Windows browsers to it", () => {
    const targets = installTargets("https://spawnd.dev///", true);
    expect(targets.map(({ id, label, prompt }) => ({ id, label, prompt }))).toEqual([
      { id: "unix", label: "macOS / Linux", prompt: "$" },
      { id: "windows", label: "Windows", prompt: "PS>" },
      { id: "windows-wsl", label: "Windows (WSL)", prompt: "PS>" },
    ]);
    expect(installTargetForOS("windows", true)).toBe("windows");
    expect(targets[1]?.command).toBe("irm https://spawnd.dev/install.ps1 | iex");
    expect(targets[2]?.command).toContain("wsl --");
  });

  test("every command uses the supplied origin with trailing slashes removed", () => {
    expect(installCommand("http://localhost:3000/")).toBe(
      "curl -fsSL http://localhost:3000/install.sh | sh",
    );
    expect(windowsInstallCommand("http://localhost:3000/")).toBe(
      "irm http://localhost:3000/install.ps1 | iex",
    );
    expect(windowsWslInstallCommand("http://localhost:3000/")).toBe(
      'wsl -- bash -c "curl -fsSL http://localhost:3000/install.sh | sh"',
    );
  });

  test("unknown and mobile browsers do not imply a phone can host", () => {
    expect(installTargetForOS("macos", true)).toBe("unix");
    expect(installTargetForOS("linux", true)).toBe("unix");
    expect(installTargetForOS("ios", true)).toBe("unix");
    expect(installTargetForOS("android", true)).toBe("unix");
    expect(installTargetForOS("unknown", true)).toBe("unix");
  });
});

describe("desktop artifacts", () => {
  test("uses exact platform-specific filenames and URLs", () => {
    expect(desktopArtifactFilename("0.2.0", "darwin-aarch64")).toBe(
      "SPAWN-D_0.2.0_darwin-aarch64.dmg",
    );
    expect(desktopArtifactFilename("0.2.0", WINDOWS_DESKTOP_PLATFORM)).toBe(
      "SPAWN-D_0.2.0_windows-x86_64-setup.exe",
    );
    expect(desktopDownloadUrl("https://spawnd.dev/", "0.2.0", WINDOWS_DESKTOP_PLATFORM)).toBe(
      "https://spawnd.dev/desktop/SPAWN-D_0.2.0_windows-x86_64-setup.exe",
    );
  });

  test("parses only filename/suffix combinations the URL generator creates", () => {
    expect(desktopArtifactFromFilename("SPAWN-D_0.2.0_windows-x86_64-setup.exe")).toEqual({
      version: "0.2.0",
      platform: WINDOWS_DESKTOP_PLATFORM,
    });
    expect(desktopArtifactFromFilename("SPAWN-D_0.2.0_darwin-aarch64.dmg")).toEqual({
      version: "0.2.0",
      platform: "darwin-aarch64",
    });
    expect(desktopArtifactFromFilename("SPAWN-D_0.2.0_windows-x86_64.dmg")).toBeNull();
    expect(desktopArtifactFromFilename("SPAWN-D_0.2.0_darwin-aarch64-setup.exe")).toBeNull();
  });

  test("release parsing accepts exact values, de-duplicates, and rejects mixed unknowns", () => {
    expect(
      desktopReleaseFromPayload({
        desktop: {
          version: "0.2.0",
          tree: TREE,
          platforms: ["darwin-aarch64", WINDOWS_DESKTOP_PLATFORM, WINDOWS_DESKTOP_PLATFORM],
        },
      }),
    ).toEqual({
      version: "0.2.0",
      tree: TREE,
      platforms: ["darwin-aarch64", WINDOWS_DESKTOP_PLATFORM],
    });
    expect(
      desktopReleaseFromPayload({
        desktop: {
          version: "0.2.0",
          tree: TREE,
          platforms: ["darwin-aarch64", "windows-arm64"],
        },
      }),
    ).toBeNull();
    expect(
      desktopReleaseFromPayload({ desktop: { version: "0.2.0", tree: TREE, platforms: [] } }),
    ).toBeNull();
  });

  test("local payload parsing needs a version and at least one exact platform", () => {
    expect(
      localDesktopBuildFromPayload({
        version: "0.2.0",
        platforms: ["darwin-x86_64", WINDOWS_DESKTOP_PLATFORM],
      }),
    ).toEqual({ version: "0.2.0", platforms: ["darwin-x86_64", WINDOWS_DESKTOP_PLATFORM] });
    expect(
      localDesktopBuildFromPayload({ version: "0.2.0", platforms: ["linux-x86_64"] }),
    ).toBeNull();
  });

  test("native setup follows the daemon artifact independently of the desktop EXE", () => {
    const payload = {
      desktop: { version: "0.2.0", tree: TREE, platforms: [WINDOWS_DESKTOP_PLATFORM] },
      daemon: { targets: { [WINDOWS_DESKTOP_PLATFORM]: {} } },
    };
    expect(nativeWindowsAvailableFromPayload(payload)).toBe(true);
    expect(nativeWindowsAvailableFromPayload({ ...payload, daemon: { targets: {} } })).toBe(false);
    expect(nativeWindowsAvailableFromPayload({ daemon: payload.daemon, desktop: null })).toBe(true);
    expect(nativeWindowsAvailableFromPayload({ desktop: payload.desktop, daemon: null })).toBe(
      false,
    );
  });

  test("browser OS maps only native desktop operating systems", () => {
    expect(desktopPlatformForOS("windows")).toBe(WINDOWS_DESKTOP_PLATFORM);
    expect(desktopPlatformForOS("macos")).toBe("darwin-aarch64");
    expect(desktopPlatformForOS("linux")).toBeNull();
    expect(desktopPlatformForOS("ios")).toBeNull();
    expect(desktopPlatformForOS("unknown")).toBeNull();
  });
});

describe("phones", () => {
  test("recognises iPhone, iPad and Android before desktop classifiers", () => {
    expect(detectOS("iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(
      "ios",
    );
    expect(detectOS("Linux armv8l", "Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
    const ipadUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15";
    expect(detectOS("MacIntel", ipadUA, 5)).toBe("ios");
    expect(detectOS("MacIntel", ipadUA, 0)).toBe("macos");
    expect(isMobileOS(detectOS("Win32", "Mozilla/5.0 (Windows NT 10.0)"))).toBe(false);
  });

  test("phone badges stay linkless until their listings are public", () => {
    expect(storeBadgeForOS("ios")?.label).toBe("App Store");
    expect(storeBadgeForOS("android")?.label).toBe("Google Play");
    expect(storeBadgeForOS("macos")).toBeNull();
    for (const badge of storeBadges()) expect(badge.href).toBeNull();
  });
});
