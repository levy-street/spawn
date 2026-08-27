import { describe, expect, test } from "bun:test";
import {
  formatHostArch,
  formatHostOS,
  formatHostPlatform,
  installCommandForHostOS,
} from "./host-platform";

describe("host platform presentation", () => {
  test.each([
    ["darwin", "macOS"],
    ["macos", "macOS"],
    ["LINUX", "Linux"],
    [" windows ", "Windows"],
    [null, "Unknown OS"],
    [" plan9 ", "plan9"],
  ])("formats OS %p", (value, expected) => {
    expect(formatHostOS(value)).toBe(expected);
  });

  test.each([
    ["aarch64", "ARM64"],
    ["arm64", "ARM64"],
    ["X86_64", "x64"],
    [" amd64 ", "x64"],
    [null, "Unknown architecture"],
    [" riscv64 ", "riscv64"],
  ])("formats architecture %p", (value, expected) => {
    expect(formatHostArch(value)).toBe(expected);
  });

  test("formats the shared Windows host line exactly", () => {
    expect(formatHostPlatform({ os: "windows", arch: "x86_64" })).toBe("Windows · x64");
    expect(formatHostPlatform({ os: null, arch: null })).toBe("Unknown OS");
  });
});

describe("host update recovery", () => {
  test("uses PowerShell for a Windows host regardless of the browser", () => {
    expect(installCommandForHostOS("WINDOWS", "https://spawnd.dev/")).toBe(
      "irm https://spawnd.dev/install.ps1 | iex",
    );
  });

  test("uses the POSIX installer for Linux, including WSL hosts", () => {
    expect(installCommandForHostOS("linux", "https://spawnd.dev/")).toBe(
      "curl -fsSL https://spawnd.dev/install.sh | sh",
    );
    expect(installCommandForHostOS(null, "https://spawnd.dev")).toBe(
      "curl -fsSL https://spawnd.dev/install.sh | sh",
    );
  });
});
