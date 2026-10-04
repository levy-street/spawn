import { offlineHost, onlineHost } from "@/components/hosts/__tests__/fixtures";
import {
  capacityLabel,
  capacityPresentation,
  formatBytes,
  formatDuration,
  formatHostArch,
  formatHostOS,
  formatHostPlatform,
  hostConnectionLabel,
  parseHostMetrics,
  possessedLabel,
  serverInstant,
} from "@/components/hosts/host-model";

describe("host presentation model", () => {
  test.each([
    ["darwin", "macOS"],
    ["macos", "macOS"],
    [" MACOS ", "macOS"],
    ["linux", "Linux"],
    ["windows", "Windows"],
    ["futureOS", "futureOS"],
    [" ", "Unknown OS"],
    [null, "Unknown OS"],
  ])("formats host OS %p as %s", (value, expected) => {
    expect(formatHostOS(value)).toBe(expected);
  });

  test.each([
    ["aarch64", "ARM64"],
    ["arm64", "ARM64"],
    ["x86_64", "x64"],
    ["AMD64", "x64"],
    ["riscv64", "riscv64"],
    [null, "Unknown architecture"],
  ])("formats host architecture %p as %s", (value, expected) => {
    expect(formatHostArch(value)).toBe(expected);
  });

  test("formats a Windows host consistently", () => {
    expect(formatHostPlatform({ os: "windows", arch: "x86_64" })).toBe("Windows · x64");
  });

  test("uses coarse server buckets until an exact direct sample exists", () => {
    expect(capacityPresentation(onlineHost, null)).toEqual({
      source: "bucketed",
      cpuSegments: 3,
      memorySegments: 2,
    });
    expect(capacityPresentation(offlineHost, null)).toEqual({ source: "unavailable" });
  });

  test("prefers exact direct metrics and never labels buckets as percentages", () => {
    const metrics = parseHostMetrics({
      sample: {
        cpu_percent: 47.4,
        memory_used_bytes: 4_294_967_296,
        memory_total_bytes: 8_589_934_592,
        load_one: 1.25,
        uptime_seconds: 90_000,
      },
      spec: {
        cpu_cores: 8,
        cpu_physical_cores: 4,
        memory_bytes: 8_589_934_592,
        gpu: null,
      },
    });
    expect(metrics).not.toBeNull();
    expect(capacityPresentation(onlineHost, metrics)).toMatchObject({
      source: "exact",
      cpuPercent: 47.4,
      memoryPercent: 50,
      loadOne: 1.25,
    });
    expect(capacityLabel(3)).toBe("Busy");
  });

  test("rejects malformed exact metrics", () => {
    expect(parseHostMetrics({ sample: { cpu_percent: 1 } })).toBeNull();
    expect(
      parseHostMetrics({
        sample: {
          cpu_percent: 1,
          memory_used_bytes: 1,
          memory_total_bytes: 0,
          uptime_seconds: 1,
        },
      }),
    ).toBeNull();
  });

  test("formats host facts without inventing precision", () => {
    expect(formatBytes(8_589_934_592)).toBe("8.0 GiB");
    expect(formatDuration(90_000)).toBe("1d 1h");
    expect(hostConnectionLabel(offlineHost, Date.parse("2026-08-22T00:02:00Z"))).toBe(
      "offline · last seen 2m ago",
    );
  });

  test("a server timestamp without a zone is UTC, as SQLite stores it", () => {
    // SQLite hands timestamps back without their zone. Read as this device's
    // local time, a host possessed late in the evening UTC would be dated a
    // day early east of Greenwich — and differ from the browser's date.
    expect(serverInstant("2026-09-14T23:30:00.123456")).toBe(Date.UTC(2026, 8, 14, 23, 30, 0, 123));
    expect(serverInstant("2026-09-14T23:30:00Z")).toBe(Date.UTC(2026, 8, 14, 23, 30));
    expect(serverInstant("2026-09-15T09:30:00+10:00")).toBe(Date.UTC(2026, 8, 14, 23, 30));
    expect(serverInstant("not a date")).toBeNull();
    expect(serverInstant(null)).toBeNull();
    expect(serverInstant(undefined)).toBeNull();
  });

  test("the possession date reads as the browser's does, on the day it was where you are", () => {
    const sydney = { locale: "en-US", timeZone: "Australia/Sydney" };
    expect(possessedLabel("2026-09-14T23:30:00.123456", sydney)).toBe(
      "Possessed September 15, 2026",
    );
    expect(possessedLabel("2026-09-14T23:30:00Z", sydney)).toBe("Possessed September 15, 2026");
    expect(possessedLabel("2026-09-14T23:30:00.123456", { locale: "en-US", timeZone: "UTC" })).toBe(
      "Possessed September 14, 2026",
    );
    expect(possessedLabel(null)).toBeNull();
    expect(possessedLabel("garbage")).toBeNull();
  });
});
