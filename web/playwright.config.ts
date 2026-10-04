import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.SPAWN_E2E_PORT ?? 3302);
const configuredBaseUrl = process.env.SPAWN_E2E_BASE_URL;
const baseURL = configuredBaseUrl ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // In CI, every route compiles before the first test (see the file).
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  // One retry absorbs render-timing flakes under parallel-worker load (the
  // scrollback reconciliation specs are rAF-sensitive); trace on-first-retry
  // below captures the evidence whenever a retry actually happens. Tracing
  // every first attempt would keep the failed one too, but it took the whole
  // suite from 4.9 to 8.7 minutes; pass --trace=retain-on-failure to chase one.
  retries: 1,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: configuredBaseUrl
    ? undefined
    : {
        command: `npm run dev -- -H 127.0.0.1 -p ${port}`,
        env: {
          ...process.env,
          SPAWN_API_PROXY_TARGET: "http://127.0.0.1:9",
          // Compiled routes stay compiled for the run (next.config.ts).
          SPAWN_E2E_KEEP_ROUTES: "1",
        },
        // In CI the dev server's own log (what it compiled, and how long
        // each request took) lands in the job log beside the tests waiting
        // on it.
        stdout: process.env.CI ? "pipe" : "ignore",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
