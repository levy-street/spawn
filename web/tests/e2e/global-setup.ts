import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { FullConfig } from "@playwright/test";

/**
 * In CI, compiles every route of the app before the first test, on the dev
 * server the suite shares, which then keeps them all for the whole run
 * (`SPAWN_E2E_KEEP_ROUTES`, next.config.ts).
 *
 * `next dev` compiles a route the first time anyone asks for it, and drops a
 * route nobody has asked for in a minute — rebuilding the client bundle each
 * time — so on a busy runner a test paid for whatever its worker, or the
 * other worker, happened to reach first. CI run 37227122948 shows both:
 * - host-cockpit's Sessions click waited on the first compile of
 *   /hosts/[id]/sessions — 9.2 s, its request 10.3 s — past the 10 s its
 *   address expectation waits;
 * - onboarding's page was served just as the other worker's first visit
 *   compiled /reset-password, after which the server rebuilt once more
 *   without naming a route (the run's only such rebuild), and that page never
 *   left its server-rendered placeholder in 30 s — its retry, with nothing
 *   compiling, was ready in under 4 s.
 * Compiled here, once, no route a test visits compiles or is rebuilt while
 * the tests run.
 *
 * Locally a run usually reuses a dev server that is already warm, and paying
 * every route's first compile to run one spec is not worth it, so this does
 * nothing outside CI — nor against a server the suite did not start
 * (`SPAWN_E2E_BASE_URL`).
 */
export default async function warmEveryRoute(config: FullConfig) {
  if (!process.env.CI || process.env.SPAWN_E2E_BASE_URL) return;
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  // The app beside the config, as the dev server Playwright starts runs
  // there, not where Playwright itself was started (`-c web/...` from the
  // repository's root).
  const webDir = config.configFile ? dirname(config.configFile) : process.cwd();
  // The first proxied request that fails compiles the error page.
  const paths = ["/api/e2e-warm", ...appRoutes(join(webDir, "src", "app"))];
  for (const path of paths) {
    const started = Date.now();
    const response = await fetch(new URL(path, baseURL), {
      redirect: "manual",
      signal: AbortSignal.timeout(180_000),
    });
    await response.arrayBuffer();
    console.log(`warmed ${path} (${response.status}) in ${Date.now() - started} ms`);
  }
}

/** Every page and route handler under `src/app` (`page` or `route` with any
 *  of Next's default extensions, `.tsx`, `.ts`, `.jsx`, `.js`), a dynamic
 *  segment filled with a placeholder: any value compiles the route, which is
 *  all this is for. Metadata routes (`robots.ts`, `sitemap.ts`) are left
 *  cold: no test visits one. */
function appRoutes(appDir: string): string[] {
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^(page|route)\.[jt]sx?$/.test(entry.name)) {
        const segments = relative(appDir, dir)
          .split(sep)
          .filter((segment) => segment && !/^\(.*\)$/.test(segment))
          .map((segment) => (/^\[.*\]$/.test(segment) ? "e2e-warm" : segment));
        routes.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(appDir);
  return routes.sort();
}
