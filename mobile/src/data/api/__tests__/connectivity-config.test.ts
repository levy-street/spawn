import { normalizeServerUrl, resolveBaseUrl } from "@/data/api/config";

describe("normalizeServerUrl", () => {
  test.each([
    [" spawn.example.com/// ", "https://spawn.example.com"],
    ["//spawn.example.com/", "https://spawn.example.com"],
    ["localhost:8000", "https://localhost:8000"],
    ["http://192.168.1.20:8000/", "http://192.168.1.20:8000"],
    ["https://spawn.example.com/control///", "https://spawn.example.com/control"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  test.each([
    "",
    "not a valid host",
    "https:/spawn.example.com",
    "ftp://spawn.example.com",
    "https://user:password@spawn.example.com",
    "https://spawn.example.com?tenant=one",
    "https://spawn.example.com#settings",
  ])("rejects invalid input %s", (input) => {
    expect(() => normalizeServerUrl(input)).toThrow();
  });
});

describe("resolveBaseUrl", () => {
  const candidates = {
    runtimeOverride: "https://runtime.spawn.test",
    expoExtra: "https://extra.spawn.test",
    compiledDefault: "http://compiled.spawn.test",
  } as const;

  test("prefers the runtime override", () => {
    expect(resolveBaseUrl(candidates)).toEqual({
      url: "https://runtime.spawn.test",
      source: "runtime override",
    });
  });

  test("uses expo.extra when there is no override", () => {
    expect(resolveBaseUrl({ ...candidates, runtimeOverride: null })).toEqual({
      url: "https://extra.spawn.test",
      source: "expo.extra",
    });
  });

  test("uses the compiled default last", () => {
    expect(resolveBaseUrl({ ...candidates, runtimeOverride: null, expoExtra: undefined })).toEqual({
      url: "http://compiled.spawn.test",
      source: "compiled default",
    });
  });
});
