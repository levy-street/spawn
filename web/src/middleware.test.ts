import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { middleware } from "./middleware";

/**
 * The admin host rewrite decides what `admin.spawnd.dev/x` actually serves.
 * Getting it wrong fails quietly — a rewritten favicon is a 404 nobody sees
 * until the tab is blank, and a rewritten manifest breaks installing the PWA
 * without any error at all.
 */
/** What the middleware decided: the path it rewrote to, or null to pass through. */
function rewrittenPath(url: string, host: string): string | null {
  const response = middleware(new NextRequest(url, { headers: { host } }));
  const target = response.headers.get("x-middleware-rewrite");
  return target === null ? null : new URL(target).pathname;
}

describe("admin host rewrite", () => {
  test("serves the admin app from the admin hostname", () => {
    expect(rewrittenPath("https://admin.spawnd.dev/", "admin.spawnd.dev")).toBe("/admin");
    expect(rewrittenPath("https://admin.spawnd.dev/users", "admin.spawnd.dev")).toBe(
      "/admin/users",
    );
  });

  test("leaves the product hostname alone", () => {
    expect(rewrittenPath("https://spawnd.dev/agents", "spawnd.dev")).toBeNull();
    expect(rewrittenPath("https://spawnd.dev/", "spawnd.dev")).toBeNull();
  });

  test.each([
    "/icon.svg",
    "/icon-192.png",
    "/icon-512.png",
    "/manifest.webmanifest",
    "/sw.js",
  ])("serves %s from the root on the admin host", (path) => {
    // These live in public/ and exist only at the root. Rewriting them under
    // /admin 404s them, which is how the admin tab ended up with no icon.
    expect(rewrittenPath(`https://admin.spawnd.dev${path}`, "admin.spawnd.dev")).toBeNull();
  });

  test("still passes the API and auth pages through", () => {
    for (const path of ["/api/admin/users", "/login", "/reset-password"]) {
      expect(rewrittenPath(`https://admin.spawnd.dev${path}`, "admin.spawnd.dev")).toBeNull();
    }
  });
});
