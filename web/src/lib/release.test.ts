import { describe, expect, test } from "bun:test";

import { HostSchema } from "./api";
import { clientBuildId, fetchRelease, ReleaseSchema, webIsStale } from "./release";

describe("ReleaseSchema", () => {
  test("defaults every absent release identity to an unknown value", () => {
    expect(ReleaseSchema.parse({})).toEqual({
      server: { commit: null, dirty: null },
      web: { build_id: null },
      daemon: null,
      mobile: { tree: null, runtime_version: null },
      protocols: { daemon: null, browser: null, alerts: null },
    });
  });

  test("accepts nullable nested fields and sparse daemon targets", () => {
    const release = ReleaseSchema.parse({
      server: null,
      web: { build_id: "server-build" },
      daemon: {
        version: null,
        tree: "daemon-tree",
        targets: {
          "darwin-aarch64": { spawnd_sha256: "abc" },
        },
      },
      mobile: null,
      protocols: { browser: "spawn.v3" },
    });

    expect(release.daemon?.commit).toBeNull();
    expect(release.daemon?.targets["darwin-aarch64"]?.spawn_worker_sha256).toBeNull();
    expect(release.protocols.browser).toBe("spawn.v3");
  });
});

describe("release identity IO", () => {
  test("fetches the public route without caching or auth-specific options", async () => {
    const originalFetch = globalThis.fetch;
    const observed: { request?: { input: string | URL | Request; init?: RequestInit } } = {};
    globalThis.fetch = (async (input, init) => {
      observed.request = { input, init };
      return new Response(JSON.stringify({ web: { build_id: "server-build" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const release = await fetchRelease();
      expect(release.web.build_id).toBe("server-build");
      expect(observed.request).toEqual({
        input: "/api/release",
        init: {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads and trims the build identity stamped by Next", () => {
    const original = process.env.NEXT_PUBLIC_SPAWN_BUILD_ID;
    try {
      process.env.NEXT_PUBLIC_SPAWN_BUILD_ID = "  client-build  ";
      expect(clientBuildId()).toBe("client-build");
      delete process.env.NEXT_PUBLIC_SPAWN_BUILD_ID;
      expect(clientBuildId()).toBeNull();
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_SPAWN_BUILD_ID;
      else process.env.NEXT_PUBLIC_SPAWN_BUILD_ID = original;
    }
  });
});

describe("HostSchema release fields", () => {
  test("defaults old host payloads to an unknown update state", () => {
    const host = HostSchema.parse({
      id: "11111111-2222-4333-8444-555555555555",
      name: "Mac",
      status: "online",
      last_seen_at: null,
      session_count: 0,
    });

    expect(host.daemon_tree).toBeNull();
    expect(host.update).toEqual({
      state: "unknown",
      latest_version: null,
      error: null,
      requested_at: null,
    });
  });

  test("normalises a nullable update object from a transitional server", () => {
    const host = HostSchema.parse({
      id: "11111111-2222-4333-8444-555555555555",
      name: "Mac",
      status: "online",
      last_seen_at: null,
      session_count: 0,
      daemon_tree: null,
      update: null,
    });

    expect(host.update.state).toBe("unknown");
  });
});

describe("webIsStale", () => {
  test("only reports a mismatch between two known production identities", () => {
    expect(webIsStale({ clientBuildId: "client", serverBuildId: "server" })).toBe(true);
    expect(webIsStale({ clientBuildId: "same", serverBuildId: "same" })).toBe(false);
  });

  test("stays quiet for missing, empty, and development identities", () => {
    expect(webIsStale({ clientBuildId: null, serverBuildId: "server" })).toBe(false);
    expect(webIsStale({ clientBuildId: "client", serverBuildId: null })).toBe(false);
    expect(webIsStale({ clientBuildId: " ", serverBuildId: "server" })).toBe(false);
    expect(webIsStale({ clientBuildId: "client", serverBuildId: " " })).toBe(false);
    expect(webIsStale({ clientBuildId: "spawn", serverBuildId: "server" })).toBe(false);
  });
});
