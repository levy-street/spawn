import { describe, expect, test } from "bun:test";
import {
  DESKTOP_SHELL_TOKEN,
  detectOS,
  installCommand,
  installTargetForOS,
  installTargets,
  isDesktopShell,
  isMobileOS,
  storeBadgeForOS,
  storeBadges,
  windowsInstallCommand,
} from "./platform";

describe("install targets", () => {
  test("the unix line is unchanged and the windows line goes through WSL", () => {
    const origin = "https://spawnd.dev";
    expect(installCommand(origin)).toBe("curl -fsSL https://spawnd.dev/install.sh | sh");
    // There is no native Windows daemon, so the Windows tab must not hand over
    // a bare `sh` pipeline — Windows has no shell to run it in.
    expect(windowsInstallCommand(origin)).toBe(
      'wsl -- bash -c "curl -fsSL https://spawnd.dev/install.sh | sh"',
    );
  });

  test("every target carries a runnable command and a label", () => {
    const targets = installTargets("https://spawnd.dev");
    expect(targets.map((target) => target.id)).toEqual(["unix", "windows"]);
    for (const target of targets) {
      expect(target.label.length).toBeGreaterThan(0);
      expect(target.command).toContain("spawnd.dev/install.sh");
    }
    // The command is the whole payload — a tab carries no prose of its own.
    expect(targets.find((target) => target.id === "windows")?.command).toContain("wsl --");
    expect(targets.find((target) => target.id === "unix")?.command).not.toContain("wsl");
  });

  test("a detected OS picks its tab, and anything unidentified falls to unix", () => {
    expect(installTargetForOS("windows")).toBe("windows");
    expect(installTargetForOS("macos")).toBe("unix");
    expect(installTargetForOS("linux")).toBe("unix");
    // The installer detects the real host when it runs, so an unknown browser
    // OS is better served the line that works on both supported systems.
    expect(installTargetForOS("unknown")).toBe("unix");
  });

  test("a Windows browser lands on the Windows tab end to end", () => {
    const os = detectOS("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(os).toBe("windows");
    const targets = installTargets("https://spawnd.dev");
    const chosen = targets.find((target) => target.id === installTargetForOS(os));
    expect(chosen?.command).toContain("wsl --");
  });

  test("the command tracks the deployment origin, not a hardcoded host", () => {
    for (const target of installTargets("http://localhost:3000")) {
      expect(target.command).toContain("http://localhost:3000/install.sh");
      expect(target.command).not.toContain("spawnd.dev");
    }
  });
});

describe("phones", () => {
  test("an iPhone, an iPad and an Android are all recognised as phones", () => {
    expect(detectOS("iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(
      "ios",
    );
    expect(detectOS("Linux armv8l", "Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
    // Android's UA says "linux"; the phone check has to win.
    expect(isMobileOS(detectOS("Linux armv8l", "Mozilla/5.0 (Linux; Android 14)"))).toBe(true);
  });

  test("an iPad masquerading as a Mac is caught by its touch points", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15";
    // iPadOS 13+ reports MacIntel and a desktop UA; only touch separates them.
    expect(detectOS("MacIntel", ua, 5)).toBe("ios");
    expect(detectOS("MacIntel", ua, 0)).toBe("macos");
  });

  test("a real desktop is never mistaken for a phone", () => {
    expect(
      isMobileOS(detectOS("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")),
    ).toBe(false);
    expect(isMobileOS(detectOS("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"))).toBe(false);
    expect(isMobileOS(detectOS("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)"))).toBe(false);
  });

  test("a phone gets its own store badge and a desktop gets none", () => {
    expect(storeBadgeForOS("ios")?.label).toBe("App Store");
    expect(storeBadgeForOS("android")?.label).toBe("Google Play");
    expect(storeBadgeForOS("macos")).toBeNull();
    expect(storeBadgeForOS("unknown")).toBeNull();
  });

  test("badges stay linkless until a listing is actually published", () => {
    // Neither store resolves yet — eas.json holds an App Store Connect record
    // and an internal Play track, which are not public listings. A badge that
    // 404s on the lander is worse than one that says "coming soon".
    for (const badge of storeBadges()) {
      expect(badge.href).toBeNull();
      expect(badge.label.length).toBeGreaterThan(0);
    }
  });
});

describe("the desktop shell", () => {
  // The agent the macOS app actually sets (desktop/src-tauri/src/window.rs):
  // a WebKit agent with the product token last.
  const shellAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.6 Safari/605.1.15 SpawnDesktop/0.1.2";

  test("the app's own window is recognised, and a Mac browser is not", () => {
    expect(isDesktopShell(shellAgent)).toBe(true);
    expect(
      isDesktopShell(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/17.6 Safari/605.1.15",
      ),
    ).toBe(false);
    expect(isDesktopShell("")).toBe(false);
  });

  test("the shell still reads as the Mac it is", () => {
    // The token replaces nothing: the app is still a WebKit browser on macOS,
    // and every platform-sniffing surface has to keep working inside it.
    expect(detectOS("MacIntel", shellAgent)).toBe("macos");
  });

  test("the token is the one the app builds its agent from", () => {
    expect(shellAgent).toContain(DESKTOP_SHELL_TOKEN);
    expect(DESKTOP_SHELL_TOKEN.endsWith("/")).toBe(true);
  });
});
