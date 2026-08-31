import { describe, expect, test } from "bun:test";

import { authConfigUrl } from "./billing-server";

describe("authConfigUrl", () => {
  test("builds the config URL from the rewrite's own target", () => {
    expect(authConfigUrl({ SPAWN_API_PROXY_TARGET: "http://127.0.0.1:8001" })).toBe(
      "http://127.0.0.1:8001/api/auth/config",
    );
  });

  test("keeps the target's host and drops any path it carries", () => {
    // The rewrite target is an origin; a trailing path on it is a
    // misconfiguration, not a prefix we should honour.
    expect(authConfigUrl({ SPAWN_API_PROXY_TARGET: "https://api.example/base" })).toBe(
      "https://api.example/api/auth/config",
    );
  });

  test("falls back to the dev cross-origin API URL only when the target is unset", () => {
    expect(
      authConfigUrl({
        SPAWN_API_PROXY_TARGET: "http://127.0.0.1:8001",
        NEXT_PUBLIC_SPAWN_API_URL: "http://localhost:8000",
      }),
    ).toBe("http://127.0.0.1:8001/api/auth/config");
    expect(authConfigUrl({ NEXT_PUBLIC_SPAWN_API_URL: "http://localhost:8000" })).toBe(
      "http://localhost:8000/api/auth/config",
    );
  });

  test("answers null when nothing names the API", () => {
    expect(authConfigUrl({})).toBeNull();
    expect(authConfigUrl({ SPAWN_API_PROXY_TARGET: "" })).toBeNull();
  });

  test("refuses a target that is not http(s)", () => {
    expect(authConfigUrl({ SPAWN_API_PROXY_TARGET: "not a url" })).toBeNull();
    expect(authConfigUrl({ SPAWN_API_PROXY_TARGET: "file:///etc/passwd" })).toBeNull();
  });
});
