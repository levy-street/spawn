#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROXY_TARGET = "http://127.0.0.1:8001";

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("Usage: node scripts/next-with-proxy-target.mjs <next-command> [...args]");
  process.exit(2);
}

// Rewrites are baked into .next/routes-manifest.json at build time, so a
// silent fallback here ships builds that proxy to a dead port (2026-07-15
// minivac login outage). Only `dev` may default; build/start must be explicit.
if (!process.env.SPAWN_API_PROXY_TARGET && command !== "dev") {
  console.error(
    `[spawn-web] SPAWN_API_PROXY_TARGET must be set for \`next ${command}\`: ` +
      "the proxy target is baked into the build, and defaulting would bake " +
      `${DEFAULT_PROXY_TARGET} into production assets.`,
  );
  process.exit(2);
}

const proxyTarget = process.env.SPAWN_API_PROXY_TARGET || DEFAULT_PROXY_TARGET;

try {
  const url = new URL(proxyTarget);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("target must use http or https");
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Invalid SPAWN_API_PROXY_TARGET=${JSON.stringify(proxyTarget)}: ${message}`);
  process.exit(2);
}

if (!process.env.SPAWN_API_PROXY_TARGET) {
  console.error(`[spawn-web] SPAWN_API_PROXY_TARGET not set; defaulting to ${proxyTarget}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const nextBin = path.join(scriptDir, "..", "node_modules", ".bin", "next");
const child = spawn(nextBin, [command, ...args], {
  env: { ...process.env, SPAWN_API_PROXY_TARGET: proxyTarget },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
