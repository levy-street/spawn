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
});
