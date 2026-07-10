import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.SPAWN_E2E_PORT ?? 3302);
const configuredBaseUrl = process.env.SPAWN_E2E_BASE_URL;
const baseURL = configuredBaseUrl ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  // One retry absorbs render-timing flakes under parallel-worker load (the
  // scrollback reconciliation specs are rAF-sensitive); trace on-first-retry
  // below captures the evidence whenever a retry actually happens.
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
        command: `SPAWN_API_PROXY_TARGET=http://127.0.0.1:9 bun run dev -- -H 127.0.0.1 -p ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
